import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, type ParsedTransactionWithMeta } from '@solana/web3.js';
import {
  ASOL_STAKE_ADMIN,
  ASOL_STAKE_PROGRAM_ID,
  STREAM_PRECISION,
  asolAccount,
  cookieSolAccount,
  fundAsolStakingIx,
  rewardApr,
  streamAfterFund,
  streamRemaining,
  streamSecondsLeft,
  type AsolStakePool,
} from '../src/asolStaking.js';
import {
  MEMO_PROGRAM_ID,
  PERPS_FEE_DESTINATION,
  PERPS_FEE_PROGRAM_ID,
  STAKE_FUND_MEMO_PREFIX,
  asolStakingYield,
  base58Decode,
  bucketCollectIx,
  encodeStakeFundMemo,
  feeShareOfStream,
  holderFeeLedger,
  holdersShareOfBucket,
  parseStakeFundMemo,
  planStakeFundMemo,
  readHolderFeeEvent,
  readStakeFundRecord,
  routeHolderFeesIxs,
  routingDuration,
  type RedeemBuilder,
  type StakeFundMemo,
  type StakeFundRecord,
} from '../src/holderFees.js';

const SOL = 1_000_000_000n;
const DAY = 86_400n;
const FD = PERPS_FEE_DESTINATION;
const FEE_ASOL = asolAccount(FD).toBase58();
/** Stands in for the Aera program's `withdraw`, which burns the aSOL in a CPI. */
const AERA = Keypair.generate().publicKey;

// --- a minimal stand-in for what `getParsedTransactions` returns ------------------

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  for (; n > 0n; n /= 58n) out = B58[Number(n % 58n)] + out;
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}
type Ix = { programId: PublicKey; parsed?: unknown; program?: string; data?: string; accounts?: PublicKey[] };
const raw = (programId: PublicKey, data: Uint8Array): Ix => ({ programId, data: base58(data), accounts: [] });
const token = (type: string, info: Record<string, unknown>): Ix => ({ programId: new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'), program: 'spl-token-2022', parsed: { type, info } });
const memo = (text: string): Ix => ({ programId: MEMO_PROGRAM_ID, program: 'spl-memo', parsed: text });
function tx(opts: { signers: PublicKey[]; ixs: Ix[]; inner?: Record<number, Ix[]>; err?: unknown; blockTime?: number }): ParsedTransactionWithMeta {
  return {
    slot: 1,
    blockTime: opts.blockTime ?? 1_000,
    meta: {
      err: opts.err ?? null,
      fee: 5000,
      preBalances: [],
      postBalances: [],
      innerInstructions: Object.entries(opts.inner ?? {}).map(([index, instructions]) => ({ index: Number(index), instructions })),
    },
    transaction: {
      signatures: ['sig'],
      message: {
        accountKeys: opts.signers.map((pubkey) => ({ pubkey, signer: true, writable: true, source: 'transaction' })),
        instructions: opts.ixs,
        recentBlockhash: '11111111111111111111111111111111',
      },
    },
  } as unknown as ParsedTransactionWithMeta;
}
const BUCKETS_SOL = Uint8Array.from([0x7c, 0x24, 0x4b, 0xa1, 0xb8, 0xc8, 0x94, 0x59]);
const BUCKETS_LINEAR = Uint8Array.from([0x6e, 0x0d, 0x60, 0x4d, 0xe6, 0xba, 0x09, 0x65]);
const PROTOCOL_FEES = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
const collect = (disc: Uint8Array, amount: bigint) =>
  tx({
    signers: [Keypair.generate().publicKey],
    ixs: [raw(PERPS_FEE_PROGRAM_ID, disc)],
    inner: { 0: [token('transferChecked', { source: 'vault', destination: FEE_ASOL, tokenAmount: { amount: amount.toString() } })] },
  });
const fundMemo = (over: Partial<StakeFundMemo> = {}): StakeFundMemo => ({
  kind: 'fees', amount: 2n * SOL / 100n, seconds: 7n * DAY, asol: 2n * SOL / 100n, left: SOL, feesLeft: SOL / 10n, funded: 3n * SOL, ...over,
});
const routing = (m: StakeFundMemo, burned: bigint, signers = [ASOL_STAKE_ADMIN, FD]) =>
  tx({
    signers,
    ixs: [raw(AERA, Uint8Array.from([1])),raw(ASOL_STAKE_PROGRAM_ID, fundAsolStakingIx(m.amount, m.seconds).data), memo(encodeStakeFundMemo(m))],
    inner: { 0: [token('burn', { account: FEE_ASOL, amount: burned.toString() })] },
  });

const pool = (totalStaked: bigint, budget: bigint, seconds: bigint, start = 0n, funded = budget): AsolStakePool => ({
  stream: { totalStaked, rewardRate: (budget * STREAM_PRECISION) / seconds, periodFinish: start + seconds, lastUpdate: start, rewardPerToken: 0n },
  funded,
  claimed: 0n,
  stakers: totalStaked > 0n ? 1 : 0,
  paused: false,
});

test('base58 decoding matches the encoding', () => {
  for (const bytes of [BUCKETS_SOL, Uint8Array.from([0, 0, 7]), fundAsolStakingIx(SOL, DAY).data]) {
    assert.deepEqual(base58Decode(base58(bytes)), Uint8Array.from(bytes));
  }
});

test('bucket collects are Anchor’s instructions, paid to the fee destination', () => {
  const disc = (s: string) => createHash('sha256').update(`global:${s}`).digest().subarray(0, 8);
  assert.deepEqual(BUCKETS_SOL, Uint8Array.from(disc('collect_bucket_fees')));
  assert.deepEqual(BUCKETS_LINEAR, Uint8Array.from(disc('collect_market_bucket_fees')));
  const sol = bucketCollectIx('SOL');
  assert.ok(sol.programId.equals(PERPS_FEE_PROGRAM_ID));
  assert.deepEqual(Uint8Array.from(sol.data), BUCKETS_SOL);
  assert.equal(sol.keys[0]!.pubkey.toBase58(), FEE_ASOL);
  const btc = bucketCollectIx('BTC');
  assert.deepEqual(Uint8Array.from(btc.data), BUCKETS_LINEAR);
  assert.equal(btc.keys[0]!.pubkey.toBase58(), FEE_ASOL);
});

test('holders get 3/4 of a bucket payout, floored', () => {
  // A fee of 1,000: insurance 100, holders 300; the bucket pays out 400.
  assert.equal(holdersShareOfBucket(400n), 300n);
  assert.equal(holdersShareOfBucket(3n), 2n);
  assert.equal(holdersShareOfBucket(0n), 0n);
});

test('memos round-trip, including the form getSignaturesForAddress reports', () => {
  const m = fundMemo();
  const text = encodeStakeFundMemo(m);
  assert.ok(text.startsWith(STAKE_FUND_MEMO_PREFIX));
  assert.ok(text.length < 200, 'memo fits comfortably in a transaction');
  assert.deepEqual(parseStakeFundMemo(text), m);
  assert.deepEqual(parseStakeFundMemo(`[${text.length}] ${text}`), m);
  assert.equal(parseStakeFundMemo('hello'), null);
  assert.equal(parseStakeFundMemo(text.replace('kind=fees', 'kind=other')), null);
  assert.equal(parseStakeFundMemo(text.replace(/fees_left=\d+/, `fees_left=${2n * SOL}`)), null, 'fees cannot exceed what is left');
  assert.equal(parseStakeFundMemo(text.replace(/amount=\d+/, 'amount=-1')), null);
});

test('a fund record needs the admin’s signature and a matching fund instruction', () => {
  const m = fundMemo();
  assert.deepEqual(readStakeFundRecord('a', routing(m, m.asol))?.memo, m);
  // A staker can write the same memo on a claim; it does not count.
  assert.equal(readStakeFundRecord('b', routing(m, m.asol, [FD])), null);
  // The memo must describe the instruction it rides with.
  const lying = tx({ signers: [ASOL_STAKE_ADMIN], ixs: [raw(ASOL_STAKE_PROGRAM_ID, fundAsolStakingIx(m.amount + 1n, m.seconds).data), memo(encodeStakeFundMemo(m))] });
  assert.equal(readStakeFundRecord('c', lying), null);
  assert.equal(readStakeFundRecord('d', tx({ signers: [ASOL_STAKE_ADMIN], ixs: [memo(encodeStakeFundMemo(m))] })), null);
  // A failed transaction moved nothing.
  assert.equal(readStakeFundRecord('e', tx({ signers: [ASOL_STAKE_ADMIN, FD], ixs: [raw(ASOL_STAKE_PROGRAM_ID, fundAsolStakingIx(m.amount, m.seconds).data), memo(encodeStakeFundMemo(m))], err: { InstructionError: [0, 'x'] } })), null);
});

test('the ledger counts bucket collects and recorded routings, nothing else', () => {
  const events = [
    readHolderFeeEvent('c1', collect(BUCKETS_SOL, 400n)),
    readHolderFeeEvent('c2', collect(BUCKETS_LINEAR, 1_000n)),
    // Protocol fees are Aera's: not counted.
    readHolderFeeEvent('p1', collect(PROTOCOL_FEES, 5_000n)),
    readHolderFeeEvent('r1', routing(fundMemo({ asol: 500n, amount: 490n }), 500n)),
    // aSOL leaving the fee destination without a routing record is Aera's own business.
    readHolderFeeEvent('x', tx({ signers: [FD], ixs: [token('transferChecked', { source: FEE_ASOL, destination: 'elsewhere', tokenAmount: { amount: '9999' } })] })),
  ].filter((e) => e !== null);
  assert.equal(events.length, 3);
  const ledger = holderFeeLedger(events);
  assert.equal(ledger.accrued, 300n + 750n);
  assert.equal(ledger.routed, 500n);
  assert.equal(ledger.owed, 550n);
  assert.equal(ledger.collects, 2);
  assert.equal(ledger.routings.length, 1);
});

test('routing what is owed leaves nothing owed: a second run cannot pay again', () => {
  const collected = [readHolderFeeEvent('c1', collect(BUCKETS_SOL, 4_000n))!];
  const first = holderFeeLedger(collected);
  assert.equal(first.owed, 3_000n);
  const routed = readHolderFeeEvent('r1', routing(fundMemo({ asol: first.owed, amount: 2_990n }), first.owed))!;
  assert.equal(holderFeeLedger([...collected, routed]).owed, 0n);
  // Routed more than accrued (it cannot happen through the script): owed floors at zero.
  const over = readHolderFeeEvent('r2', routing(fundMemo({ asol: 10n, amount: 10n }), 10n))!;
  assert.equal(holderFeeLedger([...collected, routed, over]).owed, 0n);
  assert.equal(holderFeeLedger([...collected, routed, over, readHolderFeeEvent('c2', collect(BUCKETS_SOL, 40n))!]).owed, 20n);
});

test('a routing never shortens Aera’s budget', () => {
  // 0.25 SOL over 30 days, staked from day 0; on day 1, 29 days are left.
  const p = pool(SOL, SOL / 4n, 30n * DAY);
  assert.equal(streamSecondsLeft(p.stream, DAY), 29n * DAY);
  assert.equal(routingDuration(p, DAY, 7n * DAY), 29n * DAY);
  // Once fewer than 7 days are left, the routed fees set the pace.
  assert.equal(routingDuration(p, 25n * DAY, 7n * DAY), 7n * DAY);
  assert.equal(routingDuration(p, 40n * DAY, 7n * DAY), 7n * DAY);
  // Nobody staked: the clock is stopped, so all 30 days are still ahead.
  assert.equal(routingDuration(pool(0n, SOL / 4n, 30n * DAY), 10n * DAY, 7n * DAY), 30n * DAY);
  // Funding over the remaining time keeps Aera's part streaming at its own rate.
  const after = streamAfterFund(p.stream, SOL / 100n, 29n * DAY, DAY);
  assert.equal(after.periodFinish, p.stream.periodFinish);
  const aeraRate = p.stream.rewardRate;
  const feeRate = (SOL / 100n) * STREAM_PRECISION / (29n * DAY);
  assert.ok(after.rewardRate - aeraRate - feeRate <= 1n);
});

test('the memo records how much of what is left is fees', () => {
  const p = pool(SOL, SOL / 4n, 30n * DAY);
  const now = DAY;
  const first = planStakeFundMemo(p, now, 'fees', SOL / 100n, 29n * DAY, null, 12_345n);
  assert.equal(first.funded, p.funded + SOL / 100n);
  assert.equal(first.asol, 12_345n);
  assert.ok(first.left <= streamRemaining(p, now) + SOL / 100n && streamRemaining(p, now) + SOL / 100n - first.left <= 1n);
  assert.equal(first.feesLeft, SOL / 100n);
  const record: StakeFundRecord = { signature: 's', blockTime: Number(now), memo: first };
  // After the fund, the split holds as the stream runs down.
  const funded: AsolStakePool = { ...p, stream: streamAfterFund(p.stream, SOL / 100n, 29n * DAY, now), funded: first.funded };
  const later = feeShareOfStream(funded, 10n * DAY, record)!;
  const ratio = Number(later.fees * 1_000_000n / later.left) / 1_000_000;
  assert.ok(Math.abs(ratio - Number(first.feesLeft) / Number(first.left)) < 1e-5);
  // An Aera top-up dilutes the fee share but keeps the fees.
  const topUp = planStakeFundMemo(funded, 10n * DAY, 'aera', SOL / 4n, 20n * DAY, record);
  assert.ok(topUp.feesLeft === later.fees);
  // Funded since without a record: the split is unknown.
  assert.equal(feeShareOfStream({ ...funded, funded: funded.funded + 1n }, 10n * DAY, record), null);
  // No record at all: only Aera has funded.
  assert.deepEqual(feeShareOfStream(p, now, null), { fees: 0n, left: streamRemaining(p, now) });
});

test('the yield is the sum of its parts, with Aera’s budget kept apart', () => {
  const now = 10n * DAY;
  // 2 aSOL staked at par; Aera's 0.25 SOL over 30 days, plus 0.03 SOL of fees routed on day 3.
  const base = pool(2n * SOL, SOL / 4n, 30n * DAY);
  const memo1 = planStakeFundMemo(base, 3n * DAY, 'fees', 3n * SOL / 100n, 27n * DAY, null, 3n * SOL / 100n);
  const p: AsolStakePool = { ...base, stream: streamAfterFund(base.stream, 3n * SOL / 100n, 27n * DAY, 3n * DAY), funded: memo1.funded };
  const records = [{ signature: 'r', blockTime: Number(3n * DAY), memo: memo1 }];
  const y = asolStakingYield({ pool: p, now, asolPerSolE9: SOL, supplyAprBps: 120, records });
  assert.equal(y.lendingApr, 0.012);
  assert.equal(y.feesRouted, 3n * SOL / 100n);
  // 0.03 SOL in 30 days, a year of that, over 2 SOL staked.
  assert.ok(y.feeApr !== null && Math.abs(y.feeApr - (0.03 * 365) / 30 / 2) < 1e-5, `fee ${y.feeApr}`);
  const stream = rewardApr(p, now, SOL)!;
  assert.ok(y.aeraApr !== null && y.aeraApr < stream && y.aeraApr > 0);
  assert.ok(Math.abs(y.totalApr! - (y.lendingApr + y.feeApr! + y.aeraApr!)) < 1e-12);
  assert.equal(y.aeraSolLeft + y.feeSolLeft, streamRemaining(p, now));
  assert.equal(y.endsAt, p.stream.periodFinish);
  assert.ok(y.splitKnown);
  // Fees routed before the window no longer count.
  assert.equal(asolStakingYield({ pool: p, now: 40n * DAY, asolPerSolE9: SOL, supplyAprBps: 0, records }).feeApr, 0);
  // Nobody staked: no rate to show beyond lending.
  const empty = asolStakingYield({ pool: pool(0n, SOL / 4n, 30n * DAY), now, asolPerSolE9: SOL, supplyAprBps: 120, records: [] });
  assert.equal(empty.totalApr, null);
  assert.equal(empty.feeApr, null);
  assert.equal(empty.endsAt, null);
  assert.equal(empty.aeraSolLeft, streamRemaining(pool(0n, SOL / 4n, 30n * DAY), now));
  // Funded without a record: the whole stream is shown as Aera's and no fee share is claimed.
  const unknown = asolStakingYield({ pool: { ...p, funded: p.funded + 1n }, now, asolPerSolE9: SOL, supplyAprBps: 0, records });
  assert.equal(unknown.splitKnown, false);
  assert.equal(unknown.feeApr, null);
  assert.equal(unknown.aeraApr, stream);
});

test('the routing transaction, in both modes', async () => {
  const reserve = new PublicKey('HEr4uwrN7Cz1uegzYRP7GiHPXN2GjMK6tvQCTm12phjT');
  const calls: string[] = [];
  const client: RedeemBuilder = {
    reserveAddress: () => reserve,
    accrueIx: async (r) => { calls.push(`accrue ${r.toBase58()}`); return new TransactionInstruction({ programId: reserve, keys: [], data: Buffer.from([1]) }); },
    withdrawIx: async (owner, _mint, shares) => { calls.push(`withdraw ${owner.toBase58()} ${shares}`); return new TransactionInstruction({ programId: reserve, keys: [], data: Buffer.from([2]) }); },
  };
  const m = fundMemo({ asol: 1_000n, amount: 990n, seconds: 7n * DAY });
  const redeem = await routeHolderFeesIxs(client, { mode: 'redeem', asol: 1_000n, sol: 990n, seconds: 7n * DAY, memo: m, topUpLamports: 1_500_000n });
  assert.deepEqual(calls, [`accrue ${reserve.toBase58()}`, `withdraw ${FD.toBase58()} 1000`]);
  assert.equal(redeem.length, 7);
  assert.ok(redeem[1]!.programId.equals(SystemProgram.programId));
  const transfer = redeem[4]!;
  assert.ok(transfer.keys[0]!.pubkey.equals(cookieSolAccount(FD)) && transfer.keys[2]!.pubkey.equals(cookieSolAccount(ASOL_STAKE_ADMIN)));
  assert.ok(transfer.keys[3]!.pubkey.equals(FD) && transfer.keys[3]!.isSigner);
  assert.ok(redeem[5]!.programId.equals(ASOL_STAKE_PROGRAM_ID));
  assert.equal(redeem[5]!.data.readBigUInt64LE(8), 990n);
  assert.deepEqual(parseStakeFundMemo(redeem[6]!.data.toString('utf8')), m);
  // Without a top-up there is no system transfer.
  assert.equal((await routeHolderFeesIxs(client, { mode: 'redeem', asol: 1_000n, sol: 990n, seconds: 7n * DAY, memo: m })).length, 6);
  const front = await routeHolderFeesIxs(client, { mode: 'front', asol: 1_000n, sol: 990n, seconds: 7n * DAY, memo: m });
  assert.equal(front.length, 4);
  assert.ok(front[1]!.keys[0]!.pubkey.equals(asolAccount(FD)) && front[1]!.keys[2]!.pubkey.equals(asolAccount(ASOL_STAKE_ADMIN)));
  // The memo must describe the transaction.
  await assert.rejects(routeHolderFeesIxs(client, { mode: 'redeem', asol: 1_000n, sol: 991n, seconds: 7n * DAY, memo: m }), /memo/);
  await assert.rejects(routeHolderFeesIxs(client, { mode: 'redeem', asol: 0n, sol: 0n, seconds: 7n * DAY, memo: m }), /positive/);
});
