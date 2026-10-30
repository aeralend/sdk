/**
 * The bCOOK program's shared LP pool, Wick-proof positions and referrals in
 * the SDK against the golden vectors (`golden.rs`: `pool`, `wick`,
 * `referral`): layouts, NAV over members at both band ends, each member's
 * capacity, every pool and member instruction as the keeper sends it, the
 * wick trailer and prepaid fee at the bCOOK launch rates, the v3 order with
 * a referrer paid into its CLASSIC bCOOK ATA, and a 50% partial close.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';

import {
  LINEAR_TERMS,
  PARTIAL_CLOSE_PRESETS,
  PERPS_BCOOK_MINT,
  PERPS_PROGRAM_ID,
  POOL_MEMBER_FEEDS,
  REFERRAL_TERMS,
  createLinearMarketIx,
  createLpPoolIx,
  decodeLinearMarket,
  decodeLinearOrder,
  decodeLpPool,
  effectiveReferrer,
  encodeLinearAction,
  joinLpPoolIx,
  linearCheckpointIx,
  linearExecuteIx,
  linearFeeSplit,
  linearFreeCash,
  linearFundingIndex,
  linearLiquidateIx,
  linearMark,
  linearMarket,
  linearOpenQuote,
  linearOpenTerms,
  linearOrder,
  linearOutageCloseIx,
  linearPartialClose,
  linearPriceAccount,
  linearSettleWickIx,
  linearSplitPosition,
  linearSubmitIx,
  linearVault,
  bookReserved,
  maxCapThatFits,
  lpPoolAccount,
  lpPoolVault,
  marketsBcookAccount,
  partialNotional,
  poolExecuteIx,
  poolFreeCash,
  poolMemberAccounts,
  poolMemberCapacity,
  poolMemberLimit,
  poolNav,
  poolOrder,
  poolOutageWithdrawIx,
  poolSubmitIx,
  poolUnrealizedPnl,
  referralShare,
  setLpPoolMemberLimitIx,
  setLpPoolPausedIx,
  setMarketPausedIx,
  setWickConfigIx,
  submitOrderData,
  submitPoolOrderData,
  wickFee,
  wickOffered,
  wickOpenQuote,
  wickSplit,
  type BcookQuote,
  type LinearPosition,
} from '../src/index.js';

const golden = JSON.parse(readFileSync(new URL('./fixtures/protocol/perps-bcook-golden.json', import.meta.url), 'utf8'));
const pool = golden.pool;
const ix = pool.ix;
const wick = golden.wick;
const ref = golden.referral;
const bytes = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));
const B = (s: string | number) => BigInt(s);
type Ix = { keys: [string, boolean, boolean][]; data: string };
function same(actual: TransactionInstruction, expected: Ix, name: string) {
  assert.ok(actual.programId.equals(PERPS_PROGRAM_ID), `${name}: program`);
  assert.deepEqual(actual.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), expected.keys, `${name}: accounts`);
  assert.equal(Buffer.from(actual.data).toString('hex'), expected.data, `${name}: data`);
}
const NOW = 1_800_000_000;
const ADMIN = new PublicKey(golden.constants.admin);
const owner = new PublicKey(ix.owner);
const keeper = new PublicKey(ix.keeper);
const BCOOK1 = 1_000_000_000n;
const U64_MAX = 18_446_744_073_709_551_615n;
const e = golden.quote.engine;
const Q: BcookQuote = { assetMicros: B(e.assetUsdMicros), settleTwap: B(e.settleTwap), settleLo: B(e.settleLo), settleHi: B(e.settleHi), rateE9: B(e.shareRateE9), oiCapUsdMicros: B(golden.quote.poolQuote.oiCapUsdMicros) };

// --- the shared pool --------------------------------------------------------------------

test('pool addresses match the program', () => {
  assert.equal(lpPoolAccount(0).toBase58(), pool.address);
  assert.equal(lpPoolVault(lpPoolAccount(0)).toBase58(), pool.vault);
  assert.equal(linearMarket('SOL').toBase58(), pool.solMarket.market);
  assert.equal(linearVault('SOL').toBase58(), pool.solMarket.vault);
  assert.equal(linearPriceAccount('SOL').toBase58(), pool.solMarket.price);
  assert.equal(poolOrder(owner, 42n).toBase58(), pool.order.address);
  assert.equal(linearOrder(lpPoolAccount(0), owner, 42n).toBase58(), pool.order.address);
  assert.deepEqual([...POOL_MEMBER_FEEDS], ix.members, 'the member order init.mjs joins');
});

test('an LpPoolState and a member market decode field by field', () => {
  const p = decodeLpPool(bytes(pool.sample));
  assert.deepEqual([p.id, p.vault.toBase58(), p.paused, p.pending], [0, pool.vault, false, 0n]);
  assert.equal(new DataView(bytes(pool.sample).buffer).getUint32(51, true), pool.sampleLedgerLength);
  assert.equal(p.ledger.lpCash.toString(), pool.sampleLpCash);
  assert.equal(p.ledger.lpShareSupply.toString(), pool.sampleShareSupply);
  assert.equal(p.ledger.lpBalances.get(pool.sampleLp)?.toString(), pool.sampleLpShares);
  assert.deepEqual(p.members.map((m) => m.market.toBase58()), pool.sampleMembers);
  assert.deepEqual(p.members.map((m) => m.reserved.toString()), pool.sampleReserved);
  assert.deepEqual(p.members.map((m) => m.maxReserveBps), [2_500, 2_500]);
  const m = decodeLinearMarket(bytes(pool.memberMarket));
  assert.equal(m.feed, 'BTC');
  assert.deepEqual(m.ledger.pool && { pool: m.ledger.pool.pool.toBase58(), member: m.ledger.pool.member }, { pool: pool.address, member: 0 });
  assert.deepEqual([m.ledger.lpCash, m.ledger.lpShareSupply, m.ledger.positions.length], [0n, 0n, 1]);
  assert.equal(m.ledger.positions[0]!.margin.toString(), pool.memberPosition.margin);
  assert.equal(m.ledger.positions[0]!.profitCap.toString(), pool.memberPosition.profitCap);
  assert.equal(new DataView(bytes(pool.memberMarket).buffer).getUint32(114, true), pool.memberLedgerLength);
  assert.equal(m.ledger.wick, null);
});

test('pool NAV at both band ends; free cash and each member’s capacity', () => {
  const p = decodeLpPool(bytes(pool.sample));
  const btc = decodeLinearMarket(bytes(pool.memberMarket));
  const sol = { ...btc.ledger, positions: [] };
  const now = B(NOW + 2);
  for (const at of [pool.navAt90200, pool.navAt75000]) {
    const members = [{ ledger: btc.ledger, quote: { ...Q, assetMicros: B(at.asset) } }, { ledger: sol, quote: null }];
    for (const side of ['deposit', 'withdraw'] as const) {
      assert.equal(poolUnrealizedPnl(members, now, side)?.toString(), at[side].pnl, `${side} PnL at ${at.asset}`);
      assert.equal(poolNav(p.ledger, members, now, side)?.toString(), at[side].nav, `${side} NAV at ${at.asset}`);
    }
    assert.ok(B(at.deposit.nav) >= B(at.withdraw.nav), 'a deposit is priced at the higher NAV');
  }
  assert.equal(poolNav(p.ledger, [{ ledger: btc.ledger, quote: null }], now), null, 'no price, no NAV');
  assert.equal(poolFreeCash(p).toString(), pool.sampleFreeCash);
  pool.sampleCapacity.forEach((c: { limit: string; capacity: string }, i: number) => {
    assert.equal(poolMemberLimit(p, i).toString(), c.limit, `member ${i} limit`);
    assert.equal(poolMemberCapacity(p, i).toString(), c.capacity, `member ${i} capacity`);
  });
  assert.equal(linearFreeCash(btc.ledger, p).toString(), pool.sampleCapacity[0].capacity);
  assert.equal(linearFreeCash(btc.ledger), 0n);
  // A member's ticket: the pool backs it, the settlement capacity (the WHOLE pool's reserves) bounds it.
  const q = linearOpenQuote(btc, null, 'long', 20_000_000n, 2, Q, p);
  assert.equal(q.problem, null);
  assert.equal(q.capacity, maxCapThatFits(btc, Q, p));
  assert.equal(q.profitCap, q.capacity, 'the launch capacity, less what the pool reserves, bounds the cap');
  assert.equal(bookReserved(btc, p), p.members.reduce((s, m) => s + m.reserved, 0n), 'a member’s book is the whole pool');
  const crowded = { ...p, members: p.members.map((m, i) => (i === 1 ? { ...m, reserved: 50_000n * BCOOK1 } : m)) };
  assert.match(linearOpenQuote(btc, null, 'long', 20_000_000n, 2, Q, crowded).problem!, /settlement capacity is used up/, 'another member’s caps count too');
  const roomy = { ...Q, oiCapUsdMicros: 100_000_000n };
  const ok = linearOpenQuote(btc, null, 'long', 20_000_000n, 2, roomy, p);
  assert.equal(ok.problem, null);
  assert.ok(ok.profitCap <= ok.margin && ok.profitCap <= poolMemberCapacity(p, 0));
  assert.match(linearOpenQuote(btc, null, 'long', 20_000_000n, 2, roomy, { ...p, paused: true }).problem!, /pool is paused/);
});

test('pool LP instructions are byte-identical', () => {
  const members = poolMemberAccounts({ members: ix.members.map((f: string) => ({ market: linearMarket(f), reserved: 0n, maxReserveBps: 2_500 })) });
  assert.deepEqual(members.map((m) => m.feed), ix.members);
  same(poolSubmitIx(owner, 42n, { kind: 'deposit', amount: 400_000n * BCOOK1, minimum: 1n }, NOW + 40 - 55), ix.submitPoolOrder, 'submit_pool_order deposit');
  same(poolSubmitIx(owner, 42n, { kind: 'withdraw', shares: 100_000n * BCOOK1, minimum: 99_000n * BCOOK1 }, NOW), ix.submitPoolWithdraw, 'submit_pool_order withdraw');
  assert.equal(Buffer.from(submitPoolOrderData(42n, { kind: 'deposit', amount: 400_000n * BCOOK1, minimum: 1n }, NOW + 40)).toString('hex'), pool.submitPoolOrder);
  same(poolExecuteIx(poolOrder(owner, 42n), owner, members), ix.executePoolOrder, 'execute_pool_order');
  same(poolOutageWithdrawIx(owner, 123_456n, members), ix.outageWithdrawPool, 'outage_withdraw_pool');
  assert.throws(() => poolMemberAccounts(decodeLpPool(bytes(pool.sample)), ['BTC']), /not a known market/);
});

test('member instructions append the pool accounts; admin instructions match', () => {
  const link = lpPoolAccount(0);
  for (const [feed, F] of [['BTC', 'Btc'], ['SOL', 'Sol']] as const) {
    const order = linearOrder(linearMarket(feed), owner, 42n);
    same(linearExecuteIx(feed, order, owner, link), ix[`memberExecuteOrder${F}`], `${feed} execute_order`);
    same(linearLiquidateIx(feed, keeper, 7n, owner, link), ix[`memberLiquidate${F}`], `${feed} liquidate_market`);
    same(linearOutageCloseIx(feed, 7n, owner, link), ix[`memberOutageClose${F}`], `${feed} outage_close_market`);
  }
  same(linearCheckpointIx('SOL'), ix.checkpointSol, 'SOL checkpoint_market');
  same(createLinearMarketIx(ADMIN, 'SOL', { maxNotionalUsdMicros: 20_000_000n, maxPositions: 8, maxLeverage: 2 }), ix.createSolMarket, 'create_market SOL');
  same(createLpPoolIx(ADMIN, 0), ix.createLpPool, 'create_lp_pool');
  same(joinLpPoolIx(ADMIN, 'BTC', 2_500), ix.joinLpPoolBtc, 'join_lp_pool BTC');
  same(joinLpPoolIx(ADMIN, 'SOL', 2_500), ix.joinLpPoolSol, 'join_lp_pool SOL');
  same(setLpPoolPausedIx(ADMIN, false), ix.setLpPoolPaused, 'set_lp_pool_paused');
  same(setLpPoolMemberLimitIx(ADMIN, 2, 6_000), ix.setLpPoolMemberLimit, 'set_lp_pool_member_limit');
  same(setMarketPausedIx(ADMIN, 'HYPE', true), ix.pauseMarketHype, 'set_market_paused');
});

// --- wick-proof ---------------------------------------------------------------------------

test('a member market decodes its wick trailer at the bCOOK launch rate', () => {
  const m = decodeLinearMarket(bytes(wick.memberMarket));
  assert.equal(new DataView(bytes(wick.memberMarket).buffer).getUint32(114, true), wick.memberLedgerLength);
  assert.deepEqual(m.ledger.wick, wick.terms);
  const p = m.ledger.positions[0]!;
  assert.equal(p.id, B(wick.position.id));
  assert.equal(p.margin.toString(), wick.position.margin);
  assert.equal(p.profitCap.toString(), wick.position.profitCap);
  assert.deepEqual(p.wick, { openedAt: wick.position.openedAt, expiresAt: wick.position.expiresAt, prepaid: B(wick.position.prepaid), rate: wick.position.rate, takeProfit: wick.position.takeProfit });
  assert.ok(wickOffered(m));
  // Launch: paused (max_positions 0).
  const paused = { ...m, ledger: { ...m.ledger, wick: { ...m.ledger.wick!, maxPositions: 0 } } };
  assert.equal(wickOffered(paused), false);
  assert.match(wickOpenQuote(paused, null, 'long', 20_000_000n, 5, 100, 86_400, Q, decodeLpPool(bytes(pool.sample))).problem!, /paused/);
});

test('the prepaid fee, its split over time, the open terms and the mark match the engine', () => {
  for (const f of wick.fees as { notional: string; rate: number; seconds: number; prepaid: string }[]) {
    assert.equal(wickFee(B(f.notional), f.rate, f.seconds, Q).toString(), f.prepaid, `${f.rate} for ${f.seconds} s`);
  }
  const m = decodeLinearMarket(bytes(wick.memberMarket));
  const p = m.ledger.positions[0]!;
  for (const s of wick.splits as { elapsed: number; earned: string; refund: string }[]) {
    const { earned, refund } = wickSplit(p.wick!, wick.position.openedAt + s.elapsed);
    assert.deepEqual([earned.toString(), refund.toString()], [s.earned, s.refund], `after ${s.elapsed} s`);
  }
  const prepaid = wickFee(20_000_000n, 180, 86_400, Q);
  const t = linearOpenTerms({ collateral: 80_000n * BCOOK1, notional: 20_000_000n, profitCap: 60_000n * BCOOK1 }, Q, 5, prepaid);
  assert.ok(!('error' in t));
  assert.deepEqual([t.openingFee.toString(), prepaid.toString(), t.margin.toString(), t.profitCap.toString()], [wick.openQuote.openingFee, wick.openQuote.prepaid, wick.openQuote.margin, wick.openQuote.profitCap]);
  const mark = linearMark(p, { ...Q, assetMicros: 72_000_000_000n }, linearFundingIndex(m.ledger, B(NOW + 2)));
  assert.deepEqual([mark.pnl.toString(), mark.payable.toString(), mark.liquidatable], [wick.markAt72000.pnl, wick.markAt72000.payable, wick.markAt72000.liquidatable]);
});

test('the OpenWick order and the wick instructions are byte-identical', () => {
  const action = { kind: 'openWick' as const, long: true, collateral: 80_000n * BCOOK1, notional: 20_000_000n, profitCap: 60_000n * BCOOK1, durationSeconds: 86_400, takeProfit: true };
  assert.equal(Buffer.from(submitOrderData(42n, action, NOW + 55, 1n, 100_000_000_000n)).toString('hex'), wick.submitOrderOpenWick);
  assert.equal(encodeLinearAction(action)[0], 4);
  const o = decodeLinearOrder(linearOrder(linearMarket('BTC'), owner, 42n), bytes(wick.order));
  assert.deepEqual(o.action, action);
  assert.deepEqual([o.createdAt, o.deadline, o.active, o.referrer], [NOW, NOW + 55, true, null]);
  const link = lpPoolAccount(0);
  same(linearSettleWickIx('BTC', 7n, owner, link, false), wick.ix.expireBtc, 'expire BTC');
  same(linearSettleWickIx('BTC', 7n, owner, link, true), wick.ix.takeProfitBtc, 'take-profit BTC');
  same(linearSettleWickIx('SOL', 7n, owner, link, false), wick.ix.expireSol, 'expire SOL');
  same(linearOutageCloseIx('BTC', 7n, owner, link, true), wick.ix.outageCloseWickBtc, 'wick outage unwind');
  same(setWickConfigIx(ADMIN, 'HYPE', { ...wick.terms, rate: 280, maxPositions: 0 }), wick.ix.setWickConfigHype, 'set wick terms: SOL/HYPE 280, paused');
});

// --- referrals and partial closes -----------------------------------------------------------

test('a v3 order decodes its referrer and partial close; a legacy order has none', () => {
  const o = decodeLinearOrder(new PublicKey(golden.order.address), bytes(ref.orderReferredClosePart));
  assert.deepEqual(o.action, { kind: 'closePart', position: 7n, minimum: 123_456n, notional: 10_000_000n });
  assert.equal(o.version, REFERRAL_TERMS.orderVersion);
  assert.equal(ref.orderVersion, REFERRAL_TERMS.orderVersion);
  assert.equal(o.referrer?.toBase58(), ref.referrer);
  assert.deepEqual([o.deadline, o.maxPrice], [NOW + 55, U64_MAX]);
  const legacy = decodeLinearOrder(new PublicKey(golden.order.address), bytes(ref.orderLegacy));
  assert.equal(bytes(ref.orderLegacy).length, 200);
  assert.deepEqual([legacy.version, legacy.referrer, legacy.deadline], [0, null, NOW + 56]);
  assert.deepEqual(legacy.action, { kind: 'open', long: false, collateral: B(golden.open.request.collateral), notional: 20_000_000n, profitCap: B(golden.open.request.profitCap) });
});

test('submit_order with and without a referrer; the referrer’s CLASSIC bCOOK ATA is appended at fills', () => {
  const referrer = new PublicKey(ref.referrer);
  const open = { kind: 'open' as const, long: true, collateral: B(golden.open.request.collateral), notional: 20_000_000n, profitCap: B(golden.open.request.profitCap) };
  assert.equal(Buffer.from(submitOrderData(42n, open, NOW + 55, 1n, U64_MAX)).toString('hex'), ref.submitOrderOpenNoReferrer);
  assert.equal(Buffer.from(submitOrderData(42n, open, NOW + 55, 1n, U64_MAX, referrer)).toString('hex'), ref.submitOrderOpenReferred);
  const part = { kind: 'closePart' as const, position: 7n, minimum: 123_456n, notional: 10_000_000n };
  assert.equal(Buffer.from(submitOrderData(42n, part, NOW + 55, 1n, U64_MAX, referrer)).toString('hex'), ref.submitOrderClosePart);
  assert.equal(linearSubmitIx('BTC', owner, 42n, open, NOW, 1n, U64_MAX, referrer).data.toString('hex'), ref.submitOrderOpenReferred);
  assert.equal(linearSubmitIx('BTC', owner, 42n, open, NOW, 1n, U64_MAX, owner).data.toString('hex'), ref.submitOrderOpenNoReferrer, 'no self-referral');
  assert.equal(linearSubmitIx('MCOOK', owner, 42n, { kind: 'deposit', amount: 1n, minimum: 1n }, NOW, 1n, U64_MAX, referrer).data.length, 8 + 8 + 17 + 24, 'no referrer on an LP order');
  assert.equal(effectiveReferrer(PublicKey.default, owner), null);

  assert.equal(marketsBcookAccount(referrer).toBase58(), ref.referrerAta);
  assert.equal(getAssociatedTokenAddressSync(PERPS_BCOOK_MINT, referrer, true, TOKEN_PROGRAM_ID).toBase58(), ref.referrerAta);
  const order = new PublicKey(ref.memberExecuteOrderBtcReferred.keys[0][0]);
  same(linearExecuteIx('BTC', order, owner, lpPoolAccount(0), referrer), ref.memberExecuteOrderBtcReferred, 'referred member execution');
  same(linearExecuteIx('MCOOK', linearOrder(linearMarket('MCOOK'), owner, 42n), owner, null, referrer), ref.executeOrderCookPerpReferred, 'referred COOK-PERP execution');
  assert.equal(linearExecuteIx('BTC', order, owner, lpPoolAccount(0), null).keys.length, ref.memberExecuteOrderBtcReferred.keys.length - 1);
});

test('the referrer takes 20% of the fee, out of the protocol share only', () => {
  for (const { fee, referral } of ref.shares as { fee: string; referral: string }[]) {
    assert.equal(referralShare(B(fee)).toString(), referral);
    const plain = linearFeeSplit(B(fee), false);
    const referred = linearFeeSplit(B(fee), true);
    assert.deepEqual([referred.referral, referred.protocol], [plain.protocol, 0n]);
    assert.deepEqual([referred.lp, referred.holders, referred.insurance], [plain.lp, plain.holders, plain.insurance]);
  }
  const s = ref.sampleOpen;
  assert.equal(referralShare(B(s.fee)).toString(), s.referral);
  assert.equal(linearFeeSplit(B(s.fee), true).protocol.toString(), s.protocolAfterOpen);
  assert.equal(golden.samples.fees[0], linearFeeSplit(B(s.fee), false).protocol.toString(), 'without a referrer the protocol keeps it');
  assert.equal(REFERRAL_TERMS.bpsOfNotionalPerSide, (Number(LINEAR_TERMS.feeBps) * REFERRAL_TERMS.shareOfFeeBps) / 10_000);
});

test('a 50% partial close splits and values exactly as the engine', () => {
  const l = golden.open.long;
  const p: LinearPosition = { id: 0n, owner, side: 'long', margin: B(l.margin), notionalUsdMicros: B(l.notional), entryPriceMicros: B(l.entryPrice), profitCap: B(l.profitCap), fundingEntry: 0n };
  const split = linearSplitPosition(p, 10_000_000n)!;
  const s = ref.split50;
  assert.deepEqual([split.closing.margin, split.rest.margin].map(String), s.margin);
  assert.deepEqual([split.closing.profitCap, split.rest.profitCap].map(String), s.profitCap);
  assert.deepEqual([split.closing.notionalUsdMicros, split.rest.notionalUsdMicros].map(String), s.notional);
  const c = linearPartialClose(p, 10_000_000n, { ...Q, assetMicros: 90_200_000_000n }, 0n, NOW + 2, true);
  const want = s.closingHalfAt90200;
  assert.equal(c.problem, null);
  assert.deepEqual([c.pnl, c.payable, c.closingFee, c.referral].map(String), [want.pnl, want.payable, want.closingFee, want.referral]);
  assert.equal(c.rest?.notionalUsdMicros, 10_000_000n);
  assert.equal(linearSplitPosition(p, 9_999_999n), null);
  assert.equal(linearSplitPosition(p, 20_000_000n), null, 'the whole is a full close');
  assert.match(linearPartialClose(p, 15_000_000n, Q, 0n, 0).problem ?? '', /at least \$10 open/);
  assert.deepEqual(PARTIAL_CLOSE_PRESETS.map((pct) => partialNotional(p, pct)), [5_000_000n, 10_000_000n, 15_000_000n, 20_000_000n]);
  // A wick-proof half refunds its share of the unused fee.
  const w = decodeLinearMarket(bytes(wick.memberMarket)).ledger.positions[0]!;
  const half = linearPartialClose(w, 10_000_000n, Q, 0n, w.wick!.openedAt);
  const ws = linearSplitPosition(w, 10_000_000n)!;
  assert.equal(ws.closing.wick!.prepaid + ws.rest.wick!.prepaid, w.wick!.prepaid);
  assert.equal(half.refund, ws.closing.wick!.prepaid);
});
