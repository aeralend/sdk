/**
 * aCOOK as a COOK savings receipt: the disclosure arithmetic and the zap.
 *
 * Pure functions are pinned against the program's own mirrors (`math.ts`,
 * `projection.ts`, `redeemableReceiptShares`) rather than against restated
 * formulas, so a change to the program's maths breaks these instead of drifting.
 * The two readers run on the receipt tests' fixture connection, which serves
 * the real IDL's account encodings.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';

import {
  AeraClient,
  BCOOK_STAKE_POOL,
  COOK_RESERVE_CONFIG,
  DOCUMENTED_PROJECT_WALLETS,
  FIXED_POINT_SCALE,
  NATIVE_MINT,
  STAKE_POOL_PROGRAM_ID,
  ZAP_INSTRUCTION_COUNT,
  ZAP_MIN_NATIVE_COOK,
  ZAP_SLIPPAGE_BPS,
  bcookToCookQuote,
  borrowRateBps,
  borrowerBreakdown,
  buildZapInstructions,
  decodeStakePool,
  holderConcentration,
  lamportsForWithdrawal,
  poolTokensForDeposit,
  prepareAcookZap,
  rateAtUtilization,
  rateCurve,
  readSavingsReport,
  sellImpactBps,
  COOK_POOL_PINS,
  savingsStats,
  supplyRateBps,
  upgradeAuthorityOf,
  zapQuote,
  zapSharesForBcook,
  type ReserveAccount,
  type StakePoolState,
  type ZapInput,
} from '../src/index.js';
import { programDataAddress } from '../src/oracleConfig.js';
import { receiptIdentity, redeemableReceiptShares } from '../src/receipts.js';
import { receiptFixture, owner as fixtureOwner, info } from './receipt-fixture.js';

const KEY = (n: number) => new PublicKey(Buffer.alloc(32, n));
const E9 = 1_000_000_000n;

/** The COOK reserve as read on 2026-10-27, to the hundred thousand. */
const reserve = (patch: Partial<ReserveAccount> = {}): ReserveAccount => ({
  address: KEY(1),
  market: KEY(2),
  liquidityMint: NATIVE_MINT,
  liquidityVault: KEY(3),
  shareMint: KEY(4),
  oracle: KEY(5),
  liquidityDecimals: 9,
  availableLiquidity: 402_336n * E9,
  shareMintSupply: 1_000_022n * E9,
  borrowedPrincipal: 598_520n * E9,
  borrowIndex: 1_012_030_936_592_909_260n,
  lastUpdateSlot: 100n,
  accruedFees: 1_968n * E9,
  config: { ...COOK_RESERVE_CONFIG, maxBorrowRateBps: 16_000 },
  pending: { config: COOK_RESERVE_CONFIG, eta: 0n },
  bump: 1,
  ...patch,
});

// ---- the stake pool, as a state object ----------------------------------------------------------

const fee = (bps: number) => ({ denominator: 10_000n, numerator: BigInt(bps) });
const stakePool = (patch: Partial<StakePoolState> = {}): StakePoolState => ({
  address: KEY(10),
  programId: KEY(11),
  reserveStake: KEY(12),
  poolMint: new PublicKey(receiptIdentity('abCOOK').mint), // bCOOK
  managerFeeAccount: KEY(13),
  tokenProgram: TOKEN_PROGRAM_ID,
  withdrawAuthority: KEY(14),
  totalLamports: 180_600_000n * E9,
  poolTokenSupply: 123_840_000n * E9,
  lastUpdateEpoch: 77n,
  grossRate: 0n,
  solDepositFee: fee(50),
  solReferralFeePercent: 0,
  solWithdrawalFee: fee(200),
  stakeWithdrawalFee: fee(200),
  nextSolWithdrawalFee: null,
  solDepositAuthority: null,
  solWithdrawAuthority: null,
  ...patch,
});

const zapReserve = (r = reserve()) => {
  const s = savingsStats(r, r.lastUpdateSlot);
  return { available: s.available, total: s.totalSupplied, supply: s.shareSupply, paused: false };
};
const zapInput = (patch: Partial<ZapInput> = {}): ZapInput => ({
  shares: 1_000n * E9,
  walletShares: 5_000n * E9,
  reserve: zapReserve(),
  stake: stakePool(),
  epoch: 77n,
  walletNativeCook: 5n * E9,
  ...patch,
});

// ---- stats and the curve ------------------------------------------------------------------------

test('stats reproduce the program: rate, utilisation, supply rate and the share redeemable at par', () => {
  const r = reserve();
  const s = savingsStats(r, r.lastUpdateSlot);
  const total = r.availableLiquidity + (r.borrowedPrincipal * r.borrowIndex + FIXED_POINT_SCALE - 1n) / FIXED_POINT_SCALE - r.accruedFees;
  assert.equal(s.totalSupplied, total);
  assert.equal(s.rate, (total * FIXED_POINT_SCALE) / r.shareMintSupply);
  assert.equal(s.available + s.borrowed, s.totalSupplied);
  assert.equal(BigInt(s.supplyRateBps), supplyRateBps(r));
  assert.equal(BigInt(s.borrowRateBps), borrowRateBps(r));
  assert.ok(s.utilizationBps > 5_900 && s.utilizationBps < 6_100, `utilisation ${s.utilizationBps}`);
  assert.equal(s.parBps, Number((s.available * 10_000n) / s.totalSupplied));
  assert.ok(s.parBps > 3_900 && s.parBps < 4_100);
  assert.equal(s.paused, false);
  assert.equal(savingsStats(r, r.lastUpdateSlot, true).paused, true);
});

test('stats accrue to the slot read, so the rate never lags the chain', () => {
  const r = reserve();
  const later = savingsStats(r, r.lastUpdateSlot + 1_000_000n);
  const now = savingsStats(r, r.lastUpdateSlot);
  assert.ok(later.rate > now.rate, 'interest accrues into the rate');
  assert.equal(later.available, now.available);
});

test('an empty reserve reads as rate 1, nothing redeemable, no division by zero', () => {
  const s = savingsStats(reserve({ availableLiquidity: 0n, shareMintSupply: 0n, borrowedPrincipal: 0n, accruedFees: 0n }), 100n);
  assert.equal(s.rate, FIXED_POINT_SCALE);
  assert.equal(s.parBps, 0);
  assert.equal(s.supplyRateBps, 0);
  assert.equal(s.totalSupplied, 0n);
});

test('the curve function agrees with the program mirror at every utilisation it is asked for', () => {
  const config = reserve().config;
  for (const u of [0, 1, 500, 2_999, 3_000, 5_999, 6_000, 6_001, 8_000, 9_999, 10_000]) {
    // A reserve whose index is exactly 1 and whose borrowed share is u / 10,000 of 10,000 tokens.
    const r = reserve({ availableLiquidity: BigInt(10_000 - u) * E9, borrowedPrincipal: BigInt(u) * E9, borrowIndex: FIXED_POINT_SCALE, accruedFees: 0n, shareMintSupply: 10_000n * E9 });
    const row = rateAtUtilization(config, u);
    assert.equal(BigInt(row.borrowRateBps), borrowRateBps(r), `borrow at ${u}`);
    assert.equal(BigInt(row.supplyRateBps), supplyRateBps(r), `supply at ${u}`);
  }
  assert.throws(() => rateAtUtilization(config, 10_001));
  assert.throws(() => rateAtUtilization(config, -1));
});

test('the curve shows five ordered points, with supply rate rising with utilisation and near zero when idle', () => {
  const rows = rateCurve(reserve().config);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((r) => r.utilizationBps), [500, 3_000, 6_000, 8_000, 10_000]);
  for (let i = 1; i < rows.length; i += 1) assert.ok(rows[i]!.supplyRateBps > rows[i - 1]!.supplyRateBps);
  assert.ok(rows[0]!.supplyRateBps < 20, 'a market nobody borrows from pays almost nothing');
  // A kink that coincides with a listed point is not listed twice.
  assert.equal(rateCurve({ ...reserve().config, optimalUtilizationBps: 3_000 }).length, 4);
});

// ---- who holds it, who owes ---------------------------------------------------------------------

test("holder concentration merges an owner's accounts and states the exact share", () => {
  const c = holderConcentration(
    [
      { owner: 'A', amount: 600n },
      { owner: 'B', amount: 100n },
      { owner: 'A', amount: 300n },
      { owner: 'C', amount: 0n },
    ],
    1_000n,
    3,
  );
  assert.deepEqual(c.holders.map((h) => h.owner), ['A', 'B']);
  assert.deepEqual(c.holders.map((h) => h.amount), [900n, 100n]);
  assert.equal(c.topShare, 0.9);
  assert.equal(c.top3Share, 1);
  assert.equal(c.listedShare, 1);
  assert.equal(c.mayHaveMoreHolders, false);
  const partial = holderConcentration([{ owner: 'A', amount: 500n }], 1_000n, 3);
  assert.equal(partial.listedShare, 0.5);
  assert.equal(holderConcentration([], 1_000n, 20).mayHaveMoreHolders, true);
  assert.equal(holderConcentration([{ owner: 'A', amount: 1n }], 0n).topShare, 0);
});

test('one wallet holding 99.998% is shown as such, not rounded to everything', () => {
  const supply = 1_000_021_575_446_072n;
  const c = holderConcentration([{ owner: 'A', amount: 999_999_995_529_640n }, { owner: 'B', amount: 20_499_999_995n }], supply);
  assert.ok(c.topShare > 0.99997 && c.topShare < 0.99998, String(c.topShare));
  assert.ok(c.topShare < 1);
});

const obligation = (owner: PublicKey, reserveAddress: PublicKey, principal: bigint, other = false) => ({
  owner,
  borrows: [{ reserve: other ? KEY(99) : reserveAddress, borrowedPrincipal: principal, marketValue: 0n }],
});

test('the owner confirmed his wallet, so the records label it as his', () => {
  assert.equal(DOCUMENTED_PROJECT_WALLETS.EH5c4qiAzQhMmWbabbB8QjgZ9VU6DoSfy2HJYRJwvsFv, 'Aera’s owner');
  assert.equal(DOCUMENTED_PROJECT_WALLETS.zbUkycruoGyf5jcpmthQpMUq3Y2hp6ywY4WsDFDozok, 'the Aera operator wallet');
});

test('borrowers: share of debt is share of interest, scaled by the index, labelled only where the records name a wallet', () => {
  const r = reserve();
  const operator = new PublicKey(Object.keys(DOCUMENTED_PROJECT_WALLETS)[0]!);
  const b = borrowerBreakdown(
    [obligation(KEY(21), r.address, 100n * E9), obligation(operator, r.address, 600n * E9), obligation(KEY(22), r.address, 0n), obligation(KEY(23), r.address, 999n * E9, true)],
    r,
  );
  assert.equal(b.count, 2);
  assert.equal(b.borrowers[0]!.owner, operator.toBase58());
  assert.equal(b.borrowers[0]!.label, 'the Aera operator wallet');
  assert.equal(b.borrowers[1]!.label, null);
  assert.ok(Math.abs(b.largestShare - 600 / 700) < 1e-9);
  assert.equal(b.labelledShare, b.largestShare);
  assert.equal(b.totalDebt, b.borrowers[0]!.debt + b.borrowers[1]!.debt);
  // Debt is principal times the index, rounded up, as the program counts it.
  assert.equal(b.borrowers[1]!.debt, (100n * E9 * r.borrowIndex + FIXED_POINT_SCALE - 1n) / FIXED_POINT_SCALE);
  assert.equal(borrowerBreakdown([], r).count, 0);
  assert.equal(borrowerBreakdown([], r).largestShare, 0);
});

test('upgrade authority is read from the first 45 bytes of ProgramData, and an immutable program has none', () => {
  const data = Buffer.alloc(45);
  data.writeUInt32LE(3, 0);
  data.writeBigUInt64LE(5_504_973n, 4);
  data[12] = 1;
  KEY(7).toBuffer().copy(data, 13);
  assert.equal(upgradeAuthorityOf(data)!.toBase58(), KEY(7).toBase58());
  data[12] = 0;
  assert.equal(upgradeAuthorityOf(data), null);
  data.writeUInt32LE(2, 0);
  assert.throws(() => upgradeAuthorityOf(data));
  assert.throws(() => upgradeAuthorityOf(Buffer.alloc(10)));
});

test('selling into a constant-product pool costs in + reserve proportion, and a thin pool costs a lot', () => {
  assert.equal(sellImpactBps(0n, 100n), 0);
  assert.equal(sellImpactBps(100n, 100n), 5_000);
  assert.equal(sellImpactBps(10n, 990n), 100);
  assert.equal(sellImpactBps(1n, 0n), 10_000);
  // 10% of a reserve sold in moves the price by about a ninth of the reserve's worth, not by 10%.
  assert.equal(sellImpactBps(100n, 1_000n), 909);
});

// ---- the zap ------------------------------------------------------------------------------------

test('the zap quote chains the program\'s own arithmetic: redeem floors, deposit mints, the minimum is the slippage below it', () => {
  const input = zapInput();
  const q = zapQuote(input);
  const r = input.reserve;
  assert.equal(q.sharesIn, 1_000n * E9);
  assert.equal(q.cappedBy, null);
  assert.equal(q.cookOut, (q.sharesIn * r.total) / r.supply);
  assert.equal(q.stakeLamports, q.cookOut, 'what is staked is exactly what was redeemed');
  assert.equal(q.bcookOut, poolTokensForDeposit(q.cookOut, input.stake));
  assert.equal(q.minBcookOut, (q.bcookOut * BigInt(10_000 - ZAP_SLIPPAGE_BPS)) / 10_000n);
  assert.equal(q.depositFeeBps, 50);
  assert.equal(q.withdrawalFeeBps, 200);
  assert.deepEqual(q.blockers, []);
  assert.ok(q.cookOut > q.sharesIn, 'aCOOK is worth more than one COOK');
});

test('the round trip costs about 2.5%: both pool fees from the exact amounts, with no Aera fee', () => {
  const q = zapQuote(zapInput());
  assert.equal(q.roundTripCookBack, lamportsForWithdrawal(q.bcookOut, stakePool()));
  assert.ok(q.roundTripCostPct > 2.48 && q.roundTripCostPct < 2.5, String(q.roundTripCostPct));
  // The fees are read: a pool that charged more shows more.
  const dearer = zapQuote(zapInput({ stake: stakePool({ solWithdrawalFee: fee(500) }) }));
  assert.ok(dearer.roundTripCostPct > 5.4 && dearer.roundTripCostPct < 5.5);
  assert.equal(dearer.withdrawalFeeBps, 500);
});

test('asking for more than the wallet holds converts what it holds, and says so', () => {
  const q = zapQuote(zapInput({ shares: 9_000n * E9, walletShares: 400n * E9 }));
  assert.equal(q.sharesIn, 400n * E9);
  assert.equal(q.cappedBy, 'wallet');
  assert.deepEqual(q.blockers, []);
});

test('when the cash nobody has borrowed is smaller than the request, the quote is capped at par and the cap is exact', () => {
  const thin = reserve({ availableLiquidity: 10n * E9 });
  const input = zapInput({ reserve: zapReserve(thin), shares: 4_000n * E9, walletShares: 4_000n * E9 });
  const q = zapQuote(input);
  assert.equal(q.cappedBy, 'liquidity');
  assert.ok(q.sharesIn < 4_000n * E9);
  assert.ok(q.cookOut <= input.reserve.available, 'never more than the vault holds');
  assert.equal(q.sharesIn, q.maxShares);
  assert.equal(q.sharesIn, redeemableReceiptShares(4_000n * E9, input.reserve.total, input.reserve.supply, input.reserve.available));
  // One more aCOOK would not fit.
  const one = zapQuote({ ...input, shares: q.sharesIn + 1n });
  assert.equal(one.sharesIn, q.sharesIn);
  assert.ok(((q.sharesIn + 1n) * input.reserve.total) / input.reserve.supply > input.reserve.available);
  assert.equal(q.parCook <= input.reserve.available, true);
  assert.ok(q.parShares >= q.maxShares);
});

test('with nothing to redeem the quote blocks on liquidity; a paused market blocks on the pause', () => {
  const dry = zapQuote(zapInput({ reserve: zapReserve(reserve({ availableLiquidity: 0n })) }));
  assert.ok(dry.blockers.includes('no-liquidity'));
  assert.equal(dry.sharesIn, 0n);
  const paused = zapQuote(zapInput({ reserve: { ...zapReserve(), paused: true } }));
  assert.ok(paused.blockers.includes('paused'));
  assert.equal(paused.maxShares, 0n);
});

test('the stake pool\'s own conditions block the zap: not updated for the epoch, or deposits restricted', () => {
  assert.ok(zapQuote(zapInput({ epoch: 78n })).blockers.includes('pool-stale'));
  assert.ok(!zapQuote(zapInput({ epoch: null })).blockers.includes('pool-stale'));
  assert.ok(zapQuote(zapInput({ stake: stakePool({ solDepositAuthority: KEY(30) }) })).blockers.includes('pool-restricted'));
});

test('dust, an empty request and a wallet too poor for fees are named, not attempted', () => {
  assert.ok(zapQuote(zapInput({ shares: 0n })).blockers.includes('no-shares'));
  assert.ok(zapQuote(zapInput({ walletShares: 0n })).blockers.includes('no-shares'));
  assert.ok(zapQuote(zapInput({ shares: 1n })).blockers.includes('too-small'));
  assert.ok(zapQuote(zapInput({ walletNativeCook: ZAP_MIN_NATIVE_COOK - 1n })).blockers.includes('wallet-fees'));
  assert.ok(!zapQuote(zapInput({ walletNativeCook: ZAP_MIN_NATIVE_COOK })).blockers.includes('wallet-fees'));
  assert.ok(!zapQuote(zapInput({ walletNativeCook: null })).blockers.includes('wallet-fees'));
  assert.throws(() => zapQuote(zapInput({ slippageBps: 0 })));
  assert.throws(() => zapQuote(zapInput({ slippageBps: 101 })));
});

test('the aCOOK needed for a given bCOOK actually buys it', () => {
  const input = zapInput();
  for (const bcook of [1n, 10n * E9, 12_400n * E9, 50_000n * E9]) {
    const shares = zapSharesForBcook(bcook, input.stake, input.reserve);
    assert.ok(shares > 0n);
    const q = zapQuote({ ...input, shares, walletShares: shares });
    assert.ok(q.bcookOut >= bcook, `${bcook}: got ${q.bcookOut}`);
    // And it is close: well under 0.1% more than needed once the amount is not dust.
    if (bcook >= E9) assert.ok(q.bcookOut < bcook + bcook / 1_000n);
  }
  assert.equal(zapSharesForBcook(0n, input.stake, input.reserve), 0n);
});

test('the way back reads the pool\'s fee and its reserve, and says when the reserve cannot pay', () => {
  const pool = stakePool();
  const q = bcookToCookQuote(100n * E9, pool, 1_000_000n * E9);
  assert.equal(q.feeBps, 200);
  assert.equal(q.cookOut, lamportsForWithdrawal(100n * E9, pool));
  assert.equal(q.exceedsReserve, false);
  const tight = bcookToCookQuote(100n * E9, pool, 50n * E9);
  assert.equal(tight.exceedsReserve, true);
  assert.ok(lamportsForWithdrawal(tight.maxBcook!, pool) <= 50n * E9);
  assert.ok(lamportsForWithdrawal(tight.maxBcook! + 1n, pool) > 50n * E9);
  assert.equal(bcookToCookQuote(100n * E9, pool, null).maxBcook, null);
  assert.equal(bcookToCookQuote(0n, pool, null).cookOut, 0n);
});

// ---- instructions and the readers, on the receipt fixture --------------------------------------

/** A StakePool account in the SPL layout, with the live pool's fees. */
function poolAccount(mint: PublicKey, epoch = 77n): Buffer {
  const data = Buffer.alloc(611);
  data[0] = 1;
  KEY(12).toBuffer().copy(data, 130);
  mint.toBuffer().copy(data, 162);
  KEY(13).toBuffer().copy(data, 194);
  TOKEN_PROGRAM_ID.toBuffer().copy(data, 226);
  data.writeBigUInt64LE(180_600_000n * E9, 258);
  data.writeBigUInt64LE(123_840_000n * E9, 266);
  data.writeBigUInt64LE(epoch, 274);
  let at = 330;
  const f = (bps: number) => {
    data.writeBigUInt64LE(10_000n, at);
    data.writeBigUInt64LE(BigInt(bps), at + 8);
    at += 16;
  };
  f(1); // epoch_fee
  data[at++] = 0; // next_epoch_fee
  data[at++] = 0; // preferred deposit
  data[at++] = 0; // preferred withdraw
  f(50); // stake_deposit_fee
  f(200); // stake_withdrawal_fee
  data[at++] = 0; // next_stake_withdrawal_fee
  data[at++] = 0; // stake_referral_fee
  data[at++] = 0; // sol_deposit_authority
  f(50); // sol_deposit_fee
  data[at++] = 0; // sol_referral_fee
  data[at++] = 0; // sol_withdraw_authority
  f(200); // sol_withdrawal_fee
  data[at++] = 0; // next_sol_withdrawal_fee
  data.writeBigUInt64LE(1n, at);
  data.writeBigUInt64LE(1n, at + 8);
  return data;
}

async function zapFixture(options: { epoch?: bigint; balance?: number } = {}) {
  const fixture = await receiptFixture();
  const { connection, accounts } = fixture;
  const bcook = new PublicKey(receiptIdentity('abCOOK').mint);
  const pool = KEY(10);
  const real = BCOOK_STAKE_POOL;
  accounts.set(real.toBase58(), info(poolAccount(bcook, options.epoch ?? 77n), STAKE_POOL_PROGRAM_ID));
  // The pool's reserve is an Initialized stake account holding plenty.
  const reserveData = Buffer.alloc(200);
  reserveData.writeUInt32LE(1, 0);
  reserveData.writeBigUInt64LE(2_282_880n, 4);
  const stakeReserve = decodeStakePool(real, poolAccount(bcook)).reserveStake;
  accounts.set(stakeReserve.toBase58(), { ...info(reserveData, KEY(40)), lamports: 5_000_000_000 });
  // The native mint (wCOOK), for the token program lookup.
  const mint = Buffer.alloc(82);
  mint.writeUInt32LE(0, 0);
  mint[44] = 9;
  mint[45] = 1;
  accounts.set(NATIVE_MINT.toBase58(), info(mint, TOKEN_PROGRAM_ID));
  (connection as any).getEpochInfo = async () => ({ epoch: 77 });
  (connection as any).getBalance = async () => options.balance ?? 3_000_000_000;
  void pool;
  return fixture;
}

test('buildZapInstructions orders the steps: wrapper account, accrue, redeem, unwrap, bCOOK account, deposit with a minimum', async () => {
  const { connection } = await zapFixture();
  const client = new AeraClient({ connection });
  // The real pool's address and program: the on-chain-minimum variant is only built for BakeYourStake's own program.
  const stake = decodeStakePool(BCOOK_STAKE_POOL, poolAccount(new PublicKey(receiptIdentity('abCOOK').mint)), STAKE_POOL_PROGRAM_ID);
  const quote = zapQuote(zapInput({ stake, walletShares: 5_000n * E9 }));
  const ixs = await buildZapInstructions({ client, owner: fixtureOwner.publicKey, quote, stake });
  assert.equal(ixs.length, ZAP_INSTRUCTION_COUNT);
  const programs = ixs.map((i) => i.programId.toBase58());
  assert.equal(programs[1], client.programId.toBase58(), 'accrue');
  assert.equal(programs[2], client.programId.toBase58(), 'withdraw');
  assert.equal(programs[3], TOKEN_PROGRAM_ID.toBase58(), 'unwrap');
  assert.equal(programs[5], stake.programId.toBase58(), 'deposit');
  // The deposit is the variant that enforces the minimum on chain (tag 25), for exactly the redeemed COOK.
  const deposit = ixs[5]!;
  assert.equal(deposit.data[0], 25);
  assert.equal(deposit.data.readBigUInt64LE(1), quote.stakeLamports);
  assert.equal(deposit.data.readBigUInt64LE(9), quote.minBcookOut);
  // Every signer is the owner: nothing else can be asked to sign.
  const signers = new Set(ixs.flatMap((i) => i.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())));
  assert.deepEqual([...signers], [fixtureOwner.publicKey.toBase58()]);
  // The redeem burns the owner's aCOOK, exactly the shares quoted.
  const shareAccount = getAssociatedTokenAddressSync(receiptIdentity('aCOOK').shareMint, fixtureOwner.publicKey, true, TOKEN_2022_PROGRAM_ID);
  assert.ok(ixs[2]!.keys.some((k) => k.pubkey.equals(shareAccount) && k.isWritable));
  assert.equal(ixs[2]!.data.readBigUInt64LE(8), quote.sharesIn);
  await assert.rejects(buildZapInstructions({ client, owner: fixtureOwner.publicKey, quote: { ...quote, minBcookOut: 0n }, stake }));
  await assert.rejects(buildZapInstructions({ client, owner: fixtureOwner.publicKey, quote: { ...quote, sharesIn: 0n }, stake }));
  await assert.rejects(buildZapInstructions({ client, owner: fixtureOwner.publicKey, quote, stake: stakePool({ poolMint: KEY(50) }) }));
});

test('prepareAcookZap reads the chain, prices from the redeemable amount it read, and builds the one transaction', async () => {
  const { connection } = await zapFixture();
  const prepared = await prepareAcookZap(connection, fixtureOwner.publicKey, 60n, { now: 1_000 });
  // The fixture's reserve holds 500 of 1,000 shares' worth as cash, the wallet 100 aCOOK; rate 1.0.
  assert.equal(prepared.walletShares, 100n);
  assert.equal(prepared.quote.sharesIn, 60n);
  assert.equal(prepared.quote.cookOut, 60n);
  assert.deepEqual(prepared.quote.blockers, []);
  assert.equal(prepared.instructions.length, 6);
  assert.equal(prepared.expiresAt, 1_000 + 45_000);
  assert.equal(prepared.epoch, 77n);
  assert.ok(prepared.stakeWithdrawable > 0n);
  // Asking for more than the wallet holds converts all it holds.
  const all = await prepareAcookZap(connection, fixtureOwner.publicKey, 10_000n);
  assert.equal(all.quote.sharesIn, 100n);
  assert.equal(all.quote.cappedBy, 'wallet');
});

test('prepareAcookZap refuses to build when the pool is stale or the wallet cannot pay fees, and builds nothing', async () => {
  const stale = await zapFixture({ epoch: 76n });
  const a = await prepareAcookZap(stale.connection, fixtureOwner.publicKey, 60n);
  assert.ok(a.quote.blockers.includes('pool-stale'));
  assert.equal(a.instructions.length, 0);
  const poor = await zapFixture({ balance: 1_000 });
  const b = await prepareAcookZap(poor.connection, fixtureOwner.publicKey, 60n);
  assert.ok(b.quote.blockers.includes('wallet-fees'));
  assert.equal(b.instructions.length, 0);
});

test('prepareAcookZap fails closed on the wrong chain and on a stake pool that is not bCOOK\'s', async () => {
  const wrong = await zapFixture();
  wrong.connection.getGenesisHash = async () => KEY(60).toBase58();
  await assert.rejects(prepareAcookZap(wrong.connection, fixtureOwner.publicKey, 60n));
  const other = await zapFixture();
  other.accounts.set(BCOOK_STAKE_POOL.toBase58(), info(poolAccount(KEY(61)), STAKE_POOL_PROGRAM_ID));
  await assert.rejects(prepareAcookZap(other.connection, fixtureOwner.publicKey, 60n), /mint changed/);
});

test('the report reads one slot of reserve, then holders, borrowers and authorities, and names whatever it could not read', async () => {
  const { connection, accounts } = await zapFixture();
  const id = receiptIdentity('aCOOK');
  const holder = Keypair.generate().publicKey;
  const token = (amount: bigint, who: PublicKey) => {
    const data = Buffer.alloc(165);
    id.shareMint.toBuffer().copy(data);
    who.toBuffer().copy(data, 32);
    data.writeBigUInt64LE(amount, 64);
    data[108] = 1;
    return info(data, TOKEN_2022_PROGRAM_ID);
  };
  const holderAccount = KEY(70);
  accounts.set(holderAccount.toBase58(), token(900n, holder));
  // The two COOK pools' vaults: 600 and 400 COOK, 3 and 2 SOL.
  const vault = (mint: PublicKey, amount: bigint, program: PublicKey) => {
    const data = Buffer.alloc(165);
    mint.toBuffer().copy(data);
    KEY(71).toBuffer().copy(data, 32);
    data.writeBigUInt64LE(amount, 64);
    data[108] = 1;
    return info(data, program);
  };
  accounts.set(COOK_POOL_PINS[0].tokenVault.toBase58(), vault(NATIVE_MINT, 600n * E9, TOKEN_PROGRAM_ID));
  accounts.set(COOK_POOL_PINS[0].solVault.toBase58(), vault(KEY(72), 3n * E9, TOKEN_2022_PROGRAM_ID));
  accounts.set(COOK_POOL_PINS[1].tokenVault.toBase58(), vault(NATIVE_MINT, 400n * E9, TOKEN_PROGRAM_ID));
  accounts.set(COOK_POOL_PINS[1].solVault.toBase58(), vault(KEY(72), 2n * E9, TOKEN_2022_PROGRAM_ID));
  (connection as any).getTokenLargestAccounts = async () => ({ value: [{ address: holderAccount.toBase58(), amount: '900' }] });
  (connection as any).getMultipleAccountsInfo = async (keys: PublicKey[]) =>
    keys.map((k) => {
      if (k.equals(programDataAddress(new AeraClient({ connection }).programId))) {
        const d = Buffer.alloc(45);
        d.writeUInt32LE(3, 0);
        d[12] = 1;
        KEY(80).toBuffer().copy(d, 13);
        return info(d, KEY(81));
      }
      return accounts.get(k.toBase58()) ?? null;
    });
  const client = new AeraClient({ connection });
  const reserveAddress = id.reserve;
  (client as any).getObligations = async () => [
    { address: KEY(90), owner: holder, borrows: [{ reserve: reserveAddress, borrowedPrincipal: 250n, marketValue: 0n }] },
    { address: KEY(91), owner: KEY(92), borrows: [{ reserve: reserveAddress, borrowedPrincipal: 250n, marketValue: 0n }] },
  ];
  const report = await readSavingsReport(connection, client);
  assert.deepEqual(report.gaps, []);
  assert.equal(report.slot, 1n);
  assert.equal(report.stats.shareSupply, 1_000n);
  assert.equal(report.holders!.holders[0]!.owner, holder.toBase58());
  assert.equal(report.holders!.topShare, 0.9);
  assert.equal(report.borrowers!.count, 2);
  assert.equal(report.borrowers!.largestShare, 0.5);
  // The biggest holder also owes half the loans: found by matching the two lists, not by assumption.
  assert.equal(report.topHolderBorrows!.owner, holder.toBase58());
  assert.equal(report.topHolderBorrows!.share, 0.5);
  assert.equal(report.authority!.programUpgradeAuthority, KEY(80).toBase58());
  assert.equal(report.authority!.adminIsUpgradeAuthority, false);
  assert.equal(report.authority!.paramTimelockSeconds, 86_400);
  assert.equal(report.curve.length, 5);
  assert.equal(report.market!.totalCook, 1_000n * E9);
  assert.equal(report.market!.totalSol, 5n * E9);
  assert.equal(report.parSellImpactBps, sellImpactBps(report.stats.available, 1_000n * E9));

  // A read that fails is a named gap, and the rest of the report stands.
  (client as any).getObligations = async () => {
    throw new Error('getProgramAccounts is not allowed');
  };
  (connection as any).getTokenLargestAccounts = async () => {
    throw new Error('too many requests');
  };
  const partial = await readSavingsReport(connection, client);
  assert.equal(partial.borrowers, null);
  assert.equal(partial.holders, null);
  assert.equal(partial.topHolderBorrows, null);
  assert.equal(partial.gaps.length, 2);
  accounts.delete(COOK_POOL_PINS[1].solVault.toBase58());
  const noPools = await readSavingsReport(connection, client);
  assert.equal(noPools.market, null);
  assert.equal(noPools.parSellImpactBps, null);
  assert.equal(noPools.gaps.length, 3);
  accounts.set(COOK_POOL_PINS[1].solVault.toBase58(), vault(KEY(72), 2n * E9, TOKEN_2022_PROGRAM_ID));
  assert.match(partial.gaps.join(' '), /getProgramAccounts is not allowed/);
  assert.match(partial.gaps.join(' '), /too many requests/);
  assert.equal(partial.stats.shareSupply, 1_000n);
});

test('the report refuses a reserve it cannot read rather than inventing one', async () => {
  const { connection, accounts } = await zapFixture();
  accounts.delete(receiptIdentity('aCOOK').reserve.toBase58());
  await assert.rejects(readSavingsReport(connection), /not readable/);
});
