/**
 * Client-side mirror of the protocol's arithmetic.
 *
 * Every function here reproduces a calculation the program performs, so the app
 * can preview a result before submitting. All of it is BigInt: the program is
 * integer-only, and doing these in floating point would make previews disagree
 * with outcomes by a base unit at exactly the moments that matter (at a cap, at
 * the borrow limit, at HF 1.0).
 *
 * Numbers are only produced at the very edge, for display.
 */

import { BPS, FIXED_POINT_SCALE } from './constants.js';
import type { ReserveAccount } from './types.js';

export const mulDivFloor = (a: bigint, b: bigint, d: bigint): bigint => {
  if (d === 0n) throw new Error('division by zero');
  return (a * b) / d;
};

export const mulDivCeil = (a: bigint, b: bigint, d: bigint): bigint => {
  if (d === 0n) throw new Error('division by zero');
  const product = a * b;
  return (product + d - 1n) / d;
};

/** Live debt owed to a reserve, rounded up as the program does. */
export const currentBorrowed = (reserve: ReserveAccount): bigint =>
  mulDivCeil(reserve.borrowedPrincipal, reserve.borrowIndex, FIXED_POINT_SCALE);

/** Everything the pool has claim to, borrowed or not. */
export const grossLiquidity = (reserve: ReserveAccount): bigint =>
  reserve.availableLiquidity + currentBorrowed(reserve);

/** The pool aCOOK is a claim on: gross liquidity minus the protocol's fees. */
export const totalLiquidity = (reserve: ReserveAccount): bigint =>
  grossLiquidity(reserve) - reserve.accruedFees;

/** Borrowed fraction of the pool, in basis points. */
export const utilizationBps = (reserve: ReserveAccount): bigint => {
  const gross = grossLiquidity(reserve);
  if (gross === 0n) return 0n;
  return mulDivFloor(currentBorrowed(reserve), BPS, gross);
};

/**
 * Borrow APR in bps from the kinked curve — the same two branches the program
 * uses:
 *
 *   u <= u*  ->  min + (optimal - min) * (u / u*)
 *   u >  u*  ->  optimal + (max - optimal) * ((u - u*) / (1 - u*))
 */
export const borrowRateBps = (reserve: ReserveAccount): bigint => {
  const u = utilizationBps(reserve);
  const kink = BigInt(reserve.config.optimalUtilizationBps);
  const min = BigInt(reserve.config.minBorrowRateBps);
  const optimal = BigInt(reserve.config.optimalBorrowRateBps);
  const max = BigInt(reserve.config.maxBorrowRateBps);

  if (u <= kink) return min + mulDivFloor(optimal - min, u, kink);
  return optimal + mulDivFloor(max - optimal, u - kink, BPS - kink);
};

/** Supply APR in bps: `r_borrow * u * (1 - reserve_factor)`. */
export const supplyRateBps = (reserve: ReserveAccount): bigint => {
  const afterUtilization = mulDivFloor(borrowRateBps(reserve), utilizationBps(reserve), BPS);
  const keep = BPS - BigInt(reserve.config.reserveFactorBps);
  return mulDivFloor(afterUtilization, keep, BPS);
};

/** What `shares` currently redeem for. */
export const sharesToLiquidity = (reserve: ReserveAccount, shares: bigint): bigint => {
  const supply = reserve.shareMintSupply;
  if (supply === 0n) return 0n;
  return mulDivFloor(shares, totalLiquidity(reserve), supply);
};

/** What `liquidity` currently buys. The first deposit mints 1:1. */
export const liquidityToShares = (reserve: ReserveAccount, liquidity: bigint): bigint => {
  if (reserve.shareMintSupply === 0n) return liquidity;
  const pool = totalLiquidity(reserve);
  return mulDivFloor(liquidity, reserve.shareMintSupply, pool > 0n ? pool : 1n);
};

/** Apply an asset's haircut to a face value. */
export const applyHaircut = (value: bigint, haircutBps: number): bigint =>
  mulDivFloor(value, BPS - BigInt(haircutBps), BPS);

/**
 * Quote-currency value of `amount` base units at `priceScaled`.
 * `priceScaled` already carries FIXED_POINT_SCALE.
 */
export const marketValue = (
  amount: bigint,
  decimals: number,
  priceScaled: bigint,
  round: 'up' | 'down' = 'down',
): bigint => {
  const divisor = 10n ** BigInt(decimals);
  return round === 'up'
    ? mulDivCeil(amount, priceScaled, divisor)
    : mulDivFloor(amount, priceScaled, divisor);
};

/** Inverse of {@link marketValue}. */
export const valueToAmount = (
  valueScaled: bigint,
  decimals: number,
  priceScaled: bigint,
  round: 'up' | 'down' = 'down',
): bigint => {
  const multiplier = 10n ** BigInt(decimals);
  return round === 'up'
    ? mulDivCeil(valueScaled, multiplier, priceScaled)
    : mulDivFloor(valueScaled, multiplier, priceScaled);
};

/** Remaining room under a cap. `0n` cap means "no cap", so the room is unbounded. */
export const capHeadroom = (cap: bigint, used: bigint): bigint | null => {
  if (cap === 0n) return null;
  return cap > used ? cap - used : 0n;
};

// --- display helpers, the only place Numbers appear ---

/** bps as a percentage number, e.g. `1000n` -> `10`. */
export const bpsToPercent = (bps: bigint): number => Number(bps) / 100;

/** Base units to a decimal number. Precision-lossy by design; display only. */
export const toDisplay = (amount: bigint, decimals: number): number =>
  Number(amount) / 10 ** decimals;

/** A decimal string to base units, without going through a float. */
export const fromDisplay = (value: string, decimals: number): bigint => {
  const trimmed = value.trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === '' || trimmed === '.') return 0n;
  const [whole = '', fraction = ''] = trimmed.split('.');
  const padded = fraction.slice(0, decimals).padEnd(decimals, '0');
  return BigInt(`${whole || '0'}${padded}`);
};

/** A FIXED_POINT_SCALE-scaled value as a display number. */
export const scaledToDisplay = (scaled: bigint): number =>
  Number((scaled * 1_000_000n) / FIXED_POINT_SCALE) / 1_000_000;
