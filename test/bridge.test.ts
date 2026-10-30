import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import {
  BRIDGE_MAX_LAMPORTS, BRIDGE_MIN_LAMPORTS, SOL_BRIDGE, SOL_COOKIE_BRIDGE, assertSolToCookieTransaction, ataPayerPda, ataPayerShortfall,
  bridgeAmountProblem, bridgedSolAta, buildSolToCookieTransaction, cookieWarpConfigProblems, decodeHyperlaneToken, decodeTransferRemote,
  dispatchAuthorityPda, dispatchedMessagePda, encodeTransferRemote, formatLamports, gasPaymentPda, hyperlaneTokenPda, igpProgramDataPda,
  mailboxOutboxPda, messageIdFromLogs, nativeCollateralPda, overheadIgpInner, processedMessagePda, readBridgeDelivery, readCookieArrival,
  solToCookieTransferIx, solanaWarpConfigProblems, syntheticMintPda,
} from '../src/index.js';

const R = SOL_COOKIE_BRIDGE;
const key = (s: string) => new PublicKey(s);

/**
 * A real SOL → Cookie transfer on Solana mainnet, read on 2026-10-13:
 * 4DaTpP5z7BQAnzLzddwktD1MpA9ZBwNS8MK9UWGzzoUp9pzq8iMYYAEhUxzVfcZNXWG9qrVZ2HjcavyMTvTunVKy (slot 451006122),
 * 0.013 SOL to the sender's own address, delivered on Cookie Chain (its processed-message PDA exists there).
 */
const REAL = {
  sender: 'FtF6XVRPpud9L6HMmH9qvUAAUdFKGQQ1uD5KJYbn9x64',
  unique: 'EeV3nnQx45cb9Jg7utM97UTNLqLoKNfVngDEpRXTA57X',
  accounts: [
    '11111111111111111111111111111111', 'noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV', '3nHqTGhJXQ49PfsTtnn4yqyyVmQvWbzJ2rHmMTihvUnn',
    'E588QtVUvresuXq2KoNEwAmoifCzYGpRBdHByN9KQMbi', 'BvZpTuYLAR77mPhH4GtvwEWUTs53GQqkgBNuXpCePVNk', '9M1ircvTk5iqPmz3WFNxusSTin64F41Z84Bj8t1zmigu',
    'FtF6XVRPpud9L6HMmH9qvUAAUdFKGQQ1uD5KJYbn9x64', 'EeV3nnQx45cb9Jg7utM97UTNLqLoKNfVngDEpRXTA57X', '9YCW5dkmeBi1suEZr5ud8ent3g7AYgybqXDpCHEQG8dV',
    'BhNcatUDC2D5JTyeaqrdSukiVFsEHK7e3hVmKMztwefv', '8Cv4PHJ6Cf3xY7dse7wYeZKtuQv9SAN6ujt5w22a2uho', 'FUzEFWnWxWWwfkQiiLCgc4R8F7E5aQzBLFKsXbr2dNRn',
    'Dg5FAhqNaRfQPc3HwW9fXr7Bj4nrnszoQspoSLgysqfY', '3RbtjzzdhmthkQ1akmbe41SbGXS3e96AqupPt6VtxHEe', '11111111111111111111111111111111',
    'ADLE5sXddiFWpAfExBqjoHNfG8ALRJEhDAtLd5wd6eXe',
  ],
  data: '01010101010101010114550919dd242d018d7688468a3597969180e868a7d7fefc4b2d9fc281fd2fe3c065ce71405dc60000000000000000000000000000000000000000000000000000000000',
  lamports: 13_000_000n,
  messageId: '0xccee1275cb068c9514e3544d9bffa19bdad239c16e55cd6b9e5f57bf737f2855',
  processed: 'GrbQmCj5dnJDoUvzmWwxNnJtdNXDrfUowznHcvPjxnFE',
  logs: [
    'Program log: Protocol fee of 0 paid from FtF6XVRPpud9L6HMmH9qvUAAUdFKGQQ1uD5KJYbn9x64 to BvZpTuYLAR77mPhH4GtvwEWUTs53GQqkgBNuXpCePVNk',
    'Program log: Dispatched message to 420042004, ID 0xccee1275cb068c9514e3544d9bffa19bdad239c16e55cd6b9e5f57bf737f2855',
    'Program log: Paid IGP 3RbtjzzdhmthkQ1akmbe41SbGXS3e96AqupPt6VtxHEe for 132000 gas for message 0xccee…2855 to 420042004',
  ],
};

test('route PDAs derive to the accounts found on Solana and Cookie Chain', () => {
  assert.equal(hyperlaneTokenPda(R.solana.warp).toBase58(), '3nHqTGhJXQ49PfsTtnn4yqyyVmQvWbzJ2rHmMTihvUnn');
  assert.equal(mailboxOutboxPda(R.solana.mailbox).toBase58(), 'BvZpTuYLAR77mPhH4GtvwEWUTs53GQqkgBNuXpCePVNk');
  assert.equal(dispatchAuthorityPda(R.solana.warp).toBase58(), '9M1ircvTk5iqPmz3WFNxusSTin64F41Z84Bj8t1zmigu');
  assert.equal(igpProgramDataPda(R.solana.igpProgram).toBase58(), '8Cv4PHJ6Cf3xY7dse7wYeZKtuQv9SAN6ujt5w22a2uho');
  assert.equal(nativeCollateralPda(R.solana.warp).toBase58(), 'ADLE5sXddiFWpAfExBqjoHNfG8ALRJEhDAtLd5wd6eXe');
  assert.equal(hyperlaneTokenPda(R.cookie.warp).toBase58(), '7JXU2QwmoKaxScJxA4pjjQb5jjey2x9cAUCRPrzFDgL6');
  assert.equal(syntheticMintPda(R.cookie.warp).toBase58(), R.cookie.mint.toBase58());
  assert.equal(ataPayerPda(R.cookie.warp).toBase58(), 'GjrajPeUSF7B6h1YEt9L7qJuLCLutvx8e9U3hXYf3CPS');
  // Per-transfer PDAs, from the real transfer's unique-message signer.
  assert.equal(dispatchedMessagePda(R.solana.mailbox, key(REAL.unique)).toBase58(), '9YCW5dkmeBi1suEZr5ud8ent3g7AYgybqXDpCHEQG8dV');
  assert.equal(gasPaymentPda(R.solana.igpProgram, key(REAL.unique)).toBase58(), 'FUzEFWnWxWWwfkQiiLCgc4R8F7E5aQzBLFKsXbr2dNRn');
  assert.equal(processedMessagePda(R.cookie.mailbox, REAL.messageId).toBase58(), REAL.processed);
  assert.equal(processedMessagePda(R.cookie.mailbox, REAL.messageId.slice(2)).toBase58(), REAL.processed);
});

test('the transfer instruction is byte-for-byte the real mainnet transfer', () => {
  const ix = solToCookieTransferIx({ sender: key(REAL.sender), uniqueMessage: key(REAL.unique), lamports: REAL.lamports });
  assert.equal(ix.programId.toBase58(), 'DWxkDF63gF5pMoAiACjkkYgr4onz4WPZi9wq59gctU6T');
  assert.deepEqual(ix.keys.map((k) => k.pubkey.toBase58()), REAL.accounts);
  assert.equal(ix.data.toString('hex'), REAL.data);
  // Signers: the sender and the one-off unique-message account; nothing else.
  assert.deepEqual(ix.keys.flatMap((k, i) => (k.isSigner ? [i] : [])), [6, 7]);
  assert.deepEqual(ix.keys.flatMap((k, i) => (k.isWritable ? [i] : [])), [4, 6, 8, 10, 11, 13, 15]);
  // And it agrees with the account list Cookiescan's build-tx produces for the same route.
  SOL_BRIDGE['solana-to-cookie'].fixed.forEach((expected, i) => { if (expected) assert.equal(ix.keys[i]!.pubkey.toBase58(), expected, `account ${i}`); });
});

test('TransferRemote data: 8×0x01 discriminator, tag 1, domain, recipient, u256 amount', () => {
  const recipient = Keypair.generate().publicKey;
  const data = encodeTransferRemote(420042004, recipient, 1_234_567_890n);
  assert.equal(data.length, 77);
  assert.deepEqual([...data.subarray(0, 9)], [1, 1, 1, 1, 1, 1, 1, 1, 1]);
  assert.equal(data.readUInt32LE(9), 420042004);
  assert.ok(data.subarray(13, 45).equals(recipient.toBuffer()));
  assert.equal(data.readBigUInt64LE(45), 1_234_567_890n);
  assert.ok(data.subarray(53).every((b) => b === 0));
  assert.deepEqual(decodeTransferRemote(data), { destinationDomain: 420042004, recipient, amount: 1_234_567_890n });
  assert.deepEqual(decodeTransferRemote(Buffer.from(REAL.data, 'hex')).amount, REAL.lamports);
  assert.throws(() => encodeTransferRemote(420042004, recipient, 0n));
  assert.throws(() => encodeTransferRemote(420042004, recipient, 1n << 64n));
  const wide = Buffer.from(data); wide[60] = 1;
  assert.throws(() => decodeTransferRemote(wide), /u64/);
  const other = Buffer.from(data); other[8] = 2;
  assert.throws(() => decodeTransferRemote(other), /TransferRemote/);
});

test('a different recipient changes only the 32 recipient bytes', () => {
  const sender = Keypair.generate().publicKey, unique = Keypair.generate().publicKey, recipient = Keypair.generate().publicKey;
  const self = solToCookieTransferIx({ sender, uniqueMessage: unique, lamports: 50_000_000n });
  const other = solToCookieTransferIx({ sender, uniqueMessage: unique, lamports: 50_000_000n, recipient });
  assert.ok(self.data.subarray(13, 45).equals(sender.toBuffer()));
  assert.ok(other.data.subarray(13, 45).equals(recipient.toBuffer()));
  assert.ok(Buffer.concat([self.data.subarray(0, 13), self.data.subarray(45)]).equals(Buffer.concat([other.data.subarray(0, 13), other.data.subarray(45)])));
  assert.throws(() => solToCookieTransferIx({ sender, uniqueMessage: sender, lamports: 50_000_000n }), /fresh keypair/);
});

test('the transaction: compute limit, optional priority fee, the transfer, signed by the unique account only', () => {
  const sender = Keypair.generate().publicKey, unique = Keypair.generate();
  const recentBlockhash = Keypair.generate().publicKey.toBase58();
  const tx = buildSolToCookieTransaction({ sender, lamports: 20_000_000n, uniqueMessage: unique, recentBlockhash, microLamportsPerUnit: 1000 });
  assert.equal(tx.instructions.length, 3);
  assert.ok(tx.instructions[0]!.programId.equals(ComputeBudgetProgram.programId));
  assert.ok(tx.instructions[1]!.programId.equals(ComputeBudgetProgram.programId));
  assert.ok(tx.feePayer!.equals(sender));
  assert.ok(tx.signatures.find((s) => s.publicKey.equals(unique.publicKey))!.signature);
  assert.equal(tx.signatures.find((s) => s.publicKey.equals(sender))!.signature, null);
  assert.ok(tx.serialize({ requireAllSignatures: false, verifySignatures: true }).length <= 1232);
  assert.equal(buildSolToCookieTransaction({ sender, lamports: 20_000_000n, uniqueMessage: Keypair.generate(), recentBlockhash }).instructions.length, 2);
  assertSolToCookieTransaction(tx, { sender, recipient: sender, lamports: 20_000_000n, uniqueMessage: unique.publicKey });
  assert.throws(() => assertSolToCookieTransaction(tx, { sender, recipient: Keypair.generate().publicKey, lamports: 20_000_000n, uniqueMessage: unique.publicKey }), /recipient/);
  assert.throws(() => assertSolToCookieTransaction(tx, { sender, recipient: sender, lamports: 20_000_001n, uniqueMessage: unique.publicKey }), /amount/);
  assert.throws(() => assertSolToCookieTransaction(tx, { sender, recipient: sender, lamports: 20_000_000n, uniqueMessage: Keypair.generate().publicKey }), /account/);
  const extra = buildSolToCookieTransaction({ sender, lamports: 20_000_000n, uniqueMessage: unique, recentBlockhash });
  extra.add(SystemProgram.transfer({ fromPubkey: sender, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
  assert.throws(() => assertSolToCookieTransaction(extra, { sender, recipient: sender, lamports: 20_000_000n, uniqueMessage: unique.publicKey }), /Unexpected/);
});

test('amount limits: 0.01 SOL to 50 SOL', () => {
  assert.equal(bridgeAmountProblem(BRIDGE_MIN_LAMPORTS), null);
  assert.equal(bridgeAmountProblem(BRIDGE_MAX_LAMPORTS), null);
  assert.match(bridgeAmountProblem(BRIDGE_MIN_LAMPORTS - 1n)!, /minimum is 0\.01 SOL/);
  assert.match(bridgeAmountProblem(BRIDGE_MAX_LAMPORTS + 1n)!, /maximum per transfer is 50 SOL/);
  assert.throws(() => buildSolToCookieTransaction({ sender: Keypair.generate().publicKey, lamports: 1n, uniqueMessage: Keypair.generate(), recentBlockhash: Keypair.generate().publicKey.toBase58() }));
  assert.equal(formatLamports(10_000_000n), '0.01');
  assert.equal(formatLamports(2_359_058_000n), '2.359058');
  assert.equal(formatLamports(50_000_000_000n), '50');
});

/** A HyperlaneToken account as the Sealevel programs write it. */
function tokenAccount(opts: { mailbox: PublicKey; igp?: { program: PublicKey; tag: number; account: PublicKey } | null; routers: [number, PublicKey][]; plugin: Buffer; decimals?: number }): Buffer {
  const parts: Buffer[] = [Buffer.from([1, 255]), opts.mailbox.toBuffer(), Keypair.generate().publicKey.toBuffer(), Buffer.from([254, opts.decimals ?? 9, opts.decimals ?? 9]),
    Buffer.from([1]), Keypair.generate().publicKey.toBuffer(), Buffer.from([0])];
  if (opts.igp) parts.push(Buffer.from([1]), opts.igp.program.toBuffer(), Buffer.from([opts.igp.tag]), opts.igp.account.toBuffer());
  else parts.push(Buffer.from([0]));
  const gas = Buffer.alloc(4 + 12); gas.writeUInt32LE(1, 0); gas.writeUInt32LE(420042004, 4); gas.writeBigUInt64LE(64000n, 8);
  parts.push(gas);
  const routers = Buffer.alloc(4); routers.writeUInt32LE(opts.routers.length, 0); parts.push(routers);
  for (const [domain, router] of opts.routers) { const d = Buffer.alloc(4); d.writeUInt32LE(domain, 0); parts.push(d, router.toBuffer()); }
  parts.push(opts.plugin);
  return Buffer.concat(parts);
}

test('warp configuration: the pinned route passes, any drift is named', () => {
  const solana = tokenAccount({ mailbox: R.solana.mailbox, igp: { program: R.solana.igpProgram, tag: 1, account: R.solana.overheadIgp }, routers: [[R.cookie.domain, R.cookie.warp]], plugin: Buffer.from([253]) });
  const decoded = decodeHyperlaneToken(solana);
  assert.equal(decoded.plugin.type, 'native');
  assert.equal(decoded.destinationGas.get(420042004), 64000n);
  assert.deepEqual(solanaWarpConfigProblems(decoded), []);
  const moved = tokenAccount({ mailbox: R.solana.mailbox, igp: { program: R.solana.igpProgram, tag: 0, account: R.solana.igp }, routers: [[R.cookie.domain, Keypair.generate().publicKey]], plugin: Buffer.from([253]) });
  assert.deepEqual(solanaWarpConfigProblems(decodeHyperlaneToken(moved)), ['Cookie router changed', 'gas paymaster changed']);
  const cookie = tokenAccount({ mailbox: R.cookie.mailbox, igp: null, routers: [[R.solana.domain, R.solana.warp]], plugin: Buffer.concat([R.cookie.mint.toBuffer(), Buffer.from([1, 2])]) });
  assert.deepEqual(cookieWarpConfigProblems(decodeHyperlaneToken(cookie)), []);
  assert.deepEqual(solanaWarpConfigProblems(decodeHyperlaneToken(cookie)), ['mailbox changed', 'not a native SOL route', 'Cookie router changed', 'gas paymaster changed']);
  assert.throws(() => decodeHyperlaneToken(solana.subarray(0, 60)), /truncated/);
  assert.throws(() => decodeHyperlaneToken(Buffer.concat([solana, Buffer.alloc(5)])), /plugin/);
});

test('overhead IGP: the inner IGP follows the owner option', () => {
  const inner = Keypair.generate().publicKey;
  const withOwner = Buffer.concat([Buffer.from([1]), Buffer.alloc(8), Buffer.from([255]), Buffer.alloc(32), Buffer.from([1]), Keypair.generate().publicKey.toBuffer(), inner.toBuffer(), Buffer.alloc(8)]);
  const without = Buffer.concat([Buffer.from([1]), Buffer.alloc(8), Buffer.from([255]), Buffer.alloc(32), Buffer.from([0]), inner.toBuffer()]);
  assert.ok(overheadIgpInner(withOwner).equals(inner));
  assert.ok(overheadIgpInner(without).equals(inner));
});

test('message id from the dispatch logs', () => {
  assert.equal(messageIdFromLogs(REAL.logs), REAL.messageId);
  assert.equal(messageIdFromLogs(['Program log: nothing here']), null);
  assert.equal(messageIdFromLogs(null), null);
});

test('delivery and arrival reads use the Cookie mailbox and the recipient ATA', async () => {
  const owner = Keypair.generate().publicKey;
  const accounts = new Map<string, { lamports: number; data: Buffer }>();
  const connection = new Connection('http://localhost:8899');
  connection.getAccountInfo = (async (address: PublicKey) => {
    const a = accounts.get(address.toBase58());
    return a ? { ...a, owner: SystemProgram.programId, executable: false, rentEpoch: 0 } : null;
  }) as typeof connection.getAccountInfo;
  connection.getMultipleAccountsInfo = (async (addresses: PublicKey[]) => Promise.all(addresses.map((a) => connection.getAccountInfo(a)))) as typeof connection.getMultipleAccountsInfo;
  connection.getSignaturesForAddress = (async () => [{ signature: 'deliverysig', slot: 1, err: null, memo: null, blockTime: null }]) as typeof connection.getSignaturesForAddress;
  connection.getMinimumBalanceForRentExemption = (async (len: number) => (len + 128) * 6960) as typeof connection.getMinimumBalanceForRentExemption;

  assert.deepEqual(await readBridgeDelivery(connection, REAL.messageId), { delivered: false, signature: null });
  accounts.set(REAL.processed, { lamports: 1, data: Buffer.alloc(0) });
  assert.deepEqual(await readBridgeDelivery(connection, REAL.messageId), { delivered: true, signature: 'deliverysig' });

  // No account and a dry payer: a delivery would hang.
  assert.equal((await readCookieArrival(connection, owner)).receivable, false);
  accounts.set(ataPayerPda(R.cookie.warp).toBase58(), { lamports: 491_703_680, data: Buffer.alloc(0) });
  const fresh = await readCookieArrival(connection, owner);
  assert.equal(fresh.ataExists, false); assert.equal(fresh.receivable, true); assert.ok(fresh.ata.equals(bridgedSolAta(owner)));
  const ata = Buffer.alloc(170); ata.writeBigUInt64LE(13_000_000n, 64);
  accounts.set(bridgedSolAta(owner).toBase58(), { lamports: 2_074_080, data: ata });
  assert.deepEqual({ ...(await readCookieArrival(connection, owner)), ata: null }, { ata: null, ataExists: true, balance: 13_000_000n, receivable: true });
  assert.equal(ataPayerShortfall({ payerLamports: 3_000_000n, payerReserve: 890_880n, ataRent: 2_074_080n }), 0n);
  assert.equal(ataPayerShortfall({ payerLamports: 2_000_000n, payerReserve: 890_880n, ataRent: 2_074_080n }), 964_960n);
});
