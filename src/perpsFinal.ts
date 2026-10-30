/**
 * The final upgrade of Aera Perps (SDK 0.4.0; docs/BCOOK_SETTLEMENT.md,
 * "Final upgrade"): up to 50x with per-market leverage tiers, maintenance, the
 * liquidator's fee, an insurance fund for bad debt, margin in and out, delayed
 * settlement of large results, a volatility breaker, and the settings that used
 * to be constants (the RedStone signer set, the staleness bound, the fill
 * window) as admin settings behind a timelock.
 *
 * Everything here is pinned by the `v4` section of
 * `protocol/perps-v2/perps-program/tests/fixtures/perps-bcook-golden.json`
 * (`test/perps-final.test.ts`). The program is the authority.
 */
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import {
  LINEAR_TERMS, MARKETS_DISC, MAX_TIERS, configAccount, initialMarginBps, isBcookQuote, leverageForNotional, linearMarket, linearVault, maintenanceFloorBps,
  marginUsdMicros, marketsTokenAccount, perpsDeployment, poolOracleAccount, settleOracleAccount,
  type LinearClaim, type LinearLedger, type LinearLimits, type LinearMarketState, type LinearPosition, type LinearQuote, type LinearRisk, type PerpsProgram,
} from './perpsMarkets.js';

const U64_MAX = 18_446_744_073_709_551_615n;
const BPS = 10_000n;
const w = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const ro = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
const signer = (pubkey: PublicKey) => ({ pubkey, isSigner: true, isWritable: false });
const u8 = (v: number) => Uint8Array.of(v);
const u16 = (v: number) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); return b; };
const u32 = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; };
const u64 = (v: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); return b; };
const cat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const ixOf = (program: PerpsProgram, keys: ReturnType<typeof w>[], data: Uint8Array | readonly number[]) =>
  new TransactionInstruction({ programId: perpsDeployment(program).programId, keys, data: Buffer.from(Uint8Array.from(data)) });

// --- the admin settings: signer set, staleness, fill window, timelock ---------------

/** The bounds `config.rs` enforces (golden `v4.config.bounds`). */
export const CONFIG_BOUNDS = Object.freeze({
  maxSigners: 20,
  /** Packages one post may carry (one secp256k1 recovery each). */
  maxPackages: 12,
  minThreshold: 3,
  maxAgeSeconds: [10, 60] as const,
  minFillDelaySeconds: [1, 10] as const,
  maxFillDelaySeconds: [12, 60] as const,
  timelockSeconds: [3_600, 2_592_000] as const,
});
/** What the program shipped with: the 12 `redstone-primary-prod` signers, threshold 4, 35 s, orders fill 2-32 s after submission. */
export const SHIPPED_ORACLE_SETTINGS = Object.freeze({ dataServiceId: 'redstone-primary-prod', threshold: 4, maxAgeSeconds: 35, minFillDelaySeconds: 2, maxFillDelaySeconds: 32 });

/** The RedStone signer set and the timing rules prices are checked by (`config::OracleSettings`). */
export interface OracleSettings {
  /** RedStone data service id; informational on chain (RedStone's signed message does not contain it). */
  dataServiceId: string;
  /** Distinct signers a price needs. */
  threshold: number;
  maxAgeSeconds: number;
  minFillDelaySeconds: number;
  maxFillDelaySeconds: number;
  /** How long a loosening change waits. */
  timelockSeconds: number;
  /** Ethereum addresses (20 bytes) of the signers. */
  signers: Uint8Array[];
}
export interface ProgramConfigState {
  bump: number;
  active: OracleSettings;
  pending: { settings: OracleSettings; proposedAt: number; effectiveAt: number } | null;
}
const hexOf = (b: Uint8Array) => Buffer.from(b).toString('hex');
/** Encode settings as the program reads them (golden `v4.config.shipped`). */
export function encodeOracleSettings(s: OracleSettings): Uint8Array {
  const id = new Uint8Array(32);
  id.set(new TextEncoder().encode(s.dataServiceId).subarray(0, 32));
  return cat(id, u8(s.threshold), u8(s.maxAgeSeconds), u8(s.minFillDelaySeconds), u8(s.maxFillDelaySeconds), u32(s.timelockSeconds), u32(s.signers.length), ...s.signers);
}
function readSettings(d: Uint8Array, at: number): [OracleSettings, number] {
  const v = new DataView(d.buffer, d.byteOffset);
  const idBytes = d.subarray(at, at + 32);
  const n = idBytes.indexOf(0);
  const dataServiceId = new TextDecoder().decode(idBytes.subarray(0, n < 0 ? 32 : n));
  const threshold = d[at + 32]!, maxAgeSeconds = d[at + 33]!, minFillDelaySeconds = d[at + 34]!, maxFillDelaySeconds = d[at + 35]!;
  const timelockSeconds = v.getUint32(at + 36, true);
  const count = v.getUint32(at + 40, true);
  const signers: Uint8Array[] = [];
  for (let i = 0; i < count; i++) signers.push(d.slice(at + 44 + 20 * i, at + 64 + 20 * i));
  return [{ dataServiceId, threshold, maxAgeSeconds, minFillDelaySeconds, maxFillDelaySeconds, timelockSeconds, signers }, at + 44 + 20 * count];
}
/** `["config"]`. Absent until `init_config` runs: the program then uses its shipped defaults. */
export function decodeProgramConfig(d: Uint8Array): ProgramConfigState {
  if (!MARKETS_DISC.ProgramConfig.every((b, i) => d[i] === b)) throw new Error('not a perps ProgramConfig');
  const bump = d[8]!;
  const [active, end] = readSettings(d, 9);
  const v = new DataView(d.buffer, d.byteOffset);
  if (d[end] !== 1) return { bump, active, pending: null };
  const [settings, e2] = readSettings(d, end + 1);
  return { bump, active, pending: { settings, proposedAt: Number(v.getBigInt64(e2, true)), effectiveAt: Number(v.getBigInt64(e2 + 8, true)) } };
}
/** The settings in force at `now`: a due proposal counts whether or not anyone applied it. */
export const effectiveOracleSettings = (c: ProgramConfigState, now: number): OracleSettings => (c.pending && now >= c.pending.effectiveAt ? c.pending.settings : c.active);
/** Every bound of `config::OracleSettings::validate`, as the problems found (empty: valid). */
export function oracleSettingsProblems(s: OracleSettings): string[] {
  const out: string[] = [];
  const within = (v: number, [lo, hi]: readonly [number, number]) => v >= lo && v <= hi;
  const distinct = new Set(s.signers.map(hexOf));
  if (s.signers.length > CONFIG_BOUNDS.maxSigners) out.push(`at most ${CONFIG_BOUNDS.maxSigners} signers`);
  if (distinct.size !== s.signers.length) out.push('signers must be distinct');
  if (s.signers.some((a) => a.length !== 20 || a.every((b) => b === 0))) out.push('signers are 20-byte non-zero addresses');
  if (s.threshold < CONFIG_BOUNDS.minThreshold || s.threshold > CONFIG_BOUNDS.maxPackages || s.threshold > s.signers.length) out.push(`threshold ${CONFIG_BOUNDS.minThreshold}..${CONFIG_BOUNDS.maxPackages} and at most the signer count`);
  if (!within(s.maxAgeSeconds, CONFIG_BOUNDS.maxAgeSeconds)) out.push('staleness 10-60 s');
  if (!within(s.minFillDelaySeconds, CONFIG_BOUNDS.minFillDelaySeconds)) out.push('minimum fill delay 1-10 s');
  if (!within(s.maxFillDelaySeconds, CONFIG_BOUNDS.maxFillDelaySeconds)) out.push('maximum fill delay 12-60 s');
  if (!within(s.timelockSeconds, CONFIG_BOUNDS.timelockSeconds)) out.push('timelock 1 hour to 30 days');
  if (!/^[\x21-\x7e]{1,32}$/.test(s.dataServiceId)) out.push('data service id: 1-32 printable ASCII characters');
  return out;
}
/** Whether `next` is no looser than `active` (applies at once); otherwise it waits `active.timelockSeconds`. */
export function oracleSettingsApplyAtOnce(next: OracleSettings, active: OracleSettings): boolean {
  const has = new Set(active.signers.map(hexOf));
  return next.signers.every((s) => has.has(hexOf(s))) && next.threshold >= active.threshold && next.maxAgeSeconds <= active.maxAgeSeconds
    && next.minFillDelaySeconds >= active.minFillDelaySeconds && next.maxFillDelaySeconds <= active.maxFillDelaySeconds && next.timelockSeconds >= active.timelockSeconds;
}
/** `0x…` Ethereum address to 20 bytes. */
export const ethAddress = (hex: string): Uint8Array => {
  const h = hex.replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{40}$/.test(h)) throw new Error(`not an Ethereum address: ${hex}`);
  return Uint8Array.from(Buffer.from(h, 'hex'));
};

/**
 * Admin, once: create `["config"]` with the FIRST settings, in force at once (no timelock: there is nothing to
 * loosen yet). `settings.timelockSeconds` is the wait every later loosening takes. Until this runs the program
 * trusts the shipped RedStone set.
 */
export function initConfigIx(admin: PublicKey, settings: OracleSettings, program: PerpsProgram = 'bcook'): TransactionInstruction {
  return ixOf(program, [w(admin, true), w(configAccount(program)), ro(SystemProgram.programId)], cat(Uint8Array.from(MARKETS_DISC.init_config), encodeOracleSettings(settings)));
}
export function proposeOracleSettingsIx(admin: PublicKey, settings: OracleSettings, program: PerpsProgram = 'bcook'): TransactionInstruction {
  return ixOf(program, [signer(admin), w(configAccount(program))], cat(Uint8Array.from(MARKETS_DISC.propose_oracle_settings), encodeOracleSettings(settings)));
}
export function applyOracleSettingsIx(program: PerpsProgram = 'bcook'): TransactionInstruction {
  return ixOf(program, [w(configAccount(program))], MARKETS_DISC.apply_oracle_settings);
}
export function cancelOracleSettingsIx(admin: PublicKey, program: PerpsProgram = 'bcook'): TransactionInstruction {
  return ixOf(program, [signer(admin), w(configAccount(program))], MARKETS_DISC.cancel_oracle_settings);
}

// --- market risk -------------------------------------------------------------------------

export const encodeLimits = (l: LinearLimits): Uint8Array => cat(u64(l.maxNotionalUsdMicros), u16(l.maxPositions), u8(l.maxLeverage));
/** `Risk`'s borsh bytes (golden `v4.risk.riskBytes`; 87 bytes). */
export function encodeRisk(r: LinearRisk): Uint8Array {
  const tiers = Array.from({ length: MAX_TIERS }, (_, i) => r.tiers[i] ?? { maxNotionalUsdMicros: 0n, maxLeverage: 0 });
  return cat(
    ...tiers.map((t) => cat(u64(t.maxNotionalUsdMicros), u8(t.maxLeverage))),
    u8(r.tiers.length), u16(r.maintenanceBps), u16(r.liquidationFeeBps), u16(r.feeBps), u16(r.protocolBps), u16(r.insuranceBps), u16(r.holderBps),
    u16(r.fundingBpsPerHour), u8(r.breakerMaxLeverage), u8(r.liquidateBankrupt ? 1 : 0), u64(r.insuranceCap),
    u16(r.breakerMoveBps), u32(r.breakerSeconds), u64(r.deferGainUsd), u64(r.deferLossUsd), u32(r.deferWindowSeconds),
  );
}
/** Hard bounds `Risk::validate` enforces (engine `linear.rs`). */
export const RISK_BOUNDS = Object.freeze({
  maxLeverage: 50, maxTiers: MAX_TIERS, minFeeBps: 1, maxFeeBps: 50, maxLiquidationFeeBps: 2_000,
  maxProtocolBps: 3_000, minInsuranceBps: 500, maxInsuranceBps: 5_000, maxHolderBps: 5_000, minLpFeeBps: 2_000,
  maxFundingBpsPerHour: 100, breakerMoveBps: [10, 5_000] as const, breakerSeconds: [10, 3_600] as const, deferWindowSeconds: [1_800, 21_600] as const,
  maintenanceCapBps: 1_000,
});
/** The market's top leverage: its limit, within its first tier. */
export const topLeverage = (limits: LinearLimits, risk: LinearRisk): number => Math.min(limits.maxLeverage, risk.tiers[0]?.maxLeverage ?? 0);
/** Every bound of `Risk::validate` as the problems found (empty: valid). */
export function riskProblems(limits: LinearLimits, risk: LinearRisk): string[] {
  const out: string[] = [];
  const B = RISK_BOUNDS;
  if (limits.maxNotionalUsdMicros <= 0n || limits.maxNotionalUsdMicros > LINEAR_TERMS.hardMaxNotionalUsdMicros) out.push('max notional $0-$100,000');
  if (limits.maxPositions < 1 || limits.maxPositions > LINEAR_TERMS.hardMaxPositions) out.push('1-32 positions');
  if (limits.maxLeverage < 1 || limits.maxLeverage > B.maxLeverage) out.push('leverage 1-50');
  const n = risk.tiers.length;
  if (n < 1 || n > B.maxTiers) out.push('1-4 tiers');
  risk.tiers.forEach((t, i) => {
    if (t.maxNotionalUsdMicros < LINEAR_TERMS.minNotionalUsdMicros || t.maxNotionalUsdMicros > LINEAR_TERMS.hardMaxNotionalUsdMicros || t.maxLeverage < 1 || t.maxLeverage > B.maxLeverage) out.push(`tier ${i}: out of range`);
    const p = risk.tiers[i - 1];
    if (p && (t.maxNotionalUsdMicros <= p.maxNotionalUsdMicros || t.maxLeverage > p.maxLeverage)) out.push(`tier ${i}: sizes must grow and leverage must not rise`);
  });
  const top = topLeverage(limits, risk);
  const im = initialMarginBps(top);
  if (risk.maintenanceBps < maintenanceFloorBps(top)) out.push(`maintenance at least ${maintenanceFloorBps(top)} bps (half the initial margin at ${top}x)`);
  if (risk.maintenanceBps + risk.feeBps >= im) out.push(`maintenance + fee below the initial margin (${im} bps)`);
  if (risk.feeBps < B.minFeeBps || risk.feeBps > B.maxFeeBps) out.push('fee 1-50 bps');
  if (risk.liquidationFeeBps > B.maxLiquidationFeeBps) out.push('liquidator fee at most 20% of the margin');
  if (risk.protocolBps > B.maxProtocolBps) out.push('protocol share at most 30%');
  if (risk.insuranceBps < B.minInsuranceBps || risk.insuranceBps > B.maxInsuranceBps) out.push('insurance share 5-50%');
  if (risk.holderBps > B.maxHolderBps) out.push('holder share at most 50%');
  if (10_000 - risk.protocolBps - risk.insuranceBps - risk.holderBps < B.minLpFeeBps) out.push('LPs keep at least 20% of every fee');
  if (risk.fundingBpsPerHour > B.maxFundingBpsPerHour) out.push('funding at most 100 bps/h');
  if (risk.breakerMaxLeverage < 1 || risk.breakerMaxLeverage > B.maxLeverage) out.push('breaker leverage 1-50');
  if (risk.breakerMoveBps !== 0 && (risk.breakerMoveBps < B.breakerMoveBps[0] || risk.breakerMoveBps > B.breakerMoveBps[1])) out.push('breaker move 10-5000 bps (or 0: off)');
  if (risk.breakerSeconds < B.breakerSeconds[0] || risk.breakerSeconds > B.breakerSeconds[1]) out.push('breaker duration 10-3600 s');
  if (risk.deferWindowSeconds !== 0 && (risk.deferWindowSeconds < B.deferWindowSeconds[0] || risk.deferWindowSeconds > B.deferWindowSeconds[1])) out.push('delay window 30 min-6 h (or 0: off)');
  return out;
}
/** Whether the volatility breaker is on: from an earlier observation, or because this very price jumped. */
export function breakerActive(ledger: Pick<LinearLedger, 'risk' | 'breakerUntil'>, nowSeconds: number, assetMicros?: bigint, previousAssetMicros?: bigint): boolean {
  if (ledger.breakerUntil > nowSeconds) return true;
  const bps = BigInt(ledger.risk.breakerMoveBps);
  if (bps === 0n || !assetMicros || !previousAssetMicros || previousAssetMicros === 0n) return false;
  const diff = assetMicros > previousAssetMicros ? assetMicros - previousAssetMicros : previousAssetMicros - assetMicros;
  return diff * BPS > previousAssetMicros * bps;
}
/** The most leverage an open of `notional` may use right now (the tier, the breaker's cap while it is on); null if refused. */
export function openLeverageNow(ledger: Pick<LinearLedger, 'limits' | 'risk' | 'breakerUntil'>, notionalUsdMicros: bigint, nowSeconds: number, assetMicros?: bigint, previousAssetMicros?: bigint): number | null {
  const tier = leverageForNotional(ledger.limits, ledger.risk, notionalUsdMicros);
  if (tier === null) return null;
  return breakerActive(ledger, nowSeconds, assetMicros, previousAssetMicros) ? Math.min(tier, ledger.risk.breakerMaxLeverage) : tier;
}

/** Admin: set a market's limits and risk. A loosening waits for the timelock unless the market is paused and empty. */
export function setMarketRiskIx(admin: PublicKey, feed: string, limits: LinearLimits, risk: LinearRisk, program: PerpsProgram = 'bcook'): TransactionInstruction {
  return ixOf(program, [signer(admin), w(linearMarket(feed, program)), ro(configAccount(program))], cat(Uint8Array.from(MARKETS_DISC.set_market_risk), encodeLimits(limits), encodeRisk(risk)));
}
export function applyMarketRiskIx(feed: string, program: PerpsProgram = 'bcook'): TransactionInstruction {
  return ixOf(program, [w(linearMarket(feed, program))], MARKETS_DISC.apply_market_risk);
}
export function cancelMarketRiskIx(admin: PublicKey, feed: string, program: PerpsProgram = 'bcook'): TransactionInstruction {
  return ixOf(program, [signer(admin), w(linearMarket(feed, program))], MARKETS_DISC.cancel_market_risk);
}
/** Admin, once per market after the upgrade: convert the v3 ledger to v4 (idempotent). */
export function migrateMarketIx(admin: PublicKey, feed: string, program: PerpsProgram = 'bcook'): TransactionInstruction {
  return ixOf(program, [w(admin, true), w(linearMarket(feed, program)), ro(SystemProgram.programId)], MARKETS_DISC.migrate_market);
}
/** Admin, once after the upgrade: grow the settlement oracle to the v4 size (idempotent). */
export function migratePoolOracleIx(admin: PublicKey, program: PerpsProgram = 'bcook'): TransactionInstruction {
  return ixOf(program, [w(admin, true), w(settleOracleAccount(program)), ro(SystemProgram.programId)], MARKETS_DISC.migrate_pool_oracle);
}
/** Pool-oracle parameters are `setPoolParamsIx` (poolMarkets.ts): since v4 a loosening waits for the timelock. */
export function applyPoolParamsIx(feed: string, program: PerpsProgram = 'bcook'): TransactionInstruction {
  return ixOf(program, [w(poolOracleAccount(feed, program))], MARKETS_DISC.apply_pool_params);
}
export function cancelPoolParamsIx(admin: PublicKey, feed: string, program: PerpsProgram = 'bcook'): TransactionInstruction {
  return ixOf(program, [signer(admin), w(poolOracleAccount(feed, program))], MARKETS_DISC.cancel_pool_params);
}

// --- margin, insurance, delayed payouts ---------------------------------------------------

/** Add margin to one of the signer's own normal positions: no price, no order. Taking margin out is the `removeMargin` order action. */
export function addMarginIx(owner: PublicKey, feed: string, position: bigint, amount: bigint, program: PerpsProgram = 'bcook'): TransactionInstruction {
  return ixOf(
    program,
    [w(owner, true), w(marketsTokenAccount(owner, program)), w(linearMarket(feed, program)), w(linearVault(feed, program)), ro(perpsDeployment(program).mint), ro(perpsDeployment(program).tokenProgram)],
    cat(Uint8Array.from(MARKETS_DISC.add_margin), u64(position), u64(amount)),
  );
}
/** Donate to a market's insurance fund (anyone may). */
export function fundInsuranceIx(owner: PublicKey, feed: string, amount: bigint, program: PerpsProgram = 'bcook'): TransactionInstruction {
  return ixOf(
    program,
    [w(owner, true), w(marketsTokenAccount(owner, program)), w(linearMarket(feed, program)), w(linearVault(feed, program)), ro(perpsDeployment(program).mint), ro(perpsDeployment(program).tokenProgram)],
    cat(Uint8Array.from(MARKETS_DISC.fund_insurance), u64(amount)),
  );
}
/** Permissionless: pay a delayed payout to its owner once due. A pool member passes its pool (`ledger.pool.pool`) and the pool's vault. */
export function settleClaimIx(feed: string, claim: bigint, owner: PublicKey, pool?: { pool: PublicKey; vault: PublicKey } | null, program: PerpsProgram = 'bcook'): TransactionInstruction {
  const d = perpsDeployment(program);
  return ixOf(
    program,
    [w(marketsTokenAccount(owner, program)), w(linearMarket(feed, program)), w(linearVault(feed, program)), ro(d.mint), ro(d.tokenProgram), ro(settleOracleAccount(program)), ...(pool ? [w(pool.pool), w(pool.vault)] : [])],
    cat(Uint8Array.from(MARKETS_DISC.settle_claim), u64(claim)),
  );
}
export const CLAIM_STALE_SECONDS = 72 * 3_600;
/**
 * What a due claim pays (`LinearMarket::claim_payout`): a gain at the higher of the
 * close's high end and the average settlement TWAP since the close (fewer COOK);
 * a loss claim loses `ceil(basis x (reference - m) / m)` more of what was held,
 * with m the lower of the close's low end and the average. `cumNow`/`cumNowAt`
 * are the settlement oracle's cumulative (`PoolOracleState.cum`). Null: not due,
 * or the oracle has not advanced past the due time yet.
 */
export function claimPayout(c: LinearClaim, cumNow: bigint, cumNowAt: number, now: number): { paid: bigint; toLp: bigint; average: bigint } | null {
  if (now < c.dueAt) return null;
  const span = cumNowAt - c.cumAt;
  let average: bigint;
  if (cumNowAt >= c.dueAt || (now >= c.dueAt + CLAIM_STALE_SECONDS && span > 0)) {
    if (span <= 0 || cumNow < c.cum) return null;
    const a = (cumNow - c.cum) / BigInt(span);
    average = a > U64_MAX ? U64_MAX : a < 1n ? 1n : a;
  } else if (now >= c.dueAt + CLAIM_STALE_SECONDS) {
    average = c.reference;
  } else {
    return null;
  }
  const reference = c.reference < 1n ? 1n : c.reference;
  if (c.kind === 'gain') {
    const price = reference > average ? reference : average;
    const paid = (c.amount * reference) / price;
    return { paid, toLp: c.amount - paid, average };
  }
  const m = (reference < average ? reference : average) || 1n;
  const raw = (c.basis * (reference - m) + m - 1n) / m;
  const extra = raw > c.amount ? c.amount : raw;
  return { paid: c.amount - extra, toLp: extra, average };
}

// --- margin removal, liquidation ordering, display ---------------------------------------

/**
 * The most margin a position may take out now (`LinearMarket::remove_margin`): what
 * remains must cover the initial margin of its tier at the band's low end, and so
 * must what remains after any loss and the closing fee. Unrealized profit does not count.
 * Zero when none can come out (a wick-proof position never can).
 */
export function maxRemovableMargin(
  p: LinearPosition, ledger: Pick<LinearLedger, 'limits' | 'risk'>, q: LinearQuote, fundingIndex: bigint,
  mark: (p: LinearPosition, q: LinearQuote, fundingIndex: bigint) => { pnl: bigint; closingFee: bigint; liquidatable: boolean },
): bigint {
  if (p.wick || !isBcookQuote(q)) return 0n;
  const lev = leverageForNotional(ledger.limits, ledger.risk, p.notionalUsdMicros);
  if (lev === null) return 0n;
  // Initial margin in shares at the low end, rounded up: usd x 1e24 / (settleLo x rate x lev).
  const usd = p.notionalUsdMicros * 1_000_000_000_000_000_000_000_000n;
  const den = q.settleLo * q.rateE9 * BigInt(lev);
  const im = (usd + den - 1n) / den;
  // Binary search the largest amount that passes (the checks are monotone in the amount).
  let lo = 0n, hi = p.margin - 1n;
  const ok = (amount: bigint): boolean => {
    const left = p.margin - amount;
    if (left < im || left <= 0n) return false;
    const m = mark({ ...p, margin: left }, q, fundingIndex);
    const loss = m.pnl < 0n ? -m.pnl : 0n;
    const net = left - loss - m.closingFee;
    return net >= im && !m.liquidatable;
  };
  if (hi < 1n || !ok(1n)) return 0n;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (ok(mid)) lo = mid; else hi = mid - 1n;
  }
  return lo;
}
/** A position's leverage on its margin at the band's low end: notional / margin value. */
export function positionLeverage(p: Pick<LinearPosition, 'margin' | 'notionalUsdMicros'>, q: LinearQuote): number {
  const usd = marginUsdMicros(p.margin, q);
  return usd > 0n ? Number(p.notionalUsdMicros) / Number(usd) : Number.POSITIVE_INFINITY;
}
/** Positions in the order a liquidation keeper should try them: highest leverage first (the ones a move reaches first). */
export function liquidationOrder<T extends Pick<LinearPosition, 'margin' | 'notionalUsdMicros'>>(positions: readonly T[], q: LinearQuote): T[] {
  return [...positions].sort((a, b) => positionLeverage(b, q) - positionLeverage(a, q));
}
export type { LinearMarketState };

// --- launch settings ------------------------------------------------------------------------

/** One row of `launch-risk.json` (the golden file's sibling): a market's launch limits and risk. */
export interface LaunchMarket { limits: LinearLimits; risk: LinearRisk }
const usdMicros = (usd: number): bigint => BigInt(Math.round(usd * 1_000_000));
/**
 * The final upgrade's launch settings for a market, from the table in
 * `protocol/perps-v2/perps-program/tests/fixtures/launch-risk.json` (`table`): leverage per market and size,
 * maintenance at half the initial margin of the top leverage, a 5% liquidator share of the margin, insurance 20% of
 * fees, bankruptcy liquidation on, the breaker at the 99.99th percentile 10 s move, every win delayed two hours
 * and losses beyond $5 revalued. All of it is an admin setting (`setMarketRiskIx`); tightening applies at once and
 * loosening waits the config's timelock.
 */
export function launchMarketSettings(
  feed: string,
  table: { common: Record<string, any>; markets: Record<string, any> },
): LaunchMarket {
  const c = table.common;
  const m = table.markets[feed];
  if (!m) throw new Error(`no launch settings for ${feed}`);
  const limits: LinearLimits = { maxNotionalUsdMicros: usdMicros(c.maxNotionalUsd), maxPositions: c.maxPositions, maxLeverage: m.maxLeverage };
  const risk: LinearRisk = {
    tiers: (m.tiers as [number, number][]).map(([usd, lev]) => ({ maxNotionalUsdMicros: usdMicros(usd), maxLeverage: lev })),
    maintenanceBps: m.maintenanceBps, liquidationFeeBps: c.liquidationFeeBps, feeBps: c.feeBps, protocolBps: c.protocolBps, insuranceBps: c.insuranceBps,
    holderBps: c.holderBps, fundingBpsPerHour: c.fundingBpsPerHour, breakerMaxLeverage: m.breakerMaxLeverage, liquidateBankrupt: c.liquidateBankrupt,
    insuranceCap: U64_MAX, breakerMoveBps: m.breakerMoveBps, breakerSeconds: c.breakerSeconds, deferGainUsd: usdMicros(c.deferGainUsd),
    deferLossUsd: usdMicros(c.deferLossUsd), deferWindowSeconds: c.deferWindowSeconds,
  };
  return { limits, risk };
}
