import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Program } from '@coral-xyz/anchor';
import BN from 'bn.js';
import { Connection, PublicKey, Keypair, SystemProgram, type AccountInfo } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, decodeTransferCheckedInstruction, ExtensionType } from '@solana/spl-token';
import idl from '../idl/aera.json' with { type: 'json' };
import { AERA_PROGRAM_ID, COOK_RESERVE_CONFIG, LAUNCH_CONFIG } from '../src/index.js';
import { RECEIPT_ASSETS, receiptIdentity, readReceiptPortfolio, quoteReceiptPayment, buildReceiptPayment,
  receiptPortfolioCsv, redeemableReceiptShares } from '../src/receipts.js';
import { buildMatchedExit, matchedExitTerms, createMatchedExitPacket, validateMatchedExitPacket, attachMatchedExitSignature } from '../src/matchedExit.js';
import { verifyReceiptInvoice } from '../src/receiptVerification.js';
import { globalPda, marketPda, obligationPda, liquidityVaultPda } from '../src/pda.js';

import { owner, recipient, info, receiptFixture } from './receipt-fixture.js';
test('receipt reader decodes the actual IDL, separates locked balances and uses mirrored supply after direct burns', async () => {
  const { connection, accounts, coder } = await receiptFixture();
  const a = receiptIdentity('abCOOK');
  const obligation = { market: marketPda(0), owner: owner.publicKey, lastUpdateSlot: new BN(1), stale: true, pricesStressed: false,
    depositedValue: new BN(0), effectiveCollateralValue: new BN(0), borrowedValue: new BN(0), allowedBorrowValue: new BN(0), unhealthyBorrowValue: new BN(0),
    deposits: [{ reserve: a.reserve, depositedShares: new BN(20), marketValue: new BN(20) }], borrows: [], bump: 1 };
  accounts.set(obligationPda(marketPda(0), owner.publicKey).toBase58(), info(await coder.encode('obligation', obligation), AERA_PROGRAM_ID));
  accounts.get(a.shareMint.toBase58())!.data.writeBigUInt64LE(999n, 36);
  const p = await readReceiptPortfolio(connection, owner.publicKey), r = p.receipts[1]!;
  assert.equal(r.unlockedShares, '100'); assert.equal(r.lockedShares, '20'); assert.equal(r.unlockedClaim, '100'); assert.equal(r.lockedClaim, '20');
  assert.equal(r.redeemableUnderlying, '100'); assert.equal(p.slot, '1');
});
test('wrong chain, Aera owner, mint authority, vault cash and token owner fail closed', async () => {
  for (const mutation of ['chain', 'reserve', 'authority', 'cash', 'wallet']) {
    const { connection, accounts } = await receiptFixture(), a = receiptIdentity('aCOOK');
    if (mutation === 'chain') connection.getGenesisHash = async () => PublicKey.default.toBase58();
    if (mutation === 'reserve') accounts.get(a.reserve.toBase58())!.owner = SystemProgram.programId;
    if (mutation === 'authority') owner.publicKey.toBuffer().copy(accounts.get(a.shareMint.toBase58())!.data, 4);
    if (mutation === 'cash') accounts.get(liquidityVaultPda(a.reserve).toBase58())!.data.writeBigUInt64LE(499n, 64);
    if (mutation === 'wallet') accounts.get(getAssociatedTokenAddressSync(a.shareMint, owner.publicKey, false, TOKEN_2022_PROGRAM_ID).toBase58())!.owner = TOKEN_PROGRAM_ID;
    await assert.rejects(readReceiptPortfolio(connection, owner.publicKey));
  }
});
test('pause affects available redemption, not ownership or book value', async () => {
  const { connection, accounts, coder, global } = await receiptFixture();
  accounts.set(globalPda().toBase58(), info(await coder.encode('global', { ...global, paused: true }), AERA_PROGRAM_ID));
  const p = await readReceiptPortfolio(connection, owner.publicKey);
  assert.equal(p.receipts[0]!.unlockedClaim, '100'); assert.equal(p.receipts[0]!.redeemableUnderlying, '0');
});
test('redemption maximum matches floor arithmetic exhaustively, excluding zero-output burns', () => {
  for (let total = 1n; total <= 30n; total++) for (let supply = 1n; supply <= 30n; supply++) for (let cash = 0n; cash <= 10n; cash++) {
    const result = redeemableReceiptShares(supply, total, supply, cash);
    assert.ok(result <= supply && result * total / supply <= cash);
    if (result > 0n) assert.ok(result * total / supply > 0n);
    if (result < supply && result > 0n) assert.ok((result + 1n) * total / supply > cash);
  }
});
test('payment quote enforces fresh snapshot, unlocked amount, invoice and exact Token-2022 transfer', async () => {
  const { connection } = await receiptFixture(), p = await readReceiptPortfolio(connection, owner.publicKey);
  const now = Date.now(), input = { symbol: 'aCOOK' as const, recipient: recipient.publicKey.toBase58(), shares: 50n, invoice: 'INV-001' };
  const q = quoteReceiptPayment(p, input, now), tx = await buildReceiptPayment(connection, q);
  assert.equal(q.serviceFeeShares, '0'); assert.equal(tx.instructions.length, 3);
  const transfer = decodeTransferCheckedInstruction(tx.instructions[2]!, TOKEN_2022_PROGRAM_ID);
  assert.equal(transfer.data.amount, 50n); assert.equal(transfer.keys.mint.pubkey.toBase58(), q.mint);
  for (const bad of [{ ...input, shares: 101n }, { ...input, shares: 0n }, { ...input, invoice: 'secret\nspoof' }, { ...input, recipient: p.owner }]) assert.throws(() => quoteReceiptPayment(p, bad));
  assert.throws(() => quoteReceiptPayment({ ...p, observedAt: 'invalid' }, input));
  assert.throws(() => quoteReceiptPayment(p, input, now + 61000));
  await assert.rejects(buildReceiptPayment(connection, { ...q, expiresAt: now - 1 }));
  await assert.rejects(buildReceiptPayment(connection, { ...q, mint: recipient.publicKey.toBase58() }));
});
test('whole-fill matched exit requires both signatures and never consumes reserve liquidity', async () => {
  const { connection } = await receiptFixture(), p = await readReceiptPortfolio(connection, owner.publicKey);
  const terms = matchedExitTerms(p, { buyer: recipient.publicKey.toBase58(), symbol: 'aCOOK', shares: 50n, paymentAmount: 45n, invoice: 'EXIT-1' });
  const { transaction } = await buildMatchedExit(connection, terms);
  assert.equal(transaction.compileMessage().header.numRequiredSignatures, 2);
  assert.ok(transaction.instructions.every(ix => !ix.programId.equals(AERA_PROGRAM_ID)));
  transaction.partialSign(owner);
  assert.equal(transaction.verifySignatures(), false);
  transaction.partialSign(recipient);
  assert.equal(transaction.verifySignatures(), true);
  await assert.rejects(buildMatchedExit(connection, { ...terms, paymentMint: recipient.publicKey.toBase58() }));
});
test('CSV keeps assets and base-unit precision separate', async () => {
  const { connection } = await receiptFixture(); const csv = receiptPortfolioCsv(await readReceiptPortfolio(connection, owner.publicKey));
  assert.match(csv, /available_redemption_base_units/); assert.match(csv, /"abCOOK"/); assert.equal(csv.split('\r\n').length, 5);
});
test('matched packets preserve seller authorization and reject altered instructions, parties and expiry', async () => {
  const {connection} = await receiptFixture(); connection.getBlockHeight = async () => 90;
  connection.isBlockhashValid = async () => ({context: {slot: 1}, value: true});
  const terms = matchedExitTerms(await readReceiptPortfolio(connection, owner.publicKey), {
    buyer: recipient.publicKey.toBase58(), symbol: 'aCOOK', shares: 50n, paymentAmount: 45n, invoice: 'EXIT-PACKET'});
  let packet = await createMatchedExitPacket(connection, terms);
  await assert.rejects(validateMatchedExitPacket(connection, packet, recipient.publicKey), /Seller/);
  const sellerTx = await validateMatchedExitPacket(connection, packet, owner.publicKey); sellerTx.partialSign(owner);
  packet = attachMatchedExitSignature(packet, sellerTx);
  const buyerTx = await validateMatchedExitPacket(connection, packet, recipient.publicKey); buyerTx.partialSign(recipient);
  assert.equal(buyerTx.verifySignatures(), true);
  await assert.rejects(validateMatchedExitPacket(connection, {...packet, terms: {...terms, paymentAmount: '44'}}, recipient.publicKey), /differs/);
  const mutated = await validateMatchedExitPacket(connection, packet, recipient.publicKey);
  mutated.add(SystemProgram.transfer({fromPubkey: recipient.publicKey, toPubkey: owner.publicKey, lamports: 100}));
  assert.throws(() => attachMatchedExitSignature(packet, mutated), /changed/);
  await assert.rejects(validateMatchedExitPacket(connection, packet, Keypair.generate().publicKey), /party/);
  connection.isBlockhashValid = async () => ({context: {slot: 1}, value: false});
  await assert.rejects(validateMatchedExitPacket(connection, packet, recipient.publicKey), /blockhash/);
});
test('matched SOL exits accept metadata-only mints but reject transfer extensions and substituted buyer accounts', async () => {
  const { connection, accounts } = await receiptFixture(), a = receiptIdentity('aSOL');
  const mint = Buffer.alloc(234); mint.writeUInt32LE(1); a.underlying.toBuffer().copy(mint, 4);
  mint.writeBigUInt64LE(1000n, 36); mint[44] = 9; mint[45] = 1; mint[165] = 1;
  mint.writeUInt16LE(ExtensionType.MetadataPointer, 166); mint.writeUInt16LE(64, 168);
  accounts.set(a.underlying.toBase58(), info(mint, TOKEN_2022_PROGRAM_ID));
  const ata = getAssociatedTokenAddressSync(a.underlying, recipient.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const token = Buffer.alloc(165); a.underlying.toBuffer().copy(token); recipient.publicKey.toBuffer().copy(token, 32);
  token.writeBigUInt64LE(100n, 64); token[108] = 1; accounts.set(ata.toBase58(), info(token, TOKEN_2022_PROGRAM_ID));
  const p = await readReceiptPortfolio(connection, owner.publicKey);
  const terms = matchedExitTerms(p, { buyer: recipient.publicKey.toBase58(), symbol: 'aSOL', shares: 50n, paymentAmount: 45n, invoice: 'EXIT-SOL' });
  assert.equal((await buildMatchedExit(connection, terms)).transaction.compileMessage().header.numRequiredSignatures, 2);
  mint.writeUInt16LE(ExtensionType.TransferFeeConfig, 166);
  await assert.rejects(buildMatchedExit(connection, terms), /extensions/);
  mint.writeUInt16LE(ExtensionType.MetadataPointer, 166); owner.publicKey.toBuffer().copy(token, 32);
  await assert.rejects(buildMatchedExit(connection, terms), /balance/);
});
test('merchant verification requires finalized exact transfer, memo, signer and recipient net credit', async () => {
  const { connection } = await receiptFixture(); const a = receiptIdentity('aCOOK');
  const source = getAssociatedTokenAddressSync(a.shareMint, owner.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const destination = getAssociatedTokenAddressSync(a.shareMint, recipient.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const expectation = { signature: '2'.repeat(88), payer: owner.publicKey.toBase58(), recipient: recipient.publicKey.toBase58(),
    symbol: 'aCOOK' as const, shares: 50n, decimals: 9, invoice: 'INV-1' };
  const tx = { slot: 5, meta: { err: null, innerInstructions: [], preTokenBalances: [], postTokenBalances: [{ accountIndex: 1,
    mint: a.shareMint.toBase58(), owner: recipient.publicKey.toBase58(), uiTokenAmount: { amount: '50', decimals: 9 } }] },
    transaction: { message: { accountKeys: [{ pubkey: owner.publicKey, signer: true }, { pubkey: destination, signer: false }], instructions: [
      { programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), parsed: 'aera:invoice:v1:INV-1' },
      { programId: TOKEN_2022_PROGRAM_ID, parsed: { type: 'transferChecked', info: { authority: owner.publicKey.toBase58(), source: source.toBase58(),
        destination: destination.toBase58(), mint: a.shareMint.toBase58(), tokenAmount: { amount: '50', decimals: 9 } } } },
    ] } } };
  connection.getParsedTransaction = (async (_signature: string, config: unknown) => { assert.equal((config as any).commitment, 'finalized'); return tx; }) as any;
  assert.equal((await verifyReceiptInvoice(connection, expectation)).shares, '50');
  for (const changed of [{ ...expectation, shares: 51n }, { ...expectation, invoice: 'INV-2' }, { ...expectation, symbol: 'aSOL' as const }, { ...expectation, payer: recipient.publicKey.toBase58() }]) await assert.rejects(verifyReceiptInvoice(connection, changed));
  tx.meta.postTokenBalances[0]!.uiTokenAmount.amount = '49'; await assert.rejects(verifyReceiptInvoice(connection, expectation), /net receipt/);
  tx.meta.postTokenBalances[0]!.uiTokenAmount.amount = '50'; tx.transaction.message.accountKeys[0]!.signer = false;
  await assert.rejects(verifyReceiptInvoice(connection, expectation), /payer/);
});
