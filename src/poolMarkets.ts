/**
 * The pool oracle `["pool-oracle", "MCOOK"]` (docs/COOK_PERP.md,
 * docs/BCOOK_SETTLEMENT.md): COOK-PERP's asset price AND, on the bCOOK
 * program, every market's settlement price.
 *
 * The program reads two pinned SOL/COOK pools itself (`post_pool_price`),
 * keeps a clamped time-weighted average, and publishes `{twap, spot_lo,
 * spot_hi, oi_cap}` plus the publication it replaced
 * (`previous_published_at`, bCOOK program only: the first-price rule for the
 * settlement price). COOK-PERP fills every action at the price worse for
 * whoever acts; every linear market converts USD to bCOOK at the band end
 * worse for the trader (`settlementBand`, `perpsMarkets.ts`).
 */
import { PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
import {
  MARKETS_DISC,
  configAccount,
  linearPriceAccount,
  perpsDeployment,
  poolOracleAccount,
  solPriceAccount,
  type LinearLedger,
  type LinearQuote,
  type PerpsProgram,
} from './perpsMarkets.js';
import { cookFeedAccount } from './cookFeed.js';

/** One market unit: `MCOOK` is a million whole COOK. Prices are USD micros per unit. */
export const POOL_UNIT_TOKENS = 1_000_000n;
/** COOK is Cookie Chain's native token; its pools trade the wrapped mint. */
export const COOK_MINT = new PublicKey('So11111111111111111111111111111111111111112');
/** Bridged SOL: the quote side of both pools. */
export const POOL_SOL_MINT = new PublicKey('6tL24Fn75uCMrBSZAvohAq57LSv6KrY6ceEq1wonvucb');
const INSTRUCTIONS_SYSVAR = new PublicKey('Sysvar1nstructions1111111111111111111111111');
/** `PoolOracle` account sizes: the bCOOK program's quote carries `previous_published_at` (+8 bytes). */
/** The v4 account size (`migrate_pool_oracle`): the v3 account plus the cumulative TWAP and the pending-parameters slot. */
export const POOL_ORACLE_SPACE = 1_576;
/** The deployed v3 size, where the v4 tail starts. */
export const POOL_ORACLE_SPACE_V3 = 1_516;
export const POOL_ORACLE_SPACE_ASOL_V2 = 1_508;

export interface PoolPin {
  /** 0 = Meteora DAMM v2 (Cookiebox), 1 = SPL Token Swap V1 (CookieSwap). */
  kind: number;
  pool: PublicKey;
  tokenVault: PublicKey;
  solVault: PublicKey;
  ammProgram: PublicKey;
  ammProgramData: PublicKey;
  deploySlot: bigint;
}
export interface PoolParams {
  twapWindowS: number;
  spacingS: number;
  stepBps: number;
  maxDevBps: number;
  minPoolDepth: bigint;
  minSamples: number;
  minSpanS: number;
  oiShareBps: number;
}

/**
 * The two SOL/COOK pools, read from chain on 2026-10-14 (and still the live
 * pins of the retired program's oracle on 2026-10-22). In both, SOL is token
 * A and COOK token B. An AMM upgrade changes its deploy slot and halts the
 * price until re-pinned (`set_pool_pins`); `scripts/perps-bcook/init.mjs`
 * re-reads all of it from chain before creating the oracle.
 */
export const COOK_POOL_PINS: readonly [PoolPin, PoolPin] = [
  {
    kind: 0,
    pool: new PublicKey('BdS7Bb3PQqia8tLezZJeYpRdNT28eHXeYCtJAaJYsZHh'),
    tokenVault: new PublicKey('8QqRYuudu6HnX7WpghgvRQqdxPKbbR5AeGSje1oKzvok'),
    solVault: new PublicKey('Ek1C48fPqJAeH1yotXbJyhxBT24z8a5nPjC9EBv6cxBa'),
    ammProgram: new PublicKey('DAMMjDCEFTDkt7ywazZS8GoaLtjb3HaJo3pLbf64xrPY'),
    ammProgramData: new PublicKey('6ztSm42C4aAAqZeEcAshzHDUUAxRL4T9ejZf5tEWPrgS'),
    deploySlot: 3_176_591n,
  },
  {
    kind: 1,
    pool: new PublicKey('6ypW7svZFRFgTgWCDxHrXSsiaMmnZTDsxd26e3s2kTza'),
    tokenVault: new PublicKey('D1x5PJLxpadW2sFutE91426yFYWmuoRQ41dH9b8TBqkj'),
    solVault: new PublicKey('HeeFv1QmekUeMsq2QVggViQ4i2U8dWczwYswoe1eUWri'),
    ammProgram: new PublicKey('xYBN2zddsqSy41tg1yD9nJScCmqquZnHUyzXBfLEqC8'),
    ammProgramData: new PublicKey('2Cv2g4Fu3FRq5EVhFkGu457MykhbCXcFk6UZF6srnUvz'),
    deploySlot: 12_044_993n,
  },
];
/**
 * The launch parameters (docs/BCOOK_SETTLEMENT.md section 8.3.2): TWAP 1 h,
 * a sample every 120 s clamped to 1%, pools within 3%, 0.1 SOL each, 15
 * samples over 30 min, and the books' reserved caps within 25% of the
 * thinnest depth (`oiShareBps` 2,500).
 */
export const COOK_POOL_PARAMS: PoolParams = {
  twapWindowS: 3_600,
  spacingS: 120,
  stepBps: 100,
  maxDevBps: 300,
  minPoolDepth: 100_000_000n,
  minSamples: 15,
  minSpanS: 1_800,
  oiShareBps: 2_500,
};

export interface PoolQuote {
  feed: string;
  /** The `FeedPrice.published_at` written by the same post; 0 until published. */
  publishedAt: number;
  twapUsdMicros: bigint;
  spotLoUsdMicros: bigint;
  spotHiUsdMicros: bigint;
  /** The open-interest ceiling at that post, USD micros: the settlement capacity's source. */
  oiCapUsdMicros: bigint;
  /**
   * The `publishedAt` this post replaced (bCOOK program; 0 before the first):
   * an order fills only on the FIRST settlement post of its window
   * (`firstInWindow`). Absent on the retired program's oracle.
   */
  previousPublishedAt?: number;
}
export interface PoolSample { priceE18: bigint; at: number; depth: bigint }
export interface PoolOracleState {
  quote: PoolQuote;
  tokenMint: PublicKey;
  pins: [PoolPin, PoolPin];
  params: PoolParams;
  /** Recorded samples, oldest first. */
  samples: PoolSample[];
  /**
   * v4 (after `migrate_pool_oracle`): the cumulative of the published TWAP,
   * USD micros per MCOOK times seconds, current to `cumAt`; delayed settlement
   * averages the TWAP over a window as the difference of two readings. Null on a
   * v3 account.
   */
  cum: { cum: bigint; cumAt: number } | null;
  /** A loosening parameter change waiting for its timelock (v4 only). */
  pending: { params: PoolParams; effectiveAt: number } | null;
}

class R {
  o = 0;
  constructor(private d: Uint8Array) {}
  private v() { return new DataView(this.d.buffer, this.d.byteOffset + this.o); }
  u8() { const x = this.d[this.o]!; this.o += 1; return x; }
  u16() { const x = this.v().getUint16(0, true); this.o += 2; return x; }
  u32() { const x = this.v().getUint32(0, true); this.o += 4; return x; }
  u64() { const x = this.v().getBigUint64(0, true); this.o += 8; return x; }
  i64() { const x = this.v().getBigInt64(0, true); this.o += 8; return x; }
  u128() { const lo = this.u64(); const hi = this.u64(); return (hi << 64n) | lo; }
  key() { const k = new PublicKey(this.d.subarray(this.o, this.o + 32)); this.o += 32; return k; }
  feed() { const b = this.d.subarray(this.o, this.o + 32); this.o += 32; const n = b.indexOf(0); return new TextDecoder().decode(b.subarray(0, n < 0 ? 32 : n)); }
}

/**
 * A `PoolOracle` account. The bCOOK program's quote carries
 * `previous_published_at` after `oi_cap` (8 bytes, the account is 1,516
 * bytes); the retired program's does not (1,508). `program` picks the
 * layout; without it a 1,508-byte account reads as the retired one.
 */
export function decodePoolOracle(d: Uint8Array, program?: PerpsProgram): PoolOracleState {
  if (d.length < 8 || !MARKETS_DISC.PoolOracle.every((b, i) => d[i] === b)) throw new Error('not a perps PoolOracle');
  const layout: PerpsProgram = program ?? (d.length === POOL_ORACLE_SPACE_ASOL_V2 ? 'asol-v2' : 'bcook');
  const r = new R(d);
  r.o = 8;
  const quote: PoolQuote = {
    feed: r.feed(),
    publishedAt: Number(r.i64()),
    twapUsdMicros: r.u64(),
    spotLoUsdMicros: r.u64(),
    spotHiUsdMicros: r.u64(),
    oiCapUsdMicros: r.u64(),
  };
  if (layout === 'bcook') quote.previousPublishedAt = Number(r.i64());
  const tokenMint = r.key();
  const pin = (): PoolPin => ({ kind: r.u8(), pool: r.key(), tokenVault: r.key(), solVault: r.key(), ammProgram: r.key(), ammProgramData: r.key(), deploySlot: r.u64() });
  const pins: [PoolPin, PoolPin] = [pin(), pin()];
  const params: PoolParams = {
    twapWindowS: r.u32(), spacingS: r.u32(), stepBps: r.u16(), maxDevBps: r.u16(),
    minPoolDepth: r.u64(), minSamples: r.u8(), minSpanS: r.u32(), oiShareBps: r.u16(),
  };
  const n = r.u32();
  const ring: PoolSample[] = [];
  for (let i = 0; i < n; i++) ring.push({ priceE18: r.u128(), at: Number(r.i64()), depth: r.u64() });
  const head = r.u8();
  const count = r.u8();
  r.u8(); // bump
  const samples = Array.from({ length: count }, (_, i) => ring[(head + n - count + i) % n]!);
  let cum: PoolOracleState['cum'] = null;
  let pending: PoolOracleState['pending'] = null;
  if (layout === 'bcook' && d.length >= POOL_ORACLE_SPACE) {
    cum = { cum: r.u128(), cumAt: Number(r.i64()) };
    if (r.u8() === 1) {
      const p: PoolParams = { twapWindowS: r.u32(), spacingS: r.u32(), stepBps: r.u16(), maxDevBps: r.u16(), minPoolDepth: r.u64(), minSamples: r.u8(), minSpanS: r.u32(), oiShareBps: r.u16() };
      pending = { params: p, effectiveAt: Number(r.i64()) };
    }
  }
  return { quote, tokenMint, pins, params, samples, cum, pending };
}

// --- instructions -----------------------------------------------------------------

const w = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });
const ro = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
const programId = (program: PerpsProgram) => perpsDeployment(program).programId;

/**
 * Read both pools and publish. It must be the only instruction in its
 * transaction besides ComputeBudget, and follow a fresh SOL price (`["price"]`):
 * the pool price carries the SOL price's publication time.
 */
export function postPoolPriceIx(feed: string, payer: PublicKey, pins: readonly [PoolPin, PoolPin], program: PerpsProgram = 'bcook'): TransactionInstruction {
  const [a, b] = pins;
  return new TransactionInstruction({
    programId: programId(program),
    keys: [
      w(payer, true), w(poolOracleAccount(feed, program)), w(linearPriceAccount(feed, program)), ro(solPriceAccount(program)),
      ...(program === 'bcook' ? [ro(configAccount(program))] : []),
      ro(a.pool), ro(a.tokenVault), ro(a.solVault), ro(a.ammProgramData),
      ro(b.pool), ro(b.tokenVault), ro(b.solVault), ro(b.ammProgramData),
      ro(INSTRUCTIONS_SYSVAR), ro(SystemProgram.programId),
      // 0.5.0: which source publishes (cook.rs). LAST on purpose: a program that predates it ignores a trailing account.
      ...(program === 'bcook' ? [ro(cookFeedAccount(program))] : []),
    ],
    data: Buffer.from(MARKETS_DISC.post_pool_price),
  });
}

const u8 = (v: number) => Uint8Array.of(v);
const u16 = (v: number) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); return b; };
const u32 = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; };
const u64 = (v: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); return b; };
const cat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
export const encodePoolPin = (p: PoolPin) => cat(u8(p.kind), p.pool.toBytes(), p.tokenVault.toBytes(), p.solVault.toBytes(), p.ammProgram.toBytes(), p.ammProgramData.toBytes(), u64(p.deploySlot));
export const encodePoolParams = (p: PoolParams) =>
  cat(u32(p.twapWindowS), u32(p.spacingS), u16(p.stepBps), u16(p.maxDevBps), u64(p.minPoolDepth), u8(p.minSamples), u32(p.minSpanS), u16(p.oiShareBps));

/** Admin: create a pool feed's oracle (on bCOOK, MCOOK's is the settlement price). */
export function createPoolOracleIx(admin: PublicKey, feed: string, tokenMint: PublicKey, pins: readonly [PoolPin, PoolPin], params: PoolParams, program: PerpsProgram = 'bcook'): TransactionInstruction {
  const id = new TextEncoder().encode(feed);
  return new TransactionInstruction({
    programId: programId(program),
    keys: [w(admin, true), w(poolOracleAccount(feed, program)), ro(SystemProgram.programId)],
    data: Buffer.from(cat(Uint8Array.from(MARKETS_DISC.create_pool_oracle), u32(id.length), id, tokenMint.toBytes(), encodePoolPin(pins[0]), encodePoolPin(pins[1]), encodePoolParams(params))),
  });
}
/** Admin: change parameters (bounds enforced on chain; samples kept). */
export function setPoolParamsIx(admin: PublicKey, feed: string, params: PoolParams, program: PerpsProgram = 'bcook'): TransactionInstruction {
  return new TransactionInstruction({
    programId: programId(program),
    // v4: a loosening waits for the timelock (`apply_pool_params`), so the config account follows.
    keys: [{ pubkey: admin, isSigner: true, isWritable: false }, w(poolOracleAccount(feed, program)), ...(program === 'bcook' ? [ro(configAccount(program))] : [])],
    data: Buffer.from(cat(Uint8Array.from(MARKETS_DISC.set_pool_params), encodePoolParams(params))),
  });
}
/** Admin: re-pin the pools (an AMM upgrade). Samples are cleared; the last quote's time stays. */
export function setPoolPinsIx(admin: PublicKey, feed: string, pins: readonly [PoolPin, PoolPin], program: PerpsProgram = 'bcook'): TransactionInstruction {
  return new TransactionInstruction({
    programId: programId(program),
    keys: [{ pubkey: admin, isSigner: true, isWritable: false }, w(poolOracleAccount(feed, program))],
    data: Buffer.from(cat(Uint8Array.from(MARKETS_DISC.set_pool_pins), encodePoolPin(pins[0]), encodePoolPin(pins[1]))),
  });
}

// --- fills ------------------------------------------------------------------------

/** The lowest and highest of the average and both pools (`pool::band`, before the bCOOK fee fold). */
export function poolBand(q: PoolQuote): [bigint, bigint] {
  const lo = q.twapUsdMicros < q.spotLoUsdMicros ? q.twapUsdMicros : q.spotLoUsdMicros;
  const hi = q.twapUsdMicros > q.spotHiUsdMicros ? q.twapUsdMicros : q.spotHiUsdMicros;
  return [lo, hi];
}
/** COOK-PERP: buying exposure (open long, close short) fills at the top of the band; selling at the bottom. */
export function poolFillPrice(q: PoolQuote, buying: boolean): bigint {
  const [lo, hi] = poolBand(q);
  return buying ? hi : lo;
}
/** How far the pools stand from the average, in bps: what the band costs a trader right now. */
export function poolSpreadBps(q: PoolQuote): number {
  const [lo, hi] = poolBand(q);
  return q.twapUsdMicros > 0n ? Number(((hi - lo) * 10_000n) / q.twapUsdMicros) : 0;
}
/** Open notional now, USD micros, against the oracle's ceiling. */
export function poolOpenInterest(l: LinearLedger): bigint {
  return l.positions.reduce((n, p) => n + p.notionalUsdMicros, 0n);
}
/** A quote at another asset price, for marking a position at one end of COOK-PERP's band. */
export const poolQuoteAt = <Q extends LinearQuote>(q: Q, assetMicros: bigint): Q => ({ ...q, assetMicros });
/** USD per single token from a per-unit (1M token) price in micros, for display. */
export const usdPerToken = (unitMicros: bigint): number => Number(unitMicros) / 1e6 / Number(POOL_UNIT_TOKENS);
