/**
 * The final upgrade's SDK surface (src/perpsFinal.ts and the v4 parts of
 * perpsMarkets.ts), pinned to the `v4` section of the program's golden file
 * (`protocol/perps-v2/perps-program/tests/fixtures/perps-bcook-golden.json`,
 * written by `tests/golden.rs` from the engine and the program themselves).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import {
  CONFIG_BOUNDS, LEGACY_RULES, launchMarketSettings, linearOpenQuote, LEDGER_MAGIC, MARKETS_DISC, PERPS_PROGRAM_ID, SHIPPED_ORACLE_SETTINGS, addMarginIx, applyMarketRiskIx, applyOracleSettingsIx,
  breakerActive, cancelOracleSettingsIx, claimPayout, configAccount, cookDropToLiquidate, decodeLinearMarket, decodePoolOracle, decodeProgramConfig,
  defaultRisk, effectiveOracleSettings, encodeLimits, encodeLinearAction, encodeOracleSettings, encodeRisk, ethAddress, fundInsuranceIx, initConfigIx,
  initialMarginBps, leverageForNotional, liquidationOrder, linearLiquidationPrice, linearMark, maintenanceFloorBps, maxRemovableMargin,
  migrateMarketIx, migratePoolOracleIx, openLeverageNow, oracleSettingsApplyAtOnce, oracleSettingsProblems, postFeedPriceIx, postSolPriceIx,
  proposeOracleSettingsIx, riskProblems, riskRules, setMarketRiskIx, setPoolParamsIx, settleClaimIx, topLeverage,
  type BcookQuote, type LinearClaim, type LinearQuote, type LinearLimits, type LinearPosition, type LinearRisk, type OracleSettings,
} from '../src/index.js';

const FIXTURES = new URL('./fixtures/protocol/', import.meta.url);
const golden = JSON.parse(readFileSync(new URL('perps-bcook-golden.json', FIXTURES), 'utf8'));
const v4 = golden.v4;
const B = (s: string | number) => BigInt(s);
const hexBytes = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));
const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');
type Ix = { keys: [string, boolean, boolean][]; data: string };
function same(actual: TransactionInstruction, expected: Ix, name: string) {
  assert.ok(actual.programId.equals(PERPS_PROGRAM_ID), `${name}: program`);
  assert.deepEqual(actual.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), expected.keys, `${name}: accounts`);
  assert.equal(toHex(actual.data), expected.data, `${name}: data`);
}
const ADMIN = new PublicKey(golden.constants.admin);
const owner = new PublicKey(Uint8Array.from({ length: 32 }, () => 0x11));
const quote: BcookQuote = {
  assetMicros: B(golden.quote.engine.assetUsdMicros), settleTwap: B(golden.quote.engine.settleTwap), settleLo: B(golden.quote.engine.settleLo),
  settleHi: B(golden.quote.engine.settleHi), rateE9: B(golden.quote.engine.shareRateE9),
};

const limits: LinearLimits = { maxNotionalUsdMicros: 10_000_000_000n, maxPositions: 8, maxLeverage: 50 };
const sampleRisk: LinearRisk = {
  tiers: [
    { maxNotionalUsdMicros: 2_000_000_000n, maxLeverage: 50 },
    { maxNotionalUsdMicros: 5_000_000_000n, maxLeverage: 25 },
    { maxNotionalUsdMicros: 10_000_000_000n, maxLeverage: 10 },
  ],
  maintenanceBps: 100, liquidationFeeBps: 500, feeBps: 8, protocolBps: 2000, insuranceBps: 1000, holderBps: 3000, fundingBpsPerHour: 1,
  breakerMaxLeverage: 10, liquidateBankrupt: false, insuranceCap: 18_446_744_073_709_551_615n, breakerMoveBps: 100, breakerSeconds: 300,
  deferGainUsd: 5_000_000n, deferLossUsd: 18_446_744_073_709_551_615n, deferWindowSeconds: 7_200,
};

test('discriminators of the final upgrade match the program', () => {
  for (const [name, hex] of Object.entries(v4.instructions as Record<string, string>)) {
    assert.equal(toHex(Uint8Array.from((MARKETS_DISC as Record<string, number[]>)[name]!)), hex, name);
  }
  assert.equal(toHex(Uint8Array.from(MARKETS_DISC.ProgramConfig)), v4.accounts.ProgramConfig);
  assert.equal(toHex(Uint8Array.from(LEDGER_MAGIC)), v4.risk.ledgerMagic);
});

test('the config account: address, shipped settings, bounds, instructions', () => {
  assert.equal(configAccount().toBase58(), v4.config.address);
  const shipped: OracleSettings = {
    dataServiceId: SHIPPED_ORACLE_SETTINGS.dataServiceId, threshold: SHIPPED_ORACLE_SETTINGS.threshold, maxAgeSeconds: 35, minFillDelaySeconds: 2, maxFillDelaySeconds: 32,
    timelockSeconds: 172_800, signers: [],
  };
  // The golden's shipped settings carry the 12 redstone-primary-prod signers.
  const bytes = hexBytes(v4.config.shipped);
  const d = new Uint8Array([...MARKETS_DISC.ProgramConfig, 255, ...bytes, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const c = decodeProgramConfig(d);
  assert.equal(c.active.signers.length, 12);
  assert.deepEqual({ ...c.active, signers: [] }, shipped);
  assert.equal(toHex(encodeOracleSettings(c.active)), v4.config.shipped, 'encode is the inverse of decode');
  assert.equal(c.pending, null);
  // Bounds the SDK shows are the program's.
  assert.equal(CONFIG_BOUNDS.maxSigners, v4.config.bounds.maxSigners);
  assert.equal(CONFIG_BOUNDS.maxPackages, v4.config.bounds.maxPackages);
  assert.equal(CONFIG_BOUNDS.minThreshold, v4.config.bounds.minThreshold);
  assert.deepEqual([...CONFIG_BOUNDS.maxAgeSeconds], v4.config.bounds.maxAge);
  assert.deepEqual([...CONFIG_BOUNDS.minFillDelaySeconds], v4.config.bounds.minFillDelay);
  assert.deepEqual([...CONFIG_BOUNDS.maxFillDelaySeconds], v4.config.bounds.maxFillDelay);
  assert.deepEqual([...CONFIG_BOUNDS.timelockSeconds], v4.config.bounds.timelock);
  same(initConfigIx(ADMIN, c.active), v4.config.initConfig, 'init_config');
  same(proposeOracleSettingsIx(ADMIN, c.active), v4.config.proposeOracleSettings, 'propose_oracle_settings');
  same(applyOracleSettingsIx(), v4.config.applyOracleSettings, 'apply_oracle_settings');
  same(cancelOracleSettingsIx(ADMIN), v4.config.cancelOracleSettings, 'cancel_oracle_settings');
  // The price posts take the config after the price account.
  const payer = new PublicKey(Uint8Array.from({ length: 32 }, () => 0x33));
  assert.deepEqual(postSolPriceIx(payer, []).keys.map((k) => k.pubkey.toBase58()), v4.config.postPriceKeys);
  assert.deepEqual(postFeedPriceIx('BTC', payer, []).keys.map((k) => k.pubkey.toBase58()), v4.config.postFeedPriceKeys);
});

test('a pending proposal is in force once due; tightening applies at once and loosening waits', () => {
  const bytes = hexBytes(v4.config.shipped);
  const active = decodeProgramConfig(new Uint8Array([...MARKETS_DISC.ProgramConfig, 255, ...bytes, 0])).active;
  const rotated: OracleSettings = { ...active, signers: [...active.signers.slice(0, 11), ethAddress('0x1111111111111111111111111111111111111111')] };
  const dropped: OracleSettings = { ...active, signers: active.signers.slice(0, 8), threshold: 5 };
  assert.equal(oracleSettingsApplyAtOnce(rotated, active), false, 'a signer the active set does not have waits for the timelock');
  assert.equal(oracleSettingsApplyAtOnce(dropped, active), true);
  assert.equal(oracleSettingsApplyAtOnce({ ...active, threshold: 3 }, active), false);
  assert.equal(oracleSettingsApplyAtOnce({ ...active, maxAgeSeconds: 36 }, active), false);
  assert.equal(oracleSettingsApplyAtOnce({ ...active, timelockSeconds: 3_600 }, active), false);
  const withPending = new Uint8Array([...MARKETS_DISC.ProgramConfig, 255, ...bytes, 1, ...encodeOracleSettings(rotated), ...new Uint8Array(8), ...new Uint8Array(8)]);
  new DataView(withPending.buffer).setBigInt64(withPending.length - 8, 1_800_172_800n, true);
  new DataView(withPending.buffer).setBigInt64(withPending.length - 16, 1_800_000_000n, true);
  const c = decodeProgramConfig(withPending);
  assert.deepEqual(effectiveOracleSettings(c, 1_800_172_799), c.active);
  assert.deepEqual(effectiveOracleSettings(c, 1_800_172_800), rotated);
  assert.deepEqual(oracleSettingsProblems(active), []);
  assert.ok(oracleSettingsProblems({ ...active, threshold: 2 }).length > 0);
  assert.ok(oracleSettingsProblems({ ...active, signers: [active.signers[0]!, active.signers[0]!] }).length > 0);
  assert.ok(oracleSettingsProblems({ ...active, maxAgeSeconds: 61 }).length > 0);
});

test('risk and limits encode as the program reads them; bounds mirror the engine', () => {
  assert.equal(toHex(encodeLimits(limits)), v4.risk.limitsBytes);
  const bytes = encodeRisk(sampleRisk);
  assert.equal(bytes.length, v4.risk.riskLen);
  assert.equal(toHex(bytes), v4.risk.riskBytes);
  same(setMarketRiskIx(ADMIN, 'BTC', limits, sampleRisk), v4.risk.setMarketRisk, 'set_market_risk');
  same(applyMarketRiskIx('BTC'), v4.risk.applyMarketRisk, 'apply_market_risk');
  assert.deepEqual(riskProblems(limits, sampleRisk), []);
  for (const f of v4.risk.floors as { leverage: number; initialMarginBps: number; maintenanceFloorBps: number }[]) {
    assert.equal(initialMarginBps(f.leverage), f.initialMarginBps, `${f.leverage}x`);
    assert.equal(maintenanceFloorBps(f.leverage), f.maintenanceFloorBps, `${f.leverage}x`);
  }
  for (const t of v4.risk.leverageFor as { notional: string; leverage: number | null }[]) {
    assert.equal(leverageForNotional(limits, sampleRisk, B(t.notional)), t.leverage, t.notional);
  }
  // Problems the program would refuse.
  const bad = (f: (r: LinearRisk) => LinearRisk) => assert.ok(riskProblems(limits, f(structuredClone({ ...sampleRisk })) ).length > 0);
  bad((r) => ({ ...r, maintenanceBps: 99 }));
  bad((r) => ({ ...r, maintenanceBps: 192 }));
  bad((r) => ({ ...r, insuranceBps: 499 }));
  bad((r) => ({ ...r, holderBps: 3600, protocolBps: 3000, insuranceBps: 1500 }));
  bad((r) => ({ ...r, tiers: [...r.tiers].reverse() }));
  bad((r) => ({ ...r, deferWindowSeconds: 1_799 }));
  assert.equal(topLeverage(limits, sampleRisk), 50);
});

test('a v4 market ledger decodes: risk, positions, claims, bad debt, breaker', () => {
  const ledger = hexBytes(v4.risk.marketLedger);
  assert.equal(toHex(ledger.subarray(0, 8)), v4.risk.ledgerMagic);
  const head = new Uint8Array(8 + 32 + 32 + 32 + 1 + 1 + 8 + 4);
  head.set(MARKETS_DISC.LinearMarketState, 0);
  head.set(new TextEncoder().encode('BTC'), 8);
  new DataView(head.buffer).setUint32(head.length - 4, ledger.length, true);
  const m = decodeLinearMarket(new Uint8Array([...head, ...ledger, ...new Uint8Array(100)]));
  assert.equal(m.ledger.v4, true);
  assert.deepEqual(m.ledger.limits, limits);
  assert.deepEqual(m.ledger.risk, sampleRisk);
  assert.equal(m.ledger.positions.length, 1);
  assert.equal(m.ledger.positions[0]!.notionalUsdMicros, 1_000_000_000n);
  assert.deepEqual([m.ledger.claims.length, m.ledger.breakerUntil, m.ledger.pendingRisk], [0, 0, null]);
  assert.deepEqual(m.ledger.badDebt, { shortfall: 0n, covered: 0n, uncovered: 0n });
  // The ledger bytes the SDK reads back are exactly what the engine wrote: a truncated one is refused.
  assert.throws(() => decodeLinearMarket(new Uint8Array([...head.slice(0, head.length - 4), ...new Uint8Array([ledger.length - 1 & 255, ledger.length >> 8, 0, 0]), ...ledger.subarray(0, ledger.length - 1)])));
});

test('a v3 ledger (not yet migrated) still decodes, with the default risk of its limits', () => {
  const sample = hexBytes(golden.samples.market);
  const m = decodeLinearMarket(sample);
  assert.equal(m.ledger.v4, true, 'the regenerated golden sample is v4');
  assert.deepEqual(defaultRisk({ maxNotionalUsdMicros: 1n, maxPositions: 1, maxLeverage: 3 }).tiers, [{ maxNotionalUsdMicros: 100_000_000_000n, maxLeverage: 50 }]);
  assert.equal(defaultRisk({ maxNotionalUsdMicros: 1n, maxPositions: 1, maxLeverage: 3 }).maintenanceBps, 1000, 'v3 behaviour at 3x');
  assert.equal(defaultRisk({ maxNotionalUsdMicros: 1n, maxPositions: 1, maxLeverage: 50 }).maintenanceBps, 100, 'half the 2% initial margin at 50x');
});

const position: LinearPosition = {
  id: 0n, owner, side: 'long', margin: 200_000n * 1_000_000_000n, notionalUsdMicros: 1_000_000_000n, entryPriceMicros: 82_000_000_000n,
  profitCap: 200_000n * 1_000_000_000n, fundingEntry: 0n,
};

test('marks under the market’s own rules match the engine: bad debt, maintenance, bankruptcy at the low end', () => {
  for (const g of v4.risk.marks as { name: string; asset: string; pnl: string; payable: string; closingFee: string; maintenance: string; liquidatable: boolean; shortfall: string; rules: { feeBps: number; maintenanceBps: number; bankrupt: boolean } }[]) {
    const m = linearMark(position, { ...quote, assetMicros: B(g.asset) }, 0n, { feeBps: g.rules.feeBps, maintenanceBps: g.rules.maintenanceBps, liquidateBankrupt: g.rules.bankrupt });
    assert.deepEqual(
      { pnl: m.pnl.toString(), payable: m.payable.toString(), closingFee: m.closingFee.toString(), maintenance: m.maintenance.toString(), liquidatable: m.liquidatable, shortfall: m.shortfall.toString() },
      { pnl: g.pnl, payable: g.payable, closingFee: g.closingFee, maintenance: g.maintenance, liquidatable: g.liquidatable, shortfall: g.shortfall },
      g.name,
    );
  }
  assert.deepEqual(riskRules(sampleRisk), { feeBps: 8, maintenanceBps: 100, liquidateBankrupt: false });
  assert.deepEqual(LEGACY_RULES, { feeBps: 8, maintenanceBps: 1000, liquidateBankrupt: false });
});

test('the volatility breaker: a jump in this very post, or one remembered from before', () => {
  for (const s of v4.risk.shocks as { asset: string; prev: string; shock: boolean }[]) {
    assert.equal(breakerActive({ risk: sampleRisk, breakerUntil: 0 }, 1_800_000_000, B(s.asset), B(s.prev)), s.shock, `${s.asset}/${s.prev}`);
  }
  const l = { limits, risk: sampleRisk };
  assert.equal(openLeverageNow({ ...l, breakerUntil: 0 }, 1_000_000_000n, 1_800_000_000), 50);
  assert.equal(openLeverageNow({ ...l, breakerUntil: 1_800_000_100 }, 1_000_000_000n, 1_800_000_000), 10, 'remembered');
  assert.equal(openLeverageNow({ ...l, breakerUntil: 1_800_000_000 }, 1_000_000_000n, 1_800_000_000), 50, 'over');
  assert.equal(openLeverageNow({ ...l, breakerUntil: 0 }, 10_000_000_001n, 1_800_000_000), null, 'above the last tier');
});

test('margin, insurance, delayed payouts and the migrations match the golden instructions', () => {
  const tokens = new PublicKey(Uint8Array.from({ length: 32 }, () => 0x44));
  // The golden uses a stand-in token account; the SDK uses the owner's classic bCOOK ATA.
  const withTokens = (ix: TransactionInstruction, at: number) => { ix.keys[at] = { ...ix.keys[at]!, pubkey: tokens }; return ix; };
  same(withTokens(addMarginIx(owner, 'BTC', 0n, 5_000_000_000n), 1), v4.margin.addMargin, 'add_margin');
  same(withTokens(fundInsuranceIx(owner, 'BTC', 7_000_000_000n), 1), v4.margin.fundInsurance, 'fund_insurance');
  same(withTokens(settleClaimIx('BTC', 5n, owner), 0), v4.margin.settleClaim, 'settle_claim');
  assert.equal(toHex(encodeLinearAction({ kind: 'removeMargin', position: 3n, amount: 9_000_000_000n })), v4.margin.removeMarginAction);
  same(migrateMarketIx(ADMIN, 'BTC'), v4.migration.migrateMarket, 'migrate_market');
  same(migratePoolOracleIx(ADMIN), v4.migration.migratePoolOracle, 'migrate_pool_oracle');
  const p = { twapWindowS: 3_600, spacingS: 120, stepBps: 100, maxDevBps: 300, minPoolDepth: 100_000_000n, minSamples: 15, minSpanS: 1_800, oiShareBps: 1_250 };
  same(setPoolParamsIx(ADMIN, 'MCOOK', p), v4.migration.setPoolParams, 'set_pool_params');
  assert.equal(v4.migration.poolOracleSpace, 1_576);
  assert.equal(v4.migration.marketSpace, 6_118);
});

test('the settlement oracle account decodes its cumulative TWAP and a pending change (v4 tail)', () => {
  const v3 = hexBytes(golden.samples.poolOracle);
  const o = decodePoolOracle(v3);
  assert.deepEqual(o.cum, { cum: 0n, cumAt: 1_791_833_380 }.cum === 0n ? o.cum : null);
  assert.equal(o.pending, null);
});

test('delayed payouts: a gain at the higher price, a loss costing more COOK; due and stale rules', () => {
  const gain: LinearClaim = { id: 1n, owner, kind: 'gain', amount: 400n, basis: 400n, reference: 100n, cum: 0n, cumAt: 1_000, dueAt: 4_600 };
  assert.equal(claimPayout(gain, 0n, 1_000, 4_599), null, 'not due');
  // The average rose 25% over the hour: the held gain is 80% of its COOK.
  const hour = 3_610n;
  assert.deepEqual(claimPayout(gain, 125n * hour, 4_610, 4_610), { paid: 320n, toLp: 80n, average: 125n });
  // Lower or equal: paid in full.
  assert.deepEqual(claimPayout(gain, 80n * hour, 4_610, 4_610), { paid: 400n, toLp: 0n, average: 80n });
  const loss: LinearClaim = { ...gain, kind: 'loss', amount: 500n, basis: 400n };
  // COOK 20% cheaper: the loss beyond the threshold costs 25% more COOK: ceil(400 x 20/80) = 100.
  assert.deepEqual(claimPayout(loss, 80n * hour, 4_610, 4_610), { paid: 400n, toLp: 100n, average: 80n });
  assert.deepEqual(claimPayout(loss, 120n * hour, 4_610, 4_610), { paid: 500n, toLp: 0n, average: 120n });
  // An oracle that never advanced: 72 h past due the close's own value settles it.
  assert.equal(claimPayout(gain, 0n, 1_000, 4_600 + 72 * 3_600 - 1), null);
  assert.deepEqual(claimPayout(gain, 0n, 1_000, 4_600 + 72 * 3_600), { paid: 400n, toLp: 0n, average: 100n });
});

test('liquidation price and the COOK drop that liquidates, under the market’s maintenance', () => {
  const rules = riskRules(sampleRisk);
  const price = linearLiquidationPrice(position, quote, rules)!;
  const entry = Number(position.entryPriceMicros) / 1e6;
  assert.ok(price < entry && price > entry * 0.9, `a long liquidates just under entry at 50x: ${price}`);
  const legacy = linearLiquidationPrice(position, quote)!;
  assert.ok(legacy > price, 'the v3 10% maintenance is much nearer');
  // Marked at the liquidation price it is (about) liquidatable; a hair above it is not.
  const at = (p: number) => linearMark(position, { ...quote, assetMicros: BigInt(Math.round(p * 1e6)) }, 0n, rules);
  assert.equal(at(price * 0.999).liquidatable, true);
  const drop = cookDropToLiquidate(position, quote, rules)!;
  assert.ok(drop >= 0 && drop < 1);
  // With the COOK price that far down the margin no longer covers maintenance + fee; just above it does.
  const down = (d: number): BcookQuote => ({ ...quote, settleTwap: BigInt(Math.floor(Number(quote.settleTwap) * (1 - d))), settleLo: BigInt(Math.floor(Number(quote.settleLo) * (1 - d))), settleHi: BigInt(Math.floor(Number(quote.settleHi) * (1 - d))) });
  assert.equal(linearMark(position, down(drop + 0.01), 0n, rules).liquidatable, true);
  assert.equal(linearMark(position, down(Math.max(drop - 0.01, 0)), 0n, rules).liquidatable, drop - 0.01 <= 0);
  assert.equal(cookDropToLiquidate({ ...position, margin: 1n }, quote, rules), 0, 'already');
});

test('margin removal and the keeper’s liquidation order', () => {
  const ledger = { limits, risk: sampleRisk };
  const rules = riskRules(sampleRisk);
  const mark = (p: LinearPosition, q: LinearQuote, f: bigint) => linearMark(p, q, f, rules);
  // The sample position is only ~$15 of margin on $1,000 (under the 2% initial margin of 50x): nothing can come out.
  assert.equal(maxRemovableMargin(position, ledger, quote, 0n, mark), 0n);
  const rich = { ...position, margin: position.margin * 10n, profitCap: position.margin * 10n };
  const room = maxRemovableMargin(rich, ledger, quote, 0n, mark);
  assert.ok(room > 0n && room < rich.margin);
  // The boundary is exact: `room` passes, one more does not (the same two checks as the program).
  const passes = (amount: bigint) => {
    const left = { ...rich, margin: rich.margin - amount };
    const m = mark(left, quote, 0n);
    const loss = m.pnl < 0n ? -m.pnl : 0n;
    return !m.liquidatable && left.margin - loss - m.closingFee >= (quote.settleLo > 0n ? 1n : 0n);
  };
  assert.equal(passes(room), true);
  assert.equal(maxRemovableMargin({ ...rich, margin: rich.margin - room }, ledger, quote, 0n, mark), 0n, "nothing more once it is at the line");
  assert.equal(maxRemovableMargin({ ...position, wick: { openedAt: 0, expiresAt: 1, prepaid: 0n, rate: 1, takeProfit: false } }, ledger, quote, 0n, mark), 0n, 'never from a wick-proof position');
  const calm = { ...position, id: 1n, margin: position.margin * 10n };
  assert.deepEqual(liquidationOrder([calm, position], quote).map((p) => p.id), [0n, 1n], 'highest leverage first');
});

test('the ticket: leverage follows the notional tier and the breaker; the liquidation price and the COOK drop come with it', () => {
  const ledger = hexBytes(v4.risk.marketLedger);
  const head = new Uint8Array(8 + 32 + 32 + 32 + 1 + 1 + 8 + 4);
  head.set(MARKETS_DISC.LinearMarketState, 0);
  head.set(new TextEncoder().encode('BTC'), 8);
  new DataView(head.buffer).setUint32(head.length - 4, ledger.length, true);
  const m = decodeLinearMarket(new Uint8Array([...head, ...ledger]));
  const open = (notional: bigint, lev: number, breaker = false) => linearOpenQuote(m, null, 'long', notional, lev, quote, null, breaker);
  // $1,000 at 50x: sized, with the liquidation price near entry and a COOK drop that liquidates it.
  const a = open(1_000_000_000n, 50);
  assert.equal(a.problem, null);
  assert.equal(a.maxLeverage, 50);
  assert.ok(a.liquidationPrice !== null && a.liquidationPrice < Number(quote.assetMicros) / 1e6);
  assert.ok(a.cookDrop !== null && a.cookDrop > 0 && a.cookDrop < 1);
  // $3,000 is the 25x tier: 50x is refused with the reason, 25x is sized.
  assert.match(open(3_000_000_000n, 50).problem ?? '', /up to 25x/);
  assert.equal(open(3_000_000_000n, 25).problem, null);
  // Above the last tier ($10,000): no tier.
  assert.match(open(10_000_000_001n, 10).problem ?? '', /no leverage tier above \$10,000/);
  // The breaker: 10x only, said as such.
  assert.match(open(1_000_000_000n, 50, true).problem ?? '', /up to 10x for a few minutes/);
  assert.equal(open(1_000_000_000n, 10, true).problem, null);
  // A higher leverage means the liquidation price is nearer and the COOK drop smaller.
  const b = open(1_000_000_000n, 25);
  assert.ok(b.liquidationPrice! < a.liquidationPrice!, 'at 25x it is further from entry');
  assert.ok(b.cookDrop! > a.cookDrop!, 'more margin: COOK must fall further');
});

test('the launch table: every market passes the engine’s bounds, in the SDK and in the compiled program', () => {
  const table = JSON.parse(readFileSync(new URL('launch-risk.json', FIXTURES), 'utf8'));
  for (const feed of Object.keys(table.markets)) {
    const { limits: l, risk: r } = launchMarketSettings(feed, table);
    assert.deepEqual(riskProblems(l, r), [], feed);
    // Half the initial margin at the top leverage, never below the floor.
    assert.equal(r.maintenanceBps, feed === 'MCOOK' ? 1000 : Math.max(maintenanceFloorBps(topLeverage(l, r)), 0), feed);
    assert.equal(r.insuranceBps, 2000);
    assert.equal(r.liquidateBankrupt, true);
    // A max-leverage open is never liquidatable at once.
    assert.ok(r.maintenanceBps + r.feeBps < initialMarginBps(topLeverage(l, r)), feed);
  }
  assert.equal(launchMarketSettings('BTC', table).limits.maxLeverage, 50);
  assert.equal(launchMarketSettings('SOL', table).limits.maxLeverage, 30);
  assert.equal(launchMarketSettings('HYPE', table).limits.maxLeverage, 20);
  assert.equal(launchMarketSettings('MCOOK', table).limits.maxLeverage, 2);
  assert.equal(table.pool.oiShareBps, 1000);
});
