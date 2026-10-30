/**
 * What `refresh_obligation` would write, computed without sending it.
 *
 * ## Why this exists
 *
 * An obligation's `borrowedValue`, `unhealthyBorrowValue` and the rest are
 * written by `refresh_obligation` and by nothing else. Every user action after
 * a refresh -- `borrow`, `repay`, `deposit_collateral`, `withdraw_collateral`,
 * `liquidate` -- changes principal or shares, marks the obligation `stale`, and
 * leaves those values where they were. A client that reads them therefore sees
 * the position as it stood *before* the user's last action.
 *
 * For a fresh borrow that is zero debt. On the live market on 2026-09-14 both
 * open borrows (516,000 and 82,594 COOK) read as zero this way, which is why a
 * liquidator that trusted the cached values could never have acted on either.
 *
 * So anything that has to judge a position -- a liquidator, a monitor, an
 * alert -- projects the refresh instead: accrue every reserve the position
 * touches to the slot in question, then value every entry exactly as the
 * program does. `config/keeper-vectors.json` holds the program's own results
 * for a spread of positions and `sdk/test/keeper-vectors.test.ts` requires this
 * file to reproduce them to the unit.
 *
 * ## What it cannot know
 *
 * The oracle. `refresh_obligation` values collateral at the oracle's accepted
 * reference, and a `refresh_oracle` in the same transaction may move that
 * reference if the stake pool has entered a new epoch since the last crank.
 * The projection uses the reference as stored. A keeper therefore uses it to
 * decide what to *try*, and simulates the real bundle before sending anything:
 * the program stays the judge.
 */

import { BPS, FIXED_POINT_SCALE } from './constants.js';
import { OracleHealth, permits, RiskAction, type OracleStateAccount } from './oracle.js';
import type { ObligationAccount, ReserveAccount } from './types.js';

const tenPow = (decimals: number): bigint => 10n ** BigInt(decimals);
const floorDiv = (a: bigint, b: bigint): bigint => a / b;
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** `Reserve::current_borrowed_amount`: principal times index, rounded up. */
export function currentBorrowedAmount(reserve: Pick<ReserveAccount, 'borrowedPrincipal' | 'borrowIndex'>): bigint {
  return ceilDiv(reserve.borrowedPrincipal * reserve.borrowIndex, FIXED_POINT_SCALE);
}

/** `Reserve::gross_liquidity`. */
export function grossLiquidityOf(reserve: ReserveAccount): bigint {
  return reserve.availableLiquidity + currentBorrowedAmount(reserve);
}

/** `Reserve::total_liquidity`: gross less the protocol's accrued fees. */
export function totalLiquidityOf(reserve: ReserveAccount): bigint {
  return grossLiquidityOf(reserve) - reserve.accruedFees;
}

/** `Reserve::utilization_bps`. */
export function utilizationBpsOf(reserve: ReserveAccount): bigint {
  const gross = grossLiquidityOf(reserve);
  if (gross === 0n) return 0n;
  return floorDiv(currentBorrowedAmount(reserve) * BPS, gross);
}

/** `Reserve::borrow_rate_bps`: the kinked curve. */
export function borrowRateBpsOf(reserve: ReserveAccount): bigint {
  const utilization = utilizationBpsOf(reserve);
  const kink = BigInt(reserve.config.optimalUtilizationBps);
  const min = BigInt(reserve.config.minBorrowRateBps);
  const optimal = BigInt(reserve.config.optimalBorrowRateBps);
  const max = BigInt(reserve.config.maxBorrowRateBps);
  if (utilization <= kink) {
    return min + floorDiv((optimal - min) * utilization, kink);
  }
  return optimal + floorDiv((max - optimal) * (utilization - kink), BPS - kink);
}

/** `Reserve::borrow_rate_per_slot`, FIXED_POINT_SCALE-scaled. */
export function borrowRatePerSlotOf(reserve: ReserveAccount): bigint {
  return floorDiv(borrowRateBpsOf(reserve) * FIXED_POINT_SCALE, BPS * reserve.config.slotsPerYear);
}

/**
 * `Reserve::accrue_interest`, applied to a copy.
 *
 * One multiply per accrual: `index x (1 + rate_per_slot x elapsed)`, floored,
 * with the protocol's cut of the new interest floored in the suppliers'
 * favour. A slot at or before the reserve's own is returned unchanged.
 */
export function accrueReserve(reserve: ReserveAccount, slot: bigint): ReserveAccount {
  if (slot <= reserve.lastUpdateSlot) return reserve;
  const elapsed = slot - reserve.lastUpdateSlot;
  if (reserve.borrowedPrincipal === 0n) {
    return { ...reserve, lastUpdateSlot: slot };
  }
  const borrowedBefore = currentBorrowedAmount(reserve);
  const growth = FIXED_POINT_SCALE + borrowRatePerSlotOf(reserve) * elapsed;
  const borrowIndex = floorDiv(reserve.borrowIndex * growth, FIXED_POINT_SCALE);
  const borrowedAfter = currentBorrowedAmount({ borrowedPrincipal: reserve.borrowedPrincipal, borrowIndex });
  const interest = borrowedAfter > borrowedBefore ? borrowedAfter - borrowedBefore : 0n;
  const fee = floorDiv(interest * BigInt(reserve.config.reserveFactorBps), BPS);
  return {
    ...reserve,
    borrowIndex,
    accruedFees: reserve.accruedFees + fee,
    lastUpdateSlot: slot,
  };
}

/** `Reserve::shares_to_liquidity(_, Rounding::Down)`. Divides by `max(supply, 1)`. */
export function sharesToLiquidityDown(reserve: ReserveAccount, shares: bigint): bigint {
  const supply = reserve.shareMintSupply > 0n ? reserve.shareMintSupply : 1n;
  return floorDiv(shares * totalLiquidityOf(reserve), supply);
}

/** `Reserve::liquidity_to_shares(_, Rounding::Down)`. The first deposit mints 1:1. */
export function liquidityToSharesDown(reserve: ReserveAccount, liquidity: bigint): bigint {
  if (reserve.shareMintSupply === 0n) return liquidity;
  const pool = totalLiquidityOf(reserve);
  return floorDiv(liquidity * reserve.shareMintSupply, pool > 0n ? pool : 1n);
}

/** `math::market_value`. */
export function marketValueOf(amount: bigint, decimals: number, priceScaled: bigint, rounding: 'up' | 'down'): bigint {
  const divisor = tenPow(decimals);
  return rounding === 'up' ? ceilDiv(amount * priceScaled, divisor) : floorDiv(amount * priceScaled, divisor);
}

/** `math::value_to_amount`, flooring. */
export function valueToAmountDown(valueScaled: bigint, decimals: number, priceScaled: bigint): bigint {
  if (priceScaled === 0n) return 0n;
  return floorDiv(valueScaled * tenPow(decimals), priceScaled);
}

/** `risk::apply_haircut`. */
export function applyHaircutOf(value: bigint, haircutBps: number): bigint {
  return floorDiv(value * (BPS - BigInt(haircutBps)), BPS);
}

/** `Obligation::debt_at`: one entry's principal at an index, rounded up. */
export function debtAt(principal: bigint, borrowIndex: bigint): bigint {
  return ceilDiv(principal * borrowIndex, FIXED_POINT_SCALE);
}

export interface ProjectedCollateral {
  reserve: ReserveAccount;
  oracle: OracleStateAccount;
  depositedShares: bigint;
  /** What the shares redeem for, in the collateral's base units. */
  liquidity: bigint;
  /** Face value at the oracle's effective rate, floored. */
  marketValue: bigint;
  /** After the reserve's haircut. */
  effectiveValue: bigint;
}

export interface ProjectedBorrow {
  reserve: ReserveAccount;
  oracle: OracleStateAccount;
  borrowedPrincipal: bigint;
  /** What is owed at the accrued index, rounded up. */
  debt: bigint;
  /** Debt value at the oracle's effective rate, rounded up. */
  marketValue: bigint;
}

export interface ProjectedObligation {
  obligation: ObligationAccount;
  slot: bigint;
  depositedValue: bigint;
  effectiveCollateralValue: bigint;
  allowedBorrowValue: bigint;
  unhealthyBorrowValue: bigint;
  borrowedValue: bigint;
  pricesStressed: boolean;
  /** `unhealthy / borrowed` in bps, floored. `null` when nothing is owed. */
  healthFactorBps: bigint | null;
  liquidatable: boolean;
  deposits: ProjectedCollateral[];
  borrows: ProjectedBorrow[];
}

export class ProjectionError extends Error {}

/**
 * Project `refresh_obligation` at `slot`.
 *
 * `reserves` is keyed by reserve address, `oracles` by oracle address (the
 * reserve's `oracle` field), both as read from chain. Reserves are accrued to
 * `slot` here, so pass them as stored. Throws `ProjectionError` when an account
 * the position depends on is missing or the oracle has no reference -- cases
 * where the program would refuse the refresh too.
 */
export function projectObligation(
  obligation: ObligationAccount,
  reserves: ReadonlyMap<string, ReserveAccount>,
  oracles: ReadonlyMap<string, OracleStateAccount>,
  slot: bigint,
): ProjectedObligation {
  const accrued = new Map<string, ReserveAccount>();
  const reserveAt = (address: string): ReserveAccount => {
    const cached = accrued.get(address);
    if (cached) return cached;
    const stored = reserves.get(address);
    if (!stored) throw new ProjectionError(`reserve ${address} was not read`);
    if (!stored.market.equals(obligation.market)) {
      throw new ProjectionError(`reserve ${address} belongs to another market`);
    }
    const next = accrueReserve(stored, slot);
    accrued.set(address, next);
    return next;
  };
  const oracleFor = (reserve: ReserveAccount): OracleStateAccount => {
    const oracle = oracles.get(reserve.oracle.toBase58());
    if (!oracle) throw new ProjectionError(`oracle ${reserve.oracle.toBase58()} was not read`);
    if (oracle.reference.effectiveRate === 0n && oracle.reference.grossRate === 0n) {
      throw new ProjectionError(`oracle ${reserve.oracle.toBase58()} has no accepted reference`);
    }
    return oracle;
  };
  const stressed = (oracle: OracleStateAccount) => !permits(oracle.health as OracleHealth, RiskAction.Borrow);

  let depositedValue = 0n;
  let effectiveCollateralValue = 0n;
  let allowedBorrowValue = 0n;
  let unhealthyBorrowValue = 0n;
  let pricesStressed = false;
  const deposits: ProjectedCollateral[] = [];

  for (const entry of obligation.deposits) {
    const reserve = reserveAt(entry.reserve.toBase58());
    const oracle = oracleFor(reserve);
    const price = oracle.reference.effectiveRate;
    const liquidity = sharesToLiquidityDown(reserve, entry.depositedShares);
    const face = marketValueOf(liquidity, reserve.liquidityDecimals, price, 'down');
    const effective = applyHaircutOf(face, reserve.config.collateralHaircutBps);
    pricesStressed ||= stressed(oracle);
    depositedValue += face;
    effectiveCollateralValue += effective;
    allowedBorrowValue += floorDiv(effective * BigInt(reserve.config.loanToValueBps), BPS);
    unhealthyBorrowValue += floorDiv(effective * BigInt(reserve.config.liquidationThresholdBps), BPS);
    deposits.push({ reserve, oracle, depositedShares: entry.depositedShares, liquidity, marketValue: face, effectiveValue: effective });
  }

  let borrowedValue = 0n;
  const borrows: ProjectedBorrow[] = [];
  for (const entry of obligation.borrows) {
    const reserve = reserveAt(entry.reserve.toBase58());
    const oracle = oracleFor(reserve);
    const debt = debtAt(entry.borrowedPrincipal, reserve.borrowIndex);
    const value = marketValueOf(debt, reserve.liquidityDecimals, oracle.reference.effectiveRate, 'up');
    pricesStressed ||= stressed(oracle);
    borrowedValue += value;
    borrows.push({ reserve, oracle, borrowedPrincipal: entry.borrowedPrincipal, debt, marketValue: value });
  }

  return {
    obligation,
    slot,
    depositedValue,
    effectiveCollateralValue,
    allowedBorrowValue,
    unhealthyBorrowValue,
    borrowedValue,
    pricesStressed,
    healthFactorBps: borrowedValue === 0n ? null : floorDiv(unhealthyBorrowValue * BPS, borrowedValue),
    liquidatable: borrowedValue > unhealthyBorrowValue,
    deposits,
    borrows,
  };
}

/** The accrued copy of every reserve a projection touched, by address. */
export function accruedReserves(projection: ProjectedObligation): Map<string, ReserveAccount> {
  const out = new Map<string, ReserveAccount>();
  for (const entry of [...projection.deposits, ...projection.borrows]) {
    out.set(entry.reserve.address.toBase58(), entry.reserve);
  }
  return out;
}
