import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Connection, PublicKey, Keypair, Transaction, TransactionInstruction, ComputeBudgetProgram, SystemProgram, SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync} from '@solana/spl-token';
import {SOL_BRIDGE, SOLANA_MAINNET_GENESIS, validateSolBridgeTransaction, buildExistingSolBridgePlan,
  readSolanaStrategyInventory, JITO_STRATEGY_POOL, JITO_STRATEGY_MINT, JITO_STRATEGY_PROGRAM, type SolBridgeDirection} from '../src/index.js';
import {info} from './receipt-fixture.js';
function bridgeFixture(direction: SolBridgeDirection) {
  const sender = Keypair.generate(), unique = Keypair.generate(), recipient = Keypair.generate().publicKey, route = SOL_BRIDGE[direction];
  const intent = {direction, sender: sender.publicKey, recipient, amount: 1000000n};
  const dispatched = PublicKey.findProgramAddressSync([Buffer.from('hyperlane'), Buffer.from('-'), Buffer.from('dispatched_message'), Buffer.from('-'), unique.publicKey.toBytes()], new PublicKey(route.mailbox))[0];
  const keys = route.fixed.map((key, i) => ({pubkey: key ? new PublicKey(key) : i === 6 ? sender.publicKey : i === 7 ? unique.publicKey : i === 8 ? dispatched :
    i === 16 ? getAssociatedTokenAddressSync(new PublicKey(SOL_BRIDGE.mint), sender.publicKey, false, TOKEN_2022_PROGRAM_ID) : Keypair.generate().publicKey,
    isSigner: i === 6 || i === 7, isWritable: [4,6,8,10,11,13,15,16].includes(i)}));
  const data = Buffer.alloc(77); data.fill(1, 0, 9); data.writeUInt32LE(route.destinationDomain, 9); recipient.toBuffer().copy(data, 13); data.writeBigUInt64LE(intent.amount, 45);
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({units: 1000000}),
    SystemProgram.transfer({fromPubkey: sender.publicKey, toPubkey: new PublicKey(SOL_BRIDGE.feeRecipient), lamports: route.fee}),
    new TransactionInstruction({programId: new PublicKey(route.router), keys, data}));
  tx.feePayer = sender.publicKey; tx.recentBlockhash = Keypair.generate().publicKey.toBase58(); tx.partialSign(unique);
  return {tx, unique: unique.publicKey, intent};
}
test('existing SOL adapter pins both route directions, exact fees, recipients, source accounts and partial message signature', async () => {
  for (const direction of ['cookie-to-solana', 'solana-to-cookie'] as const) {
    const f = bridgeFixture(direction), route = SOL_BRIDGE[direction];
    assert.equal(validateSolBridgeTransaction(f.tx, f.intent, f.unique).bridgeFee, route.fee);
    for (const mutation of ['amount', 'recipient', 'domain', 'fee', 'router', 'account', 'signature']) {
      const tx = Transaction.from(f.tx.serialize({requireAllSignatures:false, verifySignatures:false}));
      if (mutation === 'amount') tx.instructions[2]!.data[45]! ^= 1;
      if (mutation === 'recipient') tx.instructions[2]!.data[13]! ^= 1;
      if (mutation === 'domain') tx.instructions[2]!.data[9]! ^= 1;
      if (mutation === 'fee') tx.instructions[1]!.data[4]! ^= 1;
      if (mutation === 'router') tx.instructions[2]!.programId = SystemProgram.programId;
      if (mutation === 'account') tx.instructions[2]!.keys[2]!.pubkey = Keypair.generate().publicKey;
      if (mutation === 'signature') tx.signatures.find(s => s.publicKey.equals(f.unique))!.signature = null;
      assert.throws(() => validateSolBridgeTransaction(tx, f.intent, f.unique));
    }
    const connection = new Connection('http://localhost:8899'); connection.getGenesisHash = async () => route.genesis;
    connection.getMultipleAccountsInfo = async () => [{...info(Buffer.alloc(0), SystemProgram.programId), executable:true}, {...info(Buffer.alloc(0), SystemProgram.programId), executable:true}];
    connection.isBlockhashValid = async () => ({context:{slot:1}, value:true});
    const fetcher = (async (_url, options) => {const body = JSON.parse(options!.body as string); assert.equal(body.token, 'SOL'); assert.equal(body.amount, '0.001000000');
      return Response.json({token:'SOL', destinationDomain:route.destinationDomain, uniqueMessageAccount:f.unique.toBase58(), txBase64:f.tx.serialize({requireAllSignatures:false, verifySignatures:false}).toString('base64')});}) as typeof fetch;
    assert.equal((await buildExistingSolBridgePlan(connection, f.intent, fetcher)).amount, f.intent.amount);
    connection.getMultipleAccountsInfo = async () => [];
    await assert.rejects(buildExistingSolBridgePlan(connection, f.intent, fetcher), /program/);
    connection.getGenesisHash = async () => PublicKey.default.toBase58(); await assert.rejects(buildExistingSolBridgePlan(connection, f.intent, fetcher), /chain/);
  }
});
test('finalized Jito inventory separates staking claims, immediate cash and operator gas; wrong/stale custody fails', async () => {
  const owner = Keypair.generate().publicKey, connection = new Connection('http://localhost:8899');
  const pool = Buffer.alloc(611); pool[0] = 1; JITO_STRATEGY_MINT.toBuffer().copy(pool,162); TOKEN_PROGRAM_ID.toBuffer().copy(pool,226);
  pool.writeBigUInt64LE(1000n,258); pool.writeBigUInt64LE(500n,266); pool.writeBigUInt64LE(1n,274);
  const authority = PublicKey.findProgramAddressSync([JITO_STRATEGY_POOL.toBytes(),Buffer.from('withdraw')],JITO_STRATEGY_PROGRAM)[0];
  const mint = Buffer.alloc(82); mint.writeUInt32LE(1); authority.toBuffer().copy(mint,4); mint.writeBigUInt64LE(500n,36); mint[44]=9; mint[45]=1;
  const token = Buffer.alloc(165); JITO_STRATEGY_MINT.toBuffer().copy(token); owner.toBuffer().copy(token,32); token.writeBigUInt64LE(100n,64); token[108]=1;
  const clock = Buffer.alloc(40); clock.writeBigUInt64LE(1n,0); clock.writeBigUInt64LE(1n,16); clock.writeBigInt64LE(BigInt(Math.floor(Date.now()/1000)),32);
  const values = [{...info(Buffer.alloc(0),SystemProgram.programId),lamports:1000},info(token,TOKEN_PROGRAM_ID),info(pool,JITO_STRATEGY_PROGRAM),info(mint,TOKEN_PROGRAM_ID),info(clock,new PublicKey('Sysvar1111111111111111111111111111111111111'))];
  connection.getGenesisHash=async()=>SOLANA_MAINNET_GENESIS;
  connection.getMultipleAccountsInfoAndContext=async (_keys,options)=>{assert.equal((options as any).commitment,'finalized');return {context:{slot:1},value:values};};
  const result=await readSolanaStrategyInventory(connection,owner,100n);
  assert.equal(result.conservativeNav,'1100'); assert.equal(result.immediateCash,'900'); assert.equal(result.jitoNetRedemptionClaim,'200'); assert.equal(result.custodyPolicyVerified,false);
  clock.writeBigInt64LE(BigInt(Math.floor(Date.now()/1000)-121),32); await assert.rejects(readSolanaStrategyInventory(connection,owner,100n),/stale/);
  clock.writeBigInt64LE(BigInt(Math.floor(Date.now()/1000)),32); owner.toBuffer().copy(mint,4); await assert.rejects(readSolanaStrategyInventory(connection,owner,100n),/mint/);
  authority.toBuffer().copy(mint,4); token.writeUInt32LE(1,72); await assert.rejects(readSolanaStrategyInventory(connection,owner,100n),/custody/);
  token.writeUInt32LE(0,72); values[0]!.owner=JITO_STRATEGY_PROGRAM; await assert.rejects(readSolanaStrategyInventory(connection,owner,100n),/cash/);
});
