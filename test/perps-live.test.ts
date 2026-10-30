import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import {
  PERPS_LIVE_PROGRAM_ID,
  decodePerpsIntent,
  decodePerpsMarket,
  decodePerpsPrice,
  perpsCancelIx,
  PERPS_TERMS,
  perpsFee,
  perpsFreeCash,
  perpsIntent,
  perpsLiquidationPrice,
  perpsMark,
  perpsOpenQuote,
  perpsSubmitIx,
  perpsPriceBounds,
  perpsCloseBounds,
  perpsCloseMinimum,
  perpsLpNav,
  assertU64,
  type PerpsPosition,
} from '../src/perpsLive.js';

/** Captured from the live market on 2026-10-12 (test/capture-perps-fixture.mts). */
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'perps-live-2026-10-12.json'), 'utf8')) as {
  owner: string; market: string; price: string; intents: Array<{ address: string; data: string }>;
};
const SOL = 1_000_000_000n;
const USD = 1_000_000n;
const PAR = 1_000_000_000n;

test('decodes the live market, price and intent', () => {
  const market = decodePerpsMarket(Buffer.from(fixture.market, 'base64'));
  assert.equal(market.paused, false);
  assert.equal(market.pending, 0n);
  // The first LP deposit: 0.01 aSOL for 0.01 shares, from the admin.
  assert.equal(market.ledger.lpCash, 10_000_000n);
  assert.equal(market.ledger.lpShareSupply, 10_000_000n);
  assert.equal(market.ledger.lpBalances.get(fixture.owner), 10_000_000n);
  assert.equal(market.ledger.positions.length, 0);
  assert.ok(market.ledger.lastPublication > 1_790_000_000n);

  const price = decodePerpsPrice(Buffer.from(fixture.price, 'base64'));
  assert.ok(price.signers >= 3, 'at least three RedStone signers');
  assert.ok(price.priceUsdMicros > 50n * USD && price.priceUsdMicros < 500n * USD);

  const [raw] = fixture.intents;
  const intent = decodePerpsIntent(new PublicKey(raw!.address), Buffer.from(raw!.data, 'base64'));
  assert.equal(intent.owner.toBase58(), fixture.owner);
  assert.deepEqual(intent.action, { kind: 'deposit', amount: 10_000_000n, minimum: 1n });
  assert.equal(intent.active, false, 'executed by the keeper');
  assert.ok(perpsIntent(intent.owner, intent.nonce).equals(intent.address), 'PDA derivation matches the program');
  assert.ok(intent.deadline - intent.createdAt >= 3 && intent.deadline - intent.createdAt <= 60);

  assert.throws(() => decodePerpsMarket(Buffer.from(raw!.data, 'base64')), /not a perps MarketState/);
});

test('fees are 8 bps of notional in aSOL, rounded up', () => {
  assert.equal(PERPS_TERMS.feeBps, 8);
  // $100 at $107.66: 100 / 107.66 * 0.0008 SOL = 743,080.07 lamports, rounded up.
  assert.equal(perpsFee(100n * USD, 107_660_000n, PAR), 743_081n);
  // aSOL worth 1.1 SOL needs fewer aSOL units for the same SOL fee.
  assert.ok(perpsFee(100n * USD, 107_660_000n, 1_100_000_000n) < 743_081n);
});

const long: PerpsPosition = {
  id: 0n, owner: PERPS_LIVE_PROGRAM_ID, side: 'long', margin: SOL / 2n,
  notionalUsdMicros: 100n * USD, entryPriceMicros: 100n * USD, profitCap: SOL, fundingEntry: 0n,
};

test('marks are inverse and clamped to the margin and the profit cap', () => {
  // Long $100 from $100 to $110: 100 * (1/100 - 1/110) = 0.0909090909 SOL.
  assert.equal(perpsMark(long, 110n * USD, PAR, 0n).pnl, 90_909_090n);
  // A short gains what the long loses, rounded against the trader.
  assert.equal(perpsMark({ ...long, side: 'short' }, 110n * USD, PAR, 0n).pnl, -90_909_091n);
  // A collapse cannot lose more than the margin; a rally cannot win more than the cap.
  assert.equal(perpsMark(long, 1n * USD, PAR, 0n).pnl, -(SOL / 2n));
  const capped = perpsMark({ ...long, profitCap: 1_000n }, 1_000n * USD, PAR, 0n);
  assert.equal(capped.pnl, 1_000n);
  assert.ok(capped.profitCapReached);
});

test('the liquidation price is where payable meets maintenance', () => {
  const liq = perpsLiquidationPrice(long, PAR)!;
  // $100 long from $100 with 0.5 SOL margin: 100 * (1 + 0.0008 + 0.1) / 1.5.
  assert.ok(Math.abs(liq - 73.3867) < 0.01, `liq ${liq}`);
  const at = (price: number) => perpsMark(long, BigInt(Math.round(price * 1e6)), PAR, 0n);
  assert.ok(at(liq - 0.05).liquidatable, 'just below: liquidatable');
  assert.ok(!at(liq + 0.05).liquidatable, 'just above: not');
  // A short whose margin covers its whole notional can never be liquidated.
  assert.equal(perpsLiquidationPrice({ ...long, side: 'short', margin: 2n * SOL }, PAR), null);
});

test('an order quote respects leverage, fees and LP free capital', () => {
  const market = decodePerpsMarket(Buffer.from(fixture.market, 'base64'));
  const price = 107_660_000n;
  const quote = perpsOpenQuote(market, 'long', 10n * USD, 3, price, PAR);
  assert.equal(quote.problem, null);
  // $10 at 3x, sized at the order's lowest fill price (1% below): a third of
  // $10 of SOL at that price, plus the fee.
  const third = Number(quote.margin) / 1e9 * 107.66;
  assert.ok(third > 3.36 && third < 3.38, `margin ${third}`);
  assert.equal(quote.collateral, quote.margin + quote.openingFee);
  // The engine's leverage rule holds at every fill price inside the bounds:
  // margin_sol * price * 3 >= notional, worst at the lower bound.
  const [floor] = perpsPriceBounds(price);
  assert.ok((quote.margin * floor * 3n) / PAR >= quote.notional);
  // The win is capped by free LP capital: 0.01 aSOL here.
  assert.equal(perpsFreeCash(market.ledger), 10_000_000n);
  const big = perpsOpenQuote(market, 'short', 100n * USD, 1, price, PAR);
  assert.equal(big.profitCap, 10_000_000n);
  assert.match(perpsOpenQuote(market, 'long', 1_001n * USD, 3, price, PAR).problem ?? '', /\$1,000/);
});

test('an order quote enforces the $10 minimum and four positions per wallet', () => {
  const market = decodePerpsMarket(Buffer.from(fixture.market, 'base64'));
  const price = 107_660_000n;
  assert.match(perpsOpenQuote(market, 'long', 9_999_999n, 3, price, PAR).problem ?? '', /\$10\./);
  const owner = new PublicKey(fixture.owner);
  const held = (n: number) => ({
    ...market,
    ledger: { ...market.ledger, positions: Array.from({ length: n }, (_, i) => ({ ...long, id: BigInt(i), owner, profitCap: 0n })) },
  });
  assert.equal(perpsOpenQuote(held(3), 'long', 10n * USD, 3, price, PAR, owner).problem, null);
  assert.match(perpsOpenQuote(held(4), 'long', 10n * USD, 3, price, PAR, owner).problem ?? '', /4 open positions/);
  // Another wallet is not limited by this one's positions.
  assert.equal(perpsOpenQuote(held(4), 'long', 10n * USD, 3, price, PAR, PERPS_LIVE_PROGRAM_ID).problem, null);
});

test('instructions carry Anchor discriminators and the program layout', () => {
  const disc = (s: string) => createHash('sha256').update(s).digest().subarray(0, 8);
  const owner = new PublicKey(fixture.owner);
  const submit = perpsSubmitIx(owner, 7n, { kind: 'open', long: true, collateral: 5n, notional: 6n, profitCap: 7n }, 1_000, 1n, 2n);
  assert.deepEqual(submit.data.subarray(0, 8), disc('global:submit'));
  // nonce, Action::Open (tag 0, long, three u64), deadline, min, max.
  assert.equal(submit.data.length, 8 + 8 + 26 + 24);
  assert.equal(submit.data.readBigUInt64LE(8), 7n);
  assert.equal(submit.data[16], 0);
  assert.equal(submit.data[17], 1);
  assert.equal(submit.data.readBigInt64LE(8 + 8 + 26), 1_055n, 'deadline 55 s ahead');
  assert.ok(submit.keys[1]!.pubkey.equals(perpsIntent(owner, 7n)));
  const close = perpsSubmitIx(owner, 8n, { kind: 'close', position: 3n, minimum: 0n }, 1_000, 1n, 2n);
  assert.equal(close.data.length, 8 + 8 + 17 + 24);
  assert.equal(close.data[16], 1);
  assert.deepEqual(perpsCancelIx(owner, perpsIntent(owner, 8n)).data.subarray(0, 8), disc('global:cancel'));
});

test('closing limits only the side that hurts, and sets a payout floor there', () => {
  const [lmin, lmax] = perpsCloseBounds('long', 100n * USD);
  assert.equal(lmin, 99n * USD);
  assert.equal(lmax, 18_446_744_073_709_551_615n, 'a rally never blocks a long close');
  const [smin, smax] = perpsCloseBounds('short', 100n * USD);
  assert.equal(smin, 1n);
  assert.equal(smax, 101n * USD);
  // The floor is what the position pays at the worst allowed price, and positive.
  const minimum = perpsCloseMinimum(long, lmin, PAR, 0n);
  assert.equal(minimum, perpsMark(long, lmin, PAR, 0n).payable);
  assert.ok(minimum > 0n && minimum < long.margin);
});

test('LP NAV subtracts traders’ unrealized wins', () => {
  const market = decodePerpsMarket(Buffer.from(fixture.market, 'base64'));
  const ledger = { ...market.ledger, lpCash: SOL, positions: [{ ...long, profitCap: SOL / 10n }] };
  // The long is up at $110: NAV is cash minus its PnL (capped at 0.1 SOL).
  const nav = perpsLpNav(ledger, 110n * USD, PAR, 0n);
  assert.equal(nav, SOL - perpsMark(ledger.positions[0]!, 110n * USD, PAR, 0n).pnl);
  assert.ok(nav < SOL);
});

test('amounts outside u64 are refused, never wrapped', () => {
  assert.throws(() => assertU64(-1n), /u64/);
  assert.throws(() => assertU64(2n ** 64n), /u64/);
  const owner = new PublicKey(fixture.owner);
  assert.throws(() => perpsSubmitIx(owner, 1n, { kind: 'close', position: 1n, minimum: -1n }, 1_000, 1n, 2n), /u64/);
  assert.throws(() => perpsSubmitIx(owner, 1n, { kind: 'open', long: true, collateral: 2n ** 64n + 5n, notional: 1n, profitCap: 1n }, 1_000, 1n, 2n), /u64/);
});
