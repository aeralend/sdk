/**
 * Aera Perps on bCOOK (`AE5G6RFS…`) in the SDK against the golden vectors the
 * program's own tests produce (`protocol/perps-v2/perps-program/tests/golden.rs`,
 * `fixtures/perps-bcook-golden.json`): constants, discriminators, PDAs, the
 * settlement quote (band, fee fold, bCOOK's rate from the live stake-pool
 * bytes), conversions, opens and their refusals, worst-of marks, LP NAV at
 * both sides, the settlement capacity, account and event layouts, and every
 * isolated-market and pool-oracle instruction, exactly.
 *
 * The pool, wick-proof and referral sections are in perps-bcook-pool.test.ts.
 */
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';

import {
  COOK_MINT,
  LINEAR_TERMS,
  MARKETS_DISC,
  MARKETS_FEE_DESTINATION,
  PERPS_ADMIN,
  PERPS_BCOOK_MINT,
  PERPS_PROGRAM_ID,
  PERPS_STAKE_POOL,
  PERPS_STAKE_POOL_PROGRAM,
  PERPS_TOKEN_PROGRAM,
  POOL_ORACLE_SPACE,
  POOL_ORACLE_SPACE_V3,
  RETIRED_ASOL_PERPS_PROGRAM_ID,
  bcookQuote,
  bcookRate,
  bcookUsdValue,
  bookReserved,
  createLinearMarketIx,
  createPoolOracleIx,
  decodeFeedPrice,
  decodeLinearMarket,
  decodeLinearOrder,
  decodeMarketPositionOpened,
  decodePoolOracle,
  decodeStakePool,
  cookForBcook,
  marketsBcookAccount,
  poolTokensForDeposit,
  stakeForBcookIxs,
  feeDestinationAccount,
  feedPriceAccount,
  linearCancelIx,
  linearCheckpointIx,
  linearCloseMinimum,
  linearCollectIx,
  linearDepositShares,
  linearExecuteIx,
  linearFee,
  linearFundingRate,
  linearLiquidateIx,
  linearLpNav,
  linearMaintenance,
  linearMark,
  linearMarket,
  linearNavPnl,
  linearOpenQuote,
  linearOpenTerms,
  linearOrder,
  linearOutageCloseIx,
  linearOutageWithdrawIx,
  linearPriceAccount,
  linearSubmitIx,
  linearVault,
  lpFloorProblem,
  marginUsdMicros,
  maxCapThatFits,
  poolOracleAccount,
  postFeedPriceData,
  postPoolPriceIx,
  quoteAtSettle,
  setMarketLimitsIx,
  setPoolParamsIx,
  setPoolPinsIx,
  settleCapacity,
  settleOracleAccount,
  settlementBand,
  solPriceAccount,
  submitOrderData,
  type BcookQuote,
  type LinearPosition,
  type PoolPin,
  type PoolQuote,
} from '../src/index.js';

const FIXTURES = new URL('./fixtures/protocol/', import.meta.url);
const golden = JSON.parse(readFileSync(new URL('perps-bcook-golden.json', FIXTURES), 'utf8'));
const stakePoolFixture = JSON.parse(readFileSync(new URL('bcook-stake-pool-2026-10-22.json', FIXTURES), 'utf8'));
const bytes = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));
const B = (s: string | number) => BigInt(s);
const anchor = (ns: string, name: string) => createHash('sha256').update(`${ns}:${name}`).digest().subarray(0, 8).toString('hex');
type Ix = { keys: [string, boolean, boolean][]; data: string };
/** An instruction equals its golden vector: every account, signer and writable flag, in order, and the data. */
function same(actual: TransactionInstruction, expected: Ix, name: string) {
  assert.ok(actual.programId.equals(PERPS_PROGRAM_ID), `${name}: program`);
  assert.deepEqual(actual.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), expected.keys, `${name}: accounts`);
  assert.equal(Buffer.from(actual.data).toString('hex'), expected.data, `${name}: data`);
}
const NOW = 1_800_000_000;
const owner = new PublicKey(golden.order.owner);
const keeper = new PublicKey(golden.pool.ix.keeper);
const ADMIN = new PublicKey(golden.constants.admin);
const U64_MAX = 18_446_744_073_709_551_615n;

const engine = (e: Record<string, string | number>): BcookQuote => ({
  assetMicros: B(e.assetUsdMicros!), settleTwap: B(e.settleTwap!), settleLo: B(e.settleLo!), settleHi: B(e.settleHi!), rateE9: B(e.shareRateE9!),
});
const poolQuote = (p: Record<string, string | number>): PoolQuote => ({
  feed: String(p.feed), publishedAt: Number(p.publishedAt), twapUsdMicros: B(p.twapUsdMicros!), spotLoUsdMicros: B(p.spotLoUsdMicros!),
  spotHiUsdMicros: B(p.spotHiUsdMicros!), oiCapUsdMicros: B(p.oiCapUsdMicros!), previousPublishedAt: Number(p.previousPublishedAt),
});
/** The sample engine quote (BTC $82,000) with the post's open-interest ceiling. */
const Q: BcookQuote = { ...engine(golden.quote.engine), oiCapUsdMicros: B(golden.quote.poolQuote.oiCapUsdMicros) };
const position = (p: Record<string, string>, id = 0n, who = owner): LinearPosition => ({
  id, owner: who, side: p.side as 'long' | 'short', margin: B(p.margin!), notionalUsdMicros: B(p.notional!), entryPriceMicros: B(p.entryPrice!), profitCap: B(p.profitCap!), fundingEntry: 0n,
});

test('constants: program, bCOOK on classic SPL Token, stake pool, fee destination, floors', () => {
  const c = golden.constants;
  assert.equal(PERPS_PROGRAM_ID.toBase58(), golden.program);
  assert.equal(RETIRED_ASOL_PERPS_PROGRAM_ID.toBase58(), 'GqvG8aNWa8fJ8xuoPqqHbPiowVbX4GWm8gMPsSyFgJfq');
  assert.equal(PERPS_BCOOK_MINT.toBase58(), c.bcookMint);
  assert.equal(PERPS_TOKEN_PROGRAM.toBase58(), c.tokenProgram);
  assert.ok(PERPS_TOKEN_PROGRAM.equals(TOKEN_PROGRAM_ID), 'classic SPL Token, not Token-2022');
  assert.equal(ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), c.ataProgram);
  assert.equal(PERPS_STAKE_POOL.toBase58(), c.stakePool);
  assert.equal(PERPS_STAKE_POOL_PROGRAM.toBase58(), c.stakePoolProgram);
  assert.equal(PERPS_ADMIN.toBase58(), c.admin);
  assert.equal(MARKETS_FEE_DESTINATION.toBase58(), c.feeDestination);
  assert.equal(feeDestinationAccount().toBase58(), c.feeDestinationBcookAta);
  assert.equal(COOK_MINT.toBase58(), c.cookMint);
  assert.equal(LINEAR_TERMS.minLpDeposit.toString(), c.minLpDeposit);
  assert.equal(LINEAR_TERMS.maxWithdrawalFeeBps, c.maxWithdrawalFeeBps);
  assert.equal(LINEAR_TERMS.maxRateEpochsOld, B(c.maxRateEpochsOld));
  assert.equal(LINEAR_TERMS.maxPriceAgeSeconds, c.maxPriceAgeSeconds);
  assert.equal(LINEAR_TERMS.settleOutageGraceSeconds, c.settleOutageGraceSeconds);
  assert.equal(LINEAR_TERMS.assetOutageSeconds, c.assetOutageSeconds);
  assert.equal(LINEAR_TERMS.minFillDelaySeconds, c.minFillDelaySeconds);
  assert.equal(LINEAR_TERMS.maxFillDelaySeconds, c.maxFillDelaySeconds);
  assert.equal(LINEAR_TERMS.feeBps, B(c.feeBps));
  assert.equal(LINEAR_TERMS.minNotionalUsdMicros.toString(), c.minNotional);
  assert.equal(POOL_ORACLE_SPACE, c.poolOracleSpace);
  assert.equal(c.orderSpace, 200);
  assert.equal(c.bcookDecimals, 9);
});

test('discriminators match Anchor and the program', () => {
  for (const [name, h] of Object.entries(golden.instructions as Record<string, string>)) {
    assert.equal(anchor('global', name), h, name);
    assert.equal(Buffer.from((MARKETS_DISC as Record<string, number[]>)[name]!).toString('hex'), h, name);
  }
  for (const [name, h] of Object.entries(golden.accounts as Record<string, string>)) {
    assert.equal(anchor('account', name), h, name);
    assert.equal(Buffer.from((MARKETS_DISC as Record<string, number[]>)[name]!).toString('hex'), h, name);
  }
  assert.equal(anchor('event', 'MarketPositionOpened'), golden.events.MarketPositionOpened.discriminator);
  assert.equal(Buffer.from(MARKETS_DISC.MarketPositionOpened).toString('hex'), golden.events.MarketPositionOpened.discriminator);
  // The inverse SOL-PERP's instructions are not offered for the new program.
  for (const gone of ['initialize', 'set_paused', 'submit', 'execute', 'cancel', 'checkpoint', 'liquidate', 'outage_close', 'outage_withdraw', 'collect_protocol_fees', 'collect_bucket_fees']) {
    assert.equal((MARKETS_DISC as Record<string, unknown>)[gone], undefined, gone);
    assert.equal((golden.instructions as Record<string, unknown>)[gone], undefined, gone);
  }
});

test('addresses match the program: markets, vaults, prices, settle oracle, orders', () => {
  for (const feed of ['BTC', 'ETH', 'HYPE', 'SOL', 'MCOOK']) {
    assert.equal(linearMarket(feed).toBase58(), golden.pdas[feed].market, `${feed} market`);
    assert.equal(linearVault(feed).toBase58(), golden.pdas[feed].vault, `${feed} vault`);
    assert.equal(linearPriceAccount(feed).toBase58(), golden.pdas[feed].price, `${feed} price`);
  }
  assert.equal(solPriceAccount().toBase58(), golden.solPrice);
  assert.equal(linearPriceAccount('SOL').toBase58(), golden.solPrice, 'the linear SOL market reads ["price"]');
  assert.equal(feedPriceAccount('MCOOK').toBase58(), golden.pdas.MCOOK.price);
  assert.equal(settleOracleAccount().toBase58(), golden.settleOracle);
  assert.equal(poolOracleAccount('MCOOK').toBase58(), golden.settleOracle, 'the settlement price is the MCOOK pool oracle');
  const o = golden.order;
  assert.equal(linearOrder(new PublicKey(o.market), new PublicKey(o.owner), BigInt(o.nonce)).toBase58(), o.address);
  // The retired program's addresses differ (same seeds, other program).
  assert.notEqual(linearMarket('BTC', 'asol-v2').toBase58(), golden.pdas.BTC.market);
});

test('bCOOK’s rate from the live stake-pool bytes, as oracle::share_rate reads it', () => {
  const sp = golden.quote.stakePool;
  const data = Uint8Array.from(Buffer.from(stakePoolFixture.base64, 'base64'));
  assert.equal(data.length, golden.constants.stakePoolLength);
  const r = bcookRate(data, sp.epoch);
  assert.equal(r.grossE9.toString(), sp.grossE9);
  assert.equal(r.withdrawalFeeBps, sp.withdrawalFeeBps);
  const s = decodeStakePool(PERPS_STAKE_POOL, data, PERPS_STAKE_POOL_PROGRAM);
  assert.equal(s.totalLamports.toString(), sp.totalLamports);
  assert.equal(s.poolTokenSupply.toString(), sp.poolTokenSupply);
  assert.deepEqual(bcookRate(s), r);
  // One epoch old is fine; two is stale; a future update is refused.
  assert.doesNotThrow(() => bcookRate(data, sp.epoch + 1));
  assert.throws(() => bcookRate(data, sp.epoch + 2), /stale/);
  assert.throws(() => bcookRate(data, sp.epoch - 1), /stale/);
  // Funding hint: the fewest COOK whose DepositSol mints the bCOOK wanted, and the instructions.
  const want = 400_000n * 1_000_000_000n;
  const lamports = cookForBcook(want, s);
  assert.ok(poolTokensForDeposit(lamports, s) >= want && poolTokensForDeposit(lamports - 1n, s) < want);
  const ixs = stakeForBcookIxs(s, owner, lamports);
  assert.equal(ixs.length, 2);
  assert.ok(ixs[1]!.programId.equals(PERPS_STAKE_POOL_PROGRAM));
  assert.ok(ixs[1]!.keys[4]!.pubkey.equals(marketsBcookAccount(owner)), 'minted into the classic bCOOK ATA');
});

test('the settlement quote: band, fee folded into the low end, gross rate', () => {
  const pq = poolQuote(golden.quote.poolQuote);
  assert.equal(B(golden.quote.band.lo), pq.spotLoUsdMicros < pq.twapUsdMicros ? pq.spotLoUsdMicros : pq.twapUsdMicros);
  const rate = { grossE9: B(golden.quote.stakePool.grossE9), withdrawalFeeBps: golden.quote.stakePool.withdrawalFeeBps };
  assert.deepEqual(bcookQuote(B(golden.quote.engine.assetUsdMicros), pq, rate), Q);
  const pushed = golden.quote.pushed;
  assert.deepEqual(bcookQuote(B(pushed.engine.assetUsdMicros), poolQuote(pushed.poolQuote), rate), { ...engine(pushed.engine), oiCapUsdMicros: B(pushed.poolQuote.oiCapUsdMicros) });
  for (const f of golden.quote.fold as { feeBps: number; settleLo?: string; settleHi?: string; refused?: string }[]) {
    if (f.refused) { assert.throws(() => settlementBand(pq, f.feeBps), /refuses/, `${f.feeBps} bps`); continue; }
    const b = settlementBand(pq, f.feeBps);
    assert.deepEqual([b.lo.toString(), b.hi.toString()], [f.settleLo, f.settleHi], `${f.feeBps} bps`);
  }
  // The 80 bytes the oracle account holds at offset 8, including previous_published_at.
  const oracle = bytes(golden.samples.poolOracle);
  assert.equal(Buffer.from(oracle.subarray(8, 88)).toString('hex'), golden.quote.poolQuote.bytes);
  assert.deepEqual(decodePoolOracle(oracle).quote, pq);
  // Display at the TWAP: 1 bCOOK = rate COOK; a million COOK = $twap.
  assert.equal(bcookUsdValue(1_000_000n * 1_000_000_000n * 1_000_000_000n / Q.rateE9, Q) <= Q.settleTwap, true);
  assert.equal(bcookUsdValue(10n ** 15n, { settleTwap: Q.settleTwap, rateE9: 1_000_000_000n }), Q.settleTwap);
});

test('conversions: the fee and maintenance at the band’s low end, rounded up', () => {
  for (const r of golden.conversions.rows as { notional: string; fee: string; maintenance: string }[]) {
    assert.equal(linearFee(B(r.notional), Q).toString(), r.fee, `fee on ${r.notional}`);
    assert.equal(linearMaintenance(B(r.notional), Q).toString(), r.maintenance, `maintenance on ${r.notional}`);
  }
});

test('opens: the engine’s terms, the leverage refusal, the settlement capacity', () => {
  const o = golden.open;
  const lev = o.limits.maxLeverage;
  const request = { collateral: B(o.request.collateral), notional: B(o.request.notional), profitCap: B(o.request.profitCap) };
  const t = linearOpenTerms(request, Q, lev);
  assert.ok(!('error' in t));
  assert.deepEqual([t.openingFee.toString(), t.margin.toString(), t.profitCap.toString()], [o.openingFee, o.long.margin, o.long.profitCap]);
  assert.deepEqual(linearOpenTerms(request, Q, lev), t, 'a short opens on the same terms');
  assert.equal(o.short.margin, o.long.margin);
  assert.deepEqual(linearOpenTerms({ ...request, collateral: B(o.refusedLeverage.collateral) }, Q, lev), { error: o.refusedLeverage.error });
  // Capacity at the launch ceiling, at the band's high end.
  const capacity = settleCapacity({ oiCapUsdMicros: Q.oiCapUsdMicros!, settleHi: Q.settleHi, rateE9: Q.rateE9 });
  assert.equal(capacity.toString(), o.launchCapacity);
  assert.equal(o.refusedCapacity.capacity, o.launchCapacity);
  assert.ok(B(o.refusedCapacity.reservedAfter) > capacity, 'one $20 position’s full cap does not fit');
  const fits = linearOpenTerms({ ...request, profitCap: B(o.fitsCapacity.profitCapRequested) }, Q, lev);
  assert.ok(!('error' in fits) && fits.profitCap.toString() === o.fitsCapacity.profitCap);
  // The ticket offers the cap that fits: exactly the capacity on an empty book without a buffer.
  const market = decodeLinearMarket(bytes(golden.samples.market));
  const empty = { ...market, ledger: { ...market.ledger, positions: [] } };
  assert.equal(maxCapThatFits(empty, Q, null, 0n), capacity);
  assert.ok(maxCapThatFits(empty, Q)! < capacity, 'the default buffer allows for a higher post');
  assert.equal(maxCapThatFits(empty, { ...Q, oiCapUsdMicros: undefined }), null);
  assert.equal(maxCapThatFits(market, Q, null, 0n), 0n, 'the sample long’s cap already exceeds the launch capacity');
  assert.equal(bookReserved(market), market.ledger.positions[0]!.profitCap);
});

test('the ticket: sized against the band, held within the capacity, honest problems', () => {
  const market = decodeLinearMarket(bytes(golden.samples.market));
  const empty = { ...market, ledger: { ...market.ledger, positions: [] } };
  const quote = linearOpenQuote(empty, null, 'long', 20_000_000n, 2, Q);
  assert.equal(quote.problem, null);
  assert.equal(quote.collateral, quote.margin + quote.openingFee);
  assert.equal(quote.capacity, maxCapThatFits(empty, Q));
  assert.equal(quote.profitCap, quote.capacity, 'the capacity, not the margin, bounds the cap at launch');
  // It passes the program's own terms at a fill whose low end is 1% lower and high end 1% higher.
  const moved: BcookQuote = { ...Q, settleLo: (Q.settleLo * 99n) / 100n, settleHi: (Q.settleHi * 101n) / 100n };
  const t = linearOpenTerms({ collateral: quote.collateral, notional: 20_000_000n, profitCap: quote.profitCap }, moved, 2);
  assert.ok(!('error' in t), 'leverage holds at the lower end');
  assert.ok(!('error' in t) && t.profitCap === quote.profitCap, 'the cap is not clipped');
  assert.ok(!('error' in t) && t.profitCap <= settleCapacity({ oiCapUsdMicros: Q.oiCapUsdMicros!, settleHi: moved.settleHi, rateE9: Q.rateE9 }));
  for (const [n, lev] of [[10_000_000n, 1], [15_000_000n, 2], [20_000_000n, 2]] as const) {
    const q2 = linearOpenQuote(empty, null, 'short', n, lev, Q);
    assert.ok(marginUsdMicros(q2.collateral - linearFee(n, moved), moved) * BigInt(lev) >= n, `$${n} at ${lev}x`);
  }
  assert.match(linearOpenQuote(market, null, 'long', 20_000_000n, 2, Q).problem!, /settlement capacity is used up/);
  assert.match(linearOpenQuote(empty, null, 'long', 9_999_999n, 2, Q).problem!, /\$10/);
  assert.match(linearOpenQuote(empty, null, 'long', 20_000_001n, 2, Q).problem!, /caps a position at \$20\./);
  assert.ok(quote.liquidationPrice! < 82_000 && quote.liquidationPrice! > 30_000);
});

test('marks: worst-of PnL, fee and maintenance at the low end, liquidatable only at both ends', () => {
  const m = golden.marks;
  const pos = { long: position(m.positions.long), short: position(m.positions.short) };
  const quotes: Record<string, BcookQuote> = { 'quote.engine': engine(golden.quote.engine), 'quote.pushed.engine': engine(golden.quote.pushed.engine) };
  for (const c of m.cases as { name: string; position: 'long' | 'short'; quote: string; mark: Record<string, unknown> }[]) {
    const q = { ...quotes[c.quote]!, assetMicros: B(c.mark.asset as string) };
    const got = linearMark(pos[c.position], q, B(m.fundingIndex));
    const want = c.mark as { pnl: string; payable: string; closingFee: string; maintenance: string; liquidatable: boolean; profitCapReached: boolean; atLo: { pnl: string; payable: string; liquidatable: boolean }; atHi: { pnl: string; payable: string; liquidatable: boolean } };
    assert.deepEqual(
      [got.pnl.toString(), got.payable.toString(), got.closingFee.toString(), got.maintenance.toString(), got.liquidatable, got.profitCapReached],
      [want.pnl, want.payable, want.closingFee, want.maintenance, want.liquidatable, want.profitCapReached],
      c.name,
    );
    for (const [end, settle] of [['atLo', q.settleLo], ['atHi', q.settleHi]] as const) {
      const e = linearMark(pos[c.position], quoteAtSettle(q, settle), 0n);
      assert.deepEqual([e.pnl.toString(), e.payable.toString(), e.liquidatable], [want[end].pnl, want[end].payable, want[end].liquidatable], `${c.name} ${end}`);
    }
  }
});

test('LP NAV: positions at their worst end for a deposit, their best for a withdrawal', () => {
  const n = golden.nav;
  const ledger = { ...decodeLinearMarket(bytes(golden.samples.market)).ledger };
  const positions = [position(golden.open.long, 0n), position(golden.open.short, 1n)];
  const books = { ...ledger, lpCash: B(n.lpCash), lpShareSupply: B(n.lp.shares), positions, fundingIndex: 0n, fundingRate: 0n, fundingTime: B(NOW + 2), fundingValidUntil: B(NOW + 92) };
  const now = B(golden.marks.now);
  for (const r of n.rows as { asset: string; deposit: { pnl: string; nav: string }; withdraw: { pnl: string; nav: string } }[]) {
    const q = { ...Q, assetMicros: B(r.asset) };
    for (const side of ['deposit', 'withdraw'] as const) {
      const pnl = positions.reduce((s, p) => s + linearNavPnl(p, q, 0n, side), 0n);
      assert.equal(pnl.toString(), r[side].pnl, `${side} pnl at ${r.asset}`);
      assert.equal(linearLpNav(books, q, now, side).toString(), r[side].nav, `${side} NAV at ${r.asset}`);
    }
  }
  const depositNav = B(n.rows[0].deposit.nav);
  assert.equal(linearDepositShares(books, B(n.secondDeposit.amount), depositNav).toString(), n.secondDeposit.shares);
  assert.equal(n.lp.deposit, n.lp.shares, '1:1 into an empty market');
  // The 10,000 bCOOK floor (`Accounting` / the engine's InvalidAmount).
  assert.equal(n.belowFloor.error, 'InvalidAmount');
  assert.match(lpFloorProblem({ kind: 'deposit', amount: B(n.belowFloor.amount) })!, /10,000 bCOOK/);
  assert.equal(lpFloorProblem({ kind: 'deposit', amount: LINEAR_TERMS.minLpDeposit }), null);
  assert.match(lpFloorProblem({ kind: 'withdraw', shares: 395_000n * 10n ** 9n, balance: 400_000n * 10n ** 9n, nav: depositNav, supply: B(n.lp.shares) })!, /leave at least/);
  assert.equal(lpFloorProblem({ kind: 'withdraw', shares: 400_000n * 10n ** 9n, balance: 400_000n * 10n ** 9n, nav: depositNav, supply: B(n.lp.shares) }), null, 'all of it');
});

test('the settlement capacity: oiCap × 1e24 / (bandHi × rate), floored', () => {
  for (const r of golden.capacity.rows as Record<string, string>[]) {
    const pq = { twapUsdMicros: B(r.twap!), spotLoUsdMicros: B(r.spotLo!), spotHiUsdMicros: B(r.spotHi!) };
    const band = settlementBand(pq, 0);
    assert.equal(band.hi.toString(), r.bandHi);
    assert.equal(settleCapacity({ oiCapUsdMicros: B(r.oiCap!), settleHi: band.hi, rateE9: B(r.rateE9!) }).toString(), r.capacity, `${r.oiCap} at ${r.bandHi}`);
  }
});

test('account samples decode field by field; funding is scheduled at the TWAP', () => {
  const s = golden.samples;
  const m = decodeLinearMarket(bytes(s.market));
  assert.equal(m.feed, 'BTC');
  assert.equal(m.price.toBase58(), golden.pdas.BTC.price);
  assert.equal(m.vault.toBase58(), golden.pdas.BTC.vault);
  assert.equal(m.paused, false);
  assert.equal(m.pending, 123n);
  assert.equal(new DataView(bytes(s.market).buffer).getUint32(114, true), s.marketLedgerLength);
  assert.deepEqual(m.ledger.limits, { maxNotionalUsdMicros: B(golden.open.limits.maxNotionalUsdMicros), maxPositions: golden.open.limits.maxPositions, maxLeverage: golden.open.limits.maxLeverage });
  assert.equal(m.ledger.lpCash.toString(), s.lpCash);
  assert.equal(m.ledger.pool, null);
  const p = m.ledger.positions[0]!;
  assert.deepEqual([p.side, p.margin.toString(), p.profitCap.toString(), p.fundingEntry.toString(), p.notionalUsdMicros, p.entryPriceMicros], ['long', s.position.margin, s.position.profitCap, s.position.fundingEntry, 20_000_000n, 82_000_000_000n]);
  assert.ok(p.owner.equals(owner));
  assert.deepEqual([m.ledger.protocolFees, m.ledger.insuranceFees, m.ledger.holderFees].map(String), s.fees);
  assert.equal(m.ledger.fundingRate.toString(), s.fundingRate);
  assert.equal(linearFundingRate(m.ledger.positions, Q).toString(), s.fundingRate);
  assert.equal(linearFundingRate([...m.ledger.positions, { ...p, side: 'short' }], Q), 0n, 'balanced books pay no funding');
  assert.equal(m.ledger.lastPublication, B(NOW));

  const o = decodeLinearOrder(new PublicKey(golden.order.address), bytes(s.order));
  assert.ok(o.market.equals(linearMarket('BTC')) && o.owner.equals(owner));
  assert.deepEqual(o.action, { kind: 'open', long: true, collateral: B(golden.open.request.collateral), notional: 20_000_000n, profitCap: B(golden.open.request.profitCap) });
  assert.deepEqual([o.nonce, o.createdAt, o.createdSlot, o.deadline, o.minPrice, o.maxPrice, o.active, o.version, o.referrer], [42n, NOW, 77n, NOW + 40, 1n, 100_000_000_000n, true, 1, null]);
  assert.deepEqual(decodeFeedPrice(bytes(s.feedPrice)), { feed: 'BTC', priceUsdMicros: 82_612_331_436n, publishedAt: 1_791_833_380, signers: 5, previousPublishedAt: null, previousPriceMicros: null });

  const oracleBytes = bytes(s.poolOracle);
  assert.ok(oracleBytes.length <= POOL_ORACLE_SPACE);
  // Serialized: the v3 account plus the cumulative (u128 + i64) and the empty pending option; the account is padded to POOL_ORACLE_SPACE.
  assert.equal(s.poolOracleSerializedLength, POOL_ORACLE_SPACE_V3 + 16 + 8 + 1);
  const oracle = decodePoolOracle(oracleBytes);
  assert.deepEqual(oracle.quote, poolQuote(golden.quote.poolQuote));
  assert.ok(oracle.tokenMint.equals(COOK_MINT));
  assert.deepEqual(oracle.params, { twapWindowS: 3_600, spacingS: 120, stepBps: 100, maxDevBps: 300, minPoolDepth: 100_000_000n, minSamples: 15, minSpanS: 1_800, oiShareBps: 1_250 });
  assert.deepEqual(oracle.samples.map((x) => [x.at, x.depth]), [[NOW - 240, 520_000_000n], [NOW - 120, 520_000_000n], [NOW, 520_000_000n]]);
  assert.equal(decodePoolOracle(oracleBytes, 'bcook').quote.previousPublishedAt, NOW - 10);

  const e = decodeMarketPositionOpened(bytes(golden.events.MarketPositionOpened.sample));
  assert.ok(e.market.equals(linearMarket('BTC')) && e.owner.equals(owner));
  assert.deepEqual([e.position, e.long, e.notional, e.profitCap.toString(), e.price, e.settlePrice.toString()], [0n, true, 20_000_000n, s.position.profitCap, 82_000_000_000n, golden.events.MarketPositionOpened.settlePrice]);
});

test('instruction data is byte-identical', () => {
  const d = golden.data;
  const open = { kind: 'open' as const, long: true, collateral: B(golden.open.request.collateral), notional: 20_000_000n, profitCap: B(golden.open.request.profitCap) };
  assert.equal(Buffer.from(submitOrderData(42n, open, NOW + 40, 1n, 100_000_000_000n)).toString('hex'), d.submitOrder);
  const snap = JSON.parse(readFileSync(new URL('redstone-multi-0.json', FIXTURES), 'utf8'));
  const pk = snap.feeds.BTC.slice(0, 5).map((x: { value: string; timestampMs: number; signature: string }) => ({ value: BigInt(x.value), timestampMs: x.timestampMs, signature: bytes(x.signature) }));
  assert.equal(Buffer.from(postFeedPriceData('BTC', pk)).toString('hex'), d.postFeedPriceBtcSnapshot0);
  const limits = { maxNotionalUsdMicros: 20_000_000n, maxPositions: 8, maxLeverage: 2 };
  assert.equal(setMarketLimitsIx(ADMIN, 'BTC', limits).data.toString('hex'), d.setMarketLimits);
  assert.equal(d.postPoolPrice, Buffer.from(MARKETS_DISC.post_pool_price).toString('hex'));
});

test('isolated-market and pool-oracle instructions are byte-identical (COOK-PERP)', () => {
  const x = golden.ix;
  const order = linearOrder(linearMarket('MCOOK'), owner, 42n);
  same(createLinearMarketIx(ADMIN, 'MCOOK', { maxNotionalUsdMicros: 15_000_000n, maxPositions: 4, maxLeverage: 2 }), x.createCookPerp, 'create_market MCOOK');
  const open = { kind: 'open' as const, long: true, collateral: B(golden.open.request.collateral), notional: 15_000_000n, profitCap: B(golden.open.request.profitCap) };
  same(linearSubmitIx('MCOOK', owner, 42n, open, NOW + 40 - 55, 1n, U64_MAX), x.submitOrderCookPerp, 'submit_order MCOOK');
  same(linearCancelIx('MCOOK', owner, order), x.cancelOrderCookPerp, 'cancel_order');
  same(linearExecuteIx('MCOOK', order, owner), x.executeOrderCookPerp, 'execute_order: the oracle appended');
  same(linearLiquidateIx('MCOOK', keeper, 3n, owner), x.liquidateCookPerp, 'liquidate_market');
  same(linearOutageCloseIx('MCOOK', 3n, owner), x.outageCloseCookPerp, 'outage_close_market');
  same(linearOutageWithdrawIx('MCOOK', owner, 123_456n), x.outageWithdrawCookPerp, 'outage_withdraw_market');
  same(linearCheckpointIx('MCOOK'), x.checkpointCookPerp, 'checkpoint_market');
  same(linearCollectIx('MCOOK'), x.collectMarketFeesCookPerp, 'collect_market_fees');
  same(linearCollectIx('MCOOK', true), x.collectMarketBucketFeesCookPerp, 'collect_market_bucket_fees');
  // The settle and stake-pool slots, where the retired program had ["price"] and the SOL reserve.
  const exec = linearExecuteIx('MCOOK', order, owner);
  assert.ok(exec.keys[7]!.pubkey.equals(settleOracleAccount()) && exec.keys[8]!.pubkey.equals(PERPS_STAKE_POOL));
  assert.ok(exec.keys[5]!.pubkey.equals(TOKEN_PROGRAM_ID) && exec.keys[4]!.pubkey.equals(PERPS_BCOOK_MINT));

  const oracle = decodePoolOracle(bytes(golden.samples.poolOracle));
  const pins = oracle.pins as [PoolPin, PoolPin];
  same(createPoolOracleIx(ADMIN, 'MCOOK', COOK_MINT, pins, oracle.params), x.createPoolOracleMcook, 'create_pool_oracle');
  assert.equal(createPoolOracleIx(ADMIN, 'MCOOK', COOK_MINT, pins, oracle.params).data.toString('hex'), golden.data.createPoolOracle);
  same(setPoolParamsIx(ADMIN, 'MCOOK', oracle.params), x.setPoolParamsMcook, 'set_pool_params');
  same(setPoolPinsIx(ADMIN, 'MCOOK', pins), x.setPoolPinsMcook, 'set_pool_pins');
  same(postPoolPriceIx('MCOOK', keeper, pins), x.postPoolPriceMcook, 'post_pool_price');
});

test('a close floor holds across a widened band', () => {
  const p = position(golden.open.long);
  const at = { ...Q, assetMicros: 89_100_000_000n };
  const floor = linearCloseMinimum(p, at.assetMicros, Q, 0n);
  for (const [lo, hi] of [[99n, 101n], [100n, 100n], [99n, 100n], [100n, 101n]] as const) {
    const q = { ...at, settleLo: (Q.settleLo * lo) / 100n, settleHi: (Q.settleHi * hi) / 100n };
    assert.ok(linearMark(p, q, 0n).payable >= floor, `band ${lo}/${hi}`);
  }
  assert.ok(floor > 0n && floor <= linearMark(p, at, 0n).payable);
});
