import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Program } from '@coral-xyz/anchor';
import BN from 'bn.js';
import { SystemProgram, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import idl from '../idl/yield_escrow.json' with { type: 'json' };
import { YIELD_ESCROW_PROGRAM_ID, yieldEscrowAddress, buildOpenYieldEscrow, readYieldEscrow,
  buildCancelYieldEscrow, buildSettleYieldEscrow, buildRecoverEscrowLiquidity, receiptIdentity, AERA_PROGRAM_ID } from '../src/index.js';
import { receiptFixture, owner, recipient, info } from './receipt-fixture.js';
test('escrow builders use generated IDL, exact immutable terms, canonical accounts and accrued reserves', async () => {
  const { connection, accounts } = await receiptFixture();
  accounts.set(YIELD_ESCROW_PROGRAM_ID.toBase58(), {...info(Buffer.alloc(0), SystemProgram.programId), executable: true});
  const a = receiptIdentity('aCOOK'), mint = Buffer.alloc(82); mint[44] = 9; mint[45] = 1;
  accounts.set(a.underlying.toBase58(), info(mint, TOKEN_PROGRAM_ID));
  const p = new Program(idl as never, {connection} as never);
  const expiry = Math.floor(Date.now() / 1000) + 86400;
  const input = {symbol: 'aCOOK' as const, merchant: recipient.publicKey, nonce: 1n, shares: 50n, expiry, maxPayment: 10n};
  const result = await buildOpenYieldEscrow(connection, owner.publicKey, input);
  assert.equal(result.principalPreview, 50n); assert.equal(result.transaction.instructions.length, 2);
  assert.ok(result.transaction.instructions[0]!.programId.equals(AERA_PROGRAM_ID));
  const open = (p.coder.instruction as any).decode(result.transaction.instructions[1]!.data);
  assert.equal(open.name, 'open'); assert.equal(open.data.maxPayment.toString(), '10');
  assert.ok(result.transaction.instructions[1]!.keys.find(k => k.pubkey.equals(recipient.publicKey) && !k.isSigner));
  accounts.set(result.address.toBase58(), info(await p.coder.accounts.encode('yieldEscrow', {
    owner: owner.publicKey, merchant: recipient.publicKey, reserve: a.reserve, shareMint: a.shareMint,
    principal: new BN(50), maxPayment: new BN(10), paid: new BN(0), entitledShares: new BN(50), expiry: new BN(expiry), nonce: new BN(1), bump: 1, closed: false,
  }), YIELD_ESCROW_PROGRAM_ID));
  assert.equal((await readYieldEscrow(connection, result.address)).principal, '50');
  const cancel = await buildCancelYieldEscrow(connection, owner.publicKey, result.address);
  assert.equal((p.coder.instruction as any).decode(cancel.instructions[1]!.data).name, 'cancel');
  const settle = await buildSettleYieldEscrow(connection, recipient.publicKey, result.address);
  assert.ok(settle.instructions.at(-2)!.programId.equals(AERA_PROGRAM_ID));
  assert.equal((p.coder.instruction as any).decode(settle.instructions.at(-1)!.data).name, 'settle');
  assert.equal((p.coder.instruction as any).decode((await buildRecoverEscrowLiquidity(connection, owner.publicKey, result.address)).instructions[1]!.data).name, 'recoverLiquidity');
  await assert.rejects(buildCancelYieldEscrow(connection, recipient.publicKey, result.address), /owner/);
  await assert.rejects(buildOpenYieldEscrow(connection, owner.publicKey, input), /nonce/);
  await assert.rejects(buildOpenYieldEscrow(connection, owner.publicKey, {...input, shares: 101n}), /unlocked/);
  await assert.rejects(buildOpenYieldEscrow(connection, owner.publicKey, {...input, merchant: owner.publicKey}), /terms/);
  accounts.get(result.address.toBase58())!.owner = SystemProgram.programId;
  await assert.rejects(readYieldEscrow(connection, result.address));
  assert.throws(() => yieldEscrowAddress(owner.publicKey, -1n));
  assert.throws(() => yieldEscrowAddress(owner.publicKey, 1n << 64n));
  assert.notEqual(yieldEscrowAddress(owner.publicKey, 1n).toBase58(), yieldEscrowAddress(owner.publicKey, 2n).toBase58());
  connection.getGenesisHash = async () => PublicKey.default.toBase58();
  await assert.rejects(buildOpenYieldEscrow(connection, owner.publicKey, input), /chain/);
});
