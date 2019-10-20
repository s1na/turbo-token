import BN = require('bn.js')
import Account from 'ethereumjs-account'
import { keccak256, ecsign, stripZeros } from 'ethereumjs-util'
import { encode, decode } from 'rlp'
import { Multiproof, verifyMultiproof, makeMultiproof, flatEncodeInstructions } from '../multiproof'

import * as fs from 'fs'

const assert = require('assert')
const { promisify } = require('util')
const Wallet = require('ethereumjs-wallet')
const Trie = require('merkle-patricia-tree/secure')
const VM = require('ethereumjs-vm').default
const Transaction = require('ethereumjs-tx').Transaction


export interface TestSuite {
  preStateRoot: Buffer
  blockData: Buffer
  postStateRoot: Buffer
}

export interface RunnerArgs {
  stateless: boolean,
  fork: string,
  test: string,
  scout: string,
  dist: string,
  forkConfig: string,
  jsontrace: boolean,
  debug: boolean,
  data: string,
  gasLimit: number,
  value: number
}

export interface TestGetterArgs {
  test: string
}


interface SimulationData {
  from: Buffer
  to: Buffer
  value: BN
  nonce: BN
}

interface AccountInfo {
  address: Buffer
  privateKey: Buffer
  account: Account
}

export async function generateTestSuite(): Promise<TestSuite> {
  const trie = new Trie()
  // Generate random accounts
  const accounts = await generateAccounts(trie, 5000)

  const preStateRoot = trie.root

  // Generate txes
  const [txes, addrs, multiproof, simulationData] = await generateTxes(trie, accounts, 70)

  // Serialize witnesses and tx data
  const blockData = encode([txes, addrs, ...rawMultiproof(multiproof as Multiproof, true)])
  console.log(`block data length: ${blockData.length}`)

  // Apply txes on top of trie to compute post state root
  for (const tx of simulationData as SimulationData[]) {
    await transfer(trie, tx)
  }

  return {
    preStateRoot,
    blockData,
    postStateRoot: trie.root,
  }
}

async function generateTxes(trie: any, accounts: AccountInfo[], count = 50) {
  const txes = []
  const simulationData = []
  const root = trie.root
  const toProve: any = {}
  for (let i = 0; i < count; i++) {
    const from = accounts[i].address
    const to = accounts[i + 1].address
    const value = new BN('00000000000000000000000000000000000000000000000000000000000000ff', 16)
    const nonce = new BN('0000000000000000000000000000000000000000000000000000000000000000', 16)
    simulationData.push({ from, to, value, nonce })

    const fromAccount = await getAccount(trie, from)
    const fromKey = from.toString('hex')
    if (!toProve[fromKey]) {
      toProve[fromKey] = []
    }
    toProve[fromKey].push({ txId: i, fieldIdx: 3 })

    const toAccount = await getAccount(trie, to)
    const toKey = to.toString('hex')
    if (!toProve[toKey]) {
      toProve[toKey] = []
    }
    toProve[toKey].push({ txId: i, fieldIdx: 0 })

    const txRlp = encode([
      to,
      stripZeros(value.toBuffer('be', 32)),
      stripZeros(nonce.toBuffer('be', 32)),
    ])
    const txHash = keccak256(txRlp)
    const txSig = ecsign(txHash, accounts[i].privateKey)
    assert(txSig.r.byteLength === 32)
    assert(txSig.s.byteLength === 32)
    assert(txSig.v < 256)
    const v = new Uint8Array(1)
    v[0] = txSig.v
    const sigBytes = Buffer.concat([txSig.r, txSig.s, v], 65)

    txes.push([
      to,
      stripZeros(value.toBuffer('be', 32)),
      stripZeros(nonce.toBuffer('be', 32)),
      from,
    ])
    //txes.push([to, stripZeros(value.toBuffer('be', 32)), stripZeros(nonce.toBuffer('be', 32)), sigBytes])
    //txes.push([to, stripZeros(value.toBuffer('be', 32)), stripZeros(nonce.toBuffer('be', 32)), [stripZeros(txSig.r), stripZeros(txSig.s), txSig.v]])
    //txes.push([to, stripZeros(value.toBuffer('be', 32)), stripZeros(nonce.toBuffer('be', 32)), from])
  }
  // Make sure keys are unique and sort them
  const unsortedAddrs = Object.keys(toProve).map(s => Buffer.from(s, 'hex'))
  const keys = unsortedAddrs.map(a => keccak256(a))
  keys.sort(Buffer.compare)
  // Sort addresses based on their hashes.
  // Naive algorithm
  const sortedAddrs = new Array(keys.length).fill(undefined)
  for (const a of unsortedAddrs) {
    let idx = -1
    const h = keccak256(a)
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]
      if (h.equals(k)) {
        idx = i
      }
    }
    assert(idx >= 0)
    sortedAddrs[idx] = a
  }

  const proof = await makeMultiproof(trie, keys)
  // Verify proof is valid
  assert(await verifyMultiproof(root, proof, keys))

  // Modify txes and replace from and to addresses
  // with their index in the keys array
  for (let i = 0; i < sortedAddrs.length; i++) {
    const addr = sortedAddrs[i]
    const addrData = toProve[addr.toString('hex')]
    for (const instance of addrData) {
      txes[instance.txId][instance.fieldIdx] = i
    }
  }

  return [txes, sortedAddrs, proof, simulationData]
}

async function transfer(trie: any, tx: SimulationData) {
  const { from, to, value, nonce } = tx
  assert(value.gten(0))

  const fromAcc = await getAccount(trie, from)
  const toAcc = await getAccount(trie, to)

  assert(new BN(fromAcc.balance).gte(value))
  assert(new BN(fromAcc.nonce).eq(nonce))

  const newFromBalance = new BN(fromAcc.balance).sub(value)
  fromAcc.balance = newFromBalance.toBuffer()
  fromAcc.nonce = nonce.addn(1).toBuffer()
  const newToBalance = new BN(toAcc.balance).add(value)
  toAcc.balance = newToBalance.toBuffer()

  await putAccount(trie, from, fromAcc)
  await putAccount(trie, to, toAcc)
}

async function generateAccounts(trie: any, count = 500): Promise<AccountInfo[]> {
  const accounts = []
  for (let i = 0; i < count; i++) {
    const wallet = Wallet.generate()
    const address = wallet.getAddress()
    const privateKey = wallet.getPrivateKey()
    const account = new Account()
    account.balance = new BN('ffffff', 16).toBuffer()
    accounts.push({
      address,
      privateKey,
      account,
    })
    await putAccount(trie, address, account)
  }
  return accounts
}

export async function stateTestRunner(runnerArgs: RunnerArgs, test: any, testName: string): Promise<TestSuite> {
  const trie = new Trie()
  
  const [accounts, codeHashes, bytecode] = await getTestsAccounts(trie, test)

  const preStateRoot = trie.root
  const [txes, addrs, multiproof, simulationData, pks] = await getTestsTxes(trie, accounts, test)

  const blockData = encode([txes, addrs, codeHashes, bytecode, ...rawMultiproof(multiproof as Multiproof, true)])

  console.log(`[stateTestRunner] block data length: ${blockData.length}`)

  // Execute txes on top of trie to compute post state root
  let i = 0
  for (const tx of simulationData as SimulationData[]) {
    const pk = (pks as Buffer[])[0]
    await execute(trie, tx, pk)
    i++
  }

  return {
    preStateRoot,
    blockData,
    postStateRoot: trie.root,
  }
}

async function getTestsTxes(trie: any, accounts: AccountInfo[], test: any) {
  const txes = []
  const pks = []
  const simulationData = []
  const root = trie.root
  const toProve: any = {}

  const count = 10

  const from = accounts[1].address
  const to = accounts[0].address

  const value = new BN(test.transaction.value[0].substring(2), 16)
  const nonce = new BN(test.pre['0x' + from.toString('hex')].nonce.substring(2), 16)

  simulationData.push({ from, to, value, nonce })

  const fromAccount = await getAccount(trie, from)
  const fromKey = from.toString('hex')

  if (!toProve[fromKey]) {
    toProve[fromKey] = []
  }
  toProve[fromKey].push({ txId: 0, fieldIdx: 3 })

  const toAccount = await getAccount(trie, to)
  const toKey = to.toString('hex')

  if (!toProve[toKey]) {
    toProve[toKey] = []
  }
  
  toProve[toKey].push({ txId: 0, fieldIdx: 0 })

  const txRlp = encode([
    to,
    stripZeros(value.toBuffer('be', 32)),
    stripZeros(nonce.toBuffer('be', 32)),
  ])
  
  const txHash = keccak256(txRlp)

  const txSig = ecsign(txHash, accounts[1].privateKey)
  
  assert(txSig.r.byteLength === 32)
  assert(txSig.s.byteLength === 32)
  assert(txSig.v < 256)
  const v = new Uint8Array(1)
  v[0] = txSig.v
  const sigBytes = Buffer.concat([txSig.r, txSig.s, v], 65)
  
  txes.push([
    to,
    stripZeros(value.toBuffer('be', 32)),
    stripZeros(nonce.toBuffer('be', 32)),
    from,
  ])

  pks.push(accounts[1].privateKey)

  // Make sure keys are unique and sort them
  const unsortedAddrs = Object.keys(toProve).map(s => Buffer.from(s, 'hex'))
  const keys = unsortedAddrs.map(a => keccak256(a))
  keys.sort(Buffer.compare)
  
  // Sort addresses based on their hashes.
  // Naive algorithm
  const sortedAddrs = new Array(keys.length).fill(undefined)
  for (const a of unsortedAddrs) {
    let idx = -1
    const h = keccak256(a)
    
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]
      if (h.equals(k)) {
        idx = i
      }
    }
    assert(idx >= 0)
    sortedAddrs[idx] = a
  }

  const proof = await makeMultiproof(trie, keys)
  
  // Verify proof is valid
  assert(await verifyMultiproof(root, proof, keys))

  // Modify txes and replace from and to addresses
  // with their index in the keys array
  for (let i = 0; i < sortedAddrs.length; i++) {
    const addr = sortedAddrs[i]
    const addrData = toProve[addr.toString('hex')]
    for (const instance of addrData) {
      txes[instance.txId][instance.fieldIdx] = i
    }
  }

  return [txes, sortedAddrs, proof, simulationData, pks]
}

async function execute(trie: any, tx: SimulationData, pk: any) {
  const rawTx = {
    nonce: '0x' + tx.nonce.toString('hex'),
    gasLimit: "0x61a80",
    gasPrice: "0x1",
    value: '0x' + tx.value.toString('hex'),
    from: '0x' + tx.from.toString('hex'),
    to: '0x'+ tx.to.toString('hex'),
  }

  const vm = new VM({
    state: trie,
  })
  
  await runTx(vm, rawTx, pk)
}

async function runTx(vm: any, rawTx: any, pk: any) {
  const tx = new Transaction(rawTx)
  tx.sign(pk)
  
  const results = await vm.runTx({
    tx: tx,
  })

}

async function getTestsAccounts(trie: any, test: any): Promise<[AccountInfo[], Buffer[], Buffer[]]> {
  const accounts: AccountInfo[] = []
  const codeHashes: Buffer[] = []
  const bytecode: Buffer[] = []
  const privateKey = test.transaction.secretKey


  for (var address in test.pre) {
    let acct = test.pre[address]
    const code = Buffer.from(acct.code.substring(2), 'hex')
    const codeHash = keccak256(code)

    let acct_data = {
      nonce: acct.nonce,
      balance: acct.balance,
      codeHash: codeHash
    }
    
    const account = new Account(acct_data)

    let addr_buf = Buffer.from(address.substring(2), 'hex')
    accounts.push({
      address: addr_buf,
      privateKey: Buffer.from(privateKey.substring(2), 'hex'),
      account: account,
    })

    await putAccount(trie, addr_buf, account)
    
    await new Promise((resolve, reject) => {
      account.setCode(trie, code, (err: any, codeHash: Buffer) => {
        if (err) {
          console.log('ERROR: ', err)
          return reject(err)
        }
        codeHashes.push(codeHash)
        bytecode.push(code)
        resolve(codeHash)
      })
    })
  }

  return [accounts, codeHashes, bytecode]
}

async function putAccount(trie: any, address: Buffer, account: Account) {
  await promisify(trie.put.bind(trie))(address, account.serialize())
}

async function getAccount(trie: any, address: Buffer): Promise<Account> {
  const raw = await promisify(trie.get.bind(trie))(address)
  if (!raw) {
    return new Account()
  } else {
    return new Account(raw)
  }
}

function rawMultiproof(proof: Multiproof, flatInstructions: boolean = false): any {
  let keys = []
  let values = []
  for (const kv of proof.keyvals) {
    const raw = decode(kv)
    keys.push(raw[0])
    values.push(raw[1])
  }
  if (flatInstructions) {
    // TODO: What is this for?
    for (let k = 0; k < keys.length; k++) {
    }

    for (let v = 0; v < values.length; v++) {
      console.log(`[rawMultiproof] value: ${JSON.stringify(values[v])}`)
    }
    return [proof.hashes, keys, values, flatEncodeInstructions(proof.instructions)]
  } else {
    return [
      proof.hashes,
      keys,
      values,
      proof.instructions.map(i => {
        if (i.value !== undefined) return [i.kind, i.value]
        return [i.kind]
      }),
    ]
  }
}
