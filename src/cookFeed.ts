/**
 * The signed COOK price (SDK 0.5.0; docs/BCOOK_SETTLEMENT.md, section 13).
 *
 * bCOOK perps convert every result at a COOK/USD settlement band built from
 * the COOK/SOL price. Until 0.5.0 that price came from two thin Cookie pools
 * (`post_pool_price`). The program now has a second source: Aera's five price
 * signers read the deep SOLANA COOK/SOL pool and sign its price and depth; any
 * wallet posts a quorum of four with `post_signed_cook`, and the program feeds
 * it into the same average, band and capacity (`cook-feed` account).
 *
 * Pinned by the `cook` section of
 * `protocol/perps-v2/perps-program/tests/fixtures/perps-bcook-golden.json`
 * (`test/cook-feed.test.ts`). The program is the authority.
 */
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { configAccount, linearPriceAccount, perpsDeployment, poolOracleAccount, solPriceAccount, type PerpsProgram } from './perpsMarkets.js';
import type { PoolPin } from './poolMarkets.js';

const INSTRUCTIONS_SYSVAR = new PublicKey('Sysvar1nstructions1111111111111111111111111');
const hex = (h: string): readonly number[] => Object.freeze([...Buffer.from(h, 'hex')]);
/** Anchor discriminators (golden `cook.instructions`, `cook.accountDiscriminator`). */
export const COOK_DISC = Object.freeze({
  init_cook_feed: hex('b232f7d76b8001b6'),
  set_cook_feed: hex('2fa001c847b8da27'),
  apply_cook_feed: hex('4497c86b9a192989'),
  cancel_cook_feed: hex('e7dc728f88dae82f'),
  post_signed_cook: hex('254ad6c3c1352186'),
  CookFeed: hex('ddbae564e8136103'),
});
/** The feed id the signers sign COOK pool readings under (zero-padded to 32 bytes on the wire). */
export const COOK_FEED_ID = 'COOKPOOL';
export const COOK_SOURCE = Object.freeze({ cookie: 0, signed: 1 } as const);
export type CookSource = (typeof COOK_SOURCE)[keyof typeof COOK_SOURCE];

/** `cook.rs` bounds (golden `cook.bounds`). */
export const COOK_BOUNDS = Object.freeze({
  shareBps: [1, 1_000] as const,
  fenceBps: [500, 5_000] as const,
  spreadBps: [20, 500] as const,
  leashBps: [50, 1_000] as const,
  ceilingUsdMicrosMax: 50_000_000_000n,
  minDepth: [10_000_000_000n, 100_000_000_000_000n] as const,
});
/** Account size, bytes (golden `cook.space`). */
export const COOK_FEED_SPACE = 93;

export interface CookSettings {
  /** 0 = the two Cookie pools publish; 1 = the signed Solana pool does. */
  source: CookSource;
  /** Open interest per market may be at most this share of the smallest signed depth in the window, bps. */
  shareBps: number;
  /** The signed price must sit within this of the nearer Cookie pool, or nothing posts. */
  fenceBps: number;
  /** The quorum's prices may differ by at most this, bps of the lowest. */
  spreadBps: number;
  /** The spot may sit at most this far from the last recorded sample, bps. */
  leashBps: number;
  /** Hard ceiling on open interest per market, USD micros (also bounds the Cookie source). */
  ceilingUsdMicros: bigint;
  /** The least signed depth (the pool's SOL side, lamports) the book accepts. */
  minDepth: bigint;
}
export interface CookFeedState {
  bump: number;
  active: CookSettings;
  pending: { settings: CookSettings; effectiveAt: number } | null;
  /** The newest signed timestamp accepted, seconds. */
  lastTs: number;
  /** Lamports per 1,000,000 COOK, as signed (median), and the pool's SOL side in lamports. */
  lastPrice: bigint;
  lastDepth: bigint;
  lastSigners: number;
}

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

/** `["cook-feed"]`: absent until `init_cook_feed` runs (the Cookie pools then publish, with no ceiling). */
export const cookFeedAccount = (program: PerpsProgram = 'bcook'): PublicKey =>
  PublicKey.findProgramAddressSync([new TextEncoder().encode('cook-feed')], perpsDeployment(program).programId)[0];

export function encodeCookSettings(s: CookSettings): Uint8Array {
  return cat(u8(s.source), u16(s.shareBps), u16(s.fenceBps), u16(s.spreadBps), u16(s.leashBps), u64(s.ceilingUsdMicros), u64(s.minDepth));
}
const SETTINGS_LEN = 25;
function readSettings(d: Uint8Array, at: number): CookSettings {
  const v = new DataView(d.buffer, d.byteOffset);
  return {
    source: d[at] as CookSource,
    shareBps: v.getUint16(at + 1, true), fenceBps: v.getUint16(at + 3, true), spreadBps: v.getUint16(at + 5, true), leashBps: v.getUint16(at + 7, true),
    ceilingUsdMicros: v.getBigUint64(at + 9, true), minDepth: v.getBigUint64(at + 17, true),
  };
}
export function decodeCookFeed(d: Uint8Array): CookFeedState {
  if (d.length < 8 || !COOK_DISC.CookFeed.every((b, i) => d[i] === b)) throw new Error('not a perps CookFeed');
  const v = new DataView(d.buffer, d.byteOffset);
  const bump = d[8]!;
  const active = readSettings(d, 9);
  let at = 9 + SETTINGS_LEN;
  let pending: CookFeedState['pending'] = null;
  if (d[at] === 1) {
    pending = { settings: readSettings(d, at + 1), effectiveAt: Number(v.getBigInt64(at + 1 + SETTINGS_LEN, true)) };
    at += 1 + SETTINGS_LEN + 8;
  } else at += 1;
  return { bump, active, pending, lastTs: Number(v.getBigInt64(at, true)), lastPrice: v.getBigUint64(at + 8, true), lastDepth: v.getBigUint64(at + 16, true), lastSigners: d[at + 24]! };
}
/** The settings in force at `now`: a due proposal counts whether or not anyone applied it. */
export const effectiveCookSettings = (f: CookFeedState, now: number): CookSettings => (f.pending && now >= f.pending.effectiveAt ? f.pending.settings : f.active);

/** Every bound of `CookSettings::validate`, as the problems found (empty: valid). */
export function cookSettingsProblems(s: CookSettings): string[] {
  const out: string[] = [];
  const within = (v: number | bigint, [lo, hi]: readonly [number | bigint, number | bigint]) => v >= lo && v <= hi;
  if (s.source !== 0 && s.source !== 1) out.push('source is 0 (Cookie pools) or 1 (signed)');
  if (!within(s.shareBps, COOK_BOUNDS.shareBps)) out.push('share 1-1,000 bp');
  if (!within(s.fenceBps, COOK_BOUNDS.fenceBps)) out.push('fence 500-5,000 bp');
  if (!within(s.spreadBps, COOK_BOUNDS.spreadBps)) out.push('spread 20-500 bp');
  if (!within(s.leashBps, COOK_BOUNDS.leashBps)) out.push('leash 50-1,000 bp');
  if (s.ceilingUsdMicros < 0n || s.ceilingUsdMicros > COOK_BOUNDS.ceilingUsdMicrosMax) out.push('ceiling $0-$50,000');
  if (!within(s.minDepth, COOK_BOUNDS.minDepth)) out.push('minimum depth 10-100,000 SOL');
  return out;
}
/** Whether `next` is no looser than `active` (applies at once); otherwise it waits the config's timelock. */
export const cookSettingsApplyAtOnce = (next: CookSettings, active: CookSettings): boolean =>
  next.source <= active.source && next.shareBps <= active.shareBps && next.fenceBps <= active.fenceBps && next.spreadBps <= active.spreadBps
  && next.leashBps <= active.leashBps && next.ceilingUsdMicros <= active.ceilingUsdMicros && next.minDepth >= active.minDepth;

/**
 * The open-interest ceiling per market a post would publish, USD micros: `shareBps` of the smallest signed depth
 * in the window (`minDepthLamports`) at `solUsdMicros`, never above the ceiling. Mirrors `pool::record_and_quote`.
 */
export function cookCapacity(s: Pick<CookSettings, 'shareBps' | 'ceilingUsdMicros'>, minDepthLamports: bigint, solUsdMicros: bigint): bigint {
  const share = (minDepthLamports * BigInt(s.shareBps) / 10_000n) * solUsdMicros / 1_000_000_000n;
  return share < s.ceilingUsdMicros ? share : s.ceilingUsdMicros;
}

/** Admin, once: create `["cook-feed"]` with its first settings (in force at once). Until it runs the Cookie pools publish. */
export function initCookFeedIx(admin: PublicKey, settings: CookSettings, program: PerpsProgram = 'bcook'): TransactionInstruction {
  return ixOf(program, [w(admin, true), w(cookFeedAccount(program)), ro(SystemProgram.programId)], cat(Uint8Array.from(COOK_DISC.init_cook_feed), encodeCookSettings(settings)));
}
/** Admin: new settings. No looser than in force: at once. Anything looser, the signed source included: after the config's timelock. */
export function setCookFeedIx(admin: PublicKey, settings: CookSettings, program: PerpsProgram = 'bcook'): TransactionInstruction {
  return ixOf(program, [signer(admin), w(cookFeedAccount(program)), ro(configAccount(program))], cat(Uint8Array.from(COOK_DISC.set_cook_feed), encodeCookSettings(settings)));
}
/** Anyone: persist a due proposal (readers use it whether or not this ran). */
export function applyCookFeedIx(program: PerpsProgram = 'bcook'): TransactionInstruction {
  return ixOf(program, [w(cookFeedAccount(program))], COOK_DISC.apply_cook_feed);
}
export function cancelCookFeedIx(admin: PublicKey, program: PerpsProgram = 'bcook'): TransactionInstruction {
  return ixOf(program, [signer(admin), w(cookFeedAccount(program))], COOK_DISC.cancel_cook_feed);
}

/** One signer's reading: lamports per 1,000,000 COOK and the pool's SOL side in lamports, under one signature. */
export interface CookPackage { price: bigint; depth: bigint; timestampMs: number; signature: Uint8Array }
export const encodeCookPackage = (p: CookPackage): Uint8Array => cat(u64(p.price), u64(p.depth), u64(BigInt(p.timestampMs)), p.signature);
/** The signed value: the price in the high 64 bits of the 128 the signers use, the depth in the low (one signature binds both). */
export const cookValue = (price: bigint, depth: bigint): bigint => (price << 64n) | depth;
export const splitCookValue = (value: bigint): { price: bigint; depth: bigint } => ({ price: value >> 64n, depth: value & ((1n << 64n) - 1n) });
/** Lamports per 1,000,000 COOK from the Solana pool's reserves (COOK has 6 decimals there; SOL 9). */
export function lamportsPerMillionCook(cookReserveBaseUnits: bigint, solReserveLamports: bigint): bigint {
  if (cookReserveBaseUnits <= 0n) throw new Error('empty COOK reserve');
  // 1,000,000 COOK = 1e12 base units.
  return (solReserveLamports * 1_000_000_000_000n) / cookReserveBaseUnits;
}

/**
 * `post_signed_cook`: a quorum of the signers' readings (at least the config's threshold, at most 12, one timestamp,
 * distinct signers, prices within the spread). Alone in its transaction (ComputeBudget aside); ask for about
 * 400,000 compute units. The Cookie pools are read only for the fence.
 */
export function postSignedCookIx(payer: PublicKey, pins: readonly [PoolPin, PoolPin], packages: readonly CookPackage[], program: PerpsProgram = 'bcook'): TransactionInstruction {
  const [a, b] = pins;
  return ixOf(program, [
    w(payer, true), w(cookFeedAccount(program)), w(poolOracleAccount('MCOOK', program)), w(linearPriceAccount('MCOOK', program)), ro(solPriceAccount(program)), ro(configAccount(program)),
    ro(a.pool), ro(a.tokenVault), ro(a.solVault), ro(a.ammProgramData),
    ro(b.pool), ro(b.tokenVault), ro(b.solVault), ro(b.ammProgramData),
    ro(INSTRUCTIONS_SYSVAR), ro(SystemProgram.programId),
  ], cat(Uint8Array.from(COOK_DISC.post_signed_cook), u32(packages.length), ...packages.map(encodeCookPackage)));
}
