/**
 * Health factor and borrow-limit reasoning.
 *
 * These are the numbers the UI must never guess at. Everything here reproduces
 * what the program computes in `refresh_obligation`, so a preview and an
 * outcome agree.
 *
 * ## Only projected positions
 *
 * Every function takes a position as `projectObligation` computes it, never an
 * `ObligationAccount`. The account's `borrowedValue`, `unhealthyBorrowValue`
 * and the rest are written by `refresh_obligation` alone and go stale at the
 * user's next action: a position whose last action was a borrow reads as owing
 * nothing. These helpers used to accept the account, so anything built on them
 * inherited that blind spot, which is exactly how the liquidator came to skip
 * the positions it existed to close. The types below make passing a cached
 * account a compile error rather than a silent wrong answer.
 */

import { BPS } from './constants.js';
import { applyHaircut, capHeadroom, currentBorrowed, marketValue, mulDivCeil, mulDivFloor, totalLiquidity } from './math.js';
import type { ProjectedObligation } from './projection.js';
import type { ReserveAccount, UserAccountView } from './types.js';

/**
 * The values health is judged from, as `refresh_obligation` would compute them
 * at the projection's slot. `healthFactorBps` and `liquidatable` exist only on a
 * projection, which is what keeps a stale `ObligationAccount` out.
 */
export type PositionValues = Pick<
  ProjectedObligation,
  'depositedValue' | 'effectiveCollateralValue' | 'allowedBorrowValue' | 'unhealthyBorrowValue' | 'borrowedValue' | 'healthFactorBps' | 'liquidatable'
>;

const ratio = (line: bigint, debt: bigint): number | null => (debt === 0n ? null : Number(mulDivFloor(line, 1_000_000n, debt)) / 1_000_000);

/**
 * Health factor as a display number: `liquidation_line / debt`.
 *
 * `null` means no debt. Render that as "∞" or "—", never as a large number: a
 * position with no debt has no ratio, and inventing one invites the reader to
 * compare it with a real one.
 */
export const healthFactor = (position: PositionValues | null): number | null =>
  // Scaled by 1e6 before the division so small differences survive the cast.
  position ? ratio(position.unhealthyBorrowValue, position.borrowedValue) : null;

/** Liquidation is possible below 1.0. This is the only hard line in the system. */
export const isLiquidatable = (position: PositionValues | null): boolean => position?.liquidatable ?? false;

/** How much more may be drawn right now, in quote-currency value. */
export const availableToBorrowValue = (position: PositionValues | null): bigint => {
  if (!position) return 0n;
  const room = position.allowedBorrowValue - position.borrowedValue;
  return room > 0n ? room : 0n;
};

/** Everything the dashboard needs about a position, derived once. */
export const userAccountView = (position: ProjectedObligation | null): UserAccountView => ({
  position,
  healthFactor: healthFactor(position),
  collateralValue: position?.depositedValue ?? 0n,
  effectiveCollateralValue: position?.effectiveCollateralValue ?? 0n,
  debtValue: position?.borrowedValue ?? 0n,
  borrowLimit: position?.allowedBorrowValue ?? 0n,
  liquidationLine: position?.unhealthyBorrowValue ?? 0n,
  availableToBorrow: availableToBorrowValue(position),
});

/**
 * Health factor if `borrowAmount` more were drawn from `reserve`, and what the
 * borrower actually receives.
 *
 * Debt value rounds **up**, exactly as the program does, so the preview is
 * never more optimistic than the transaction that follows.
 *
 * `borrowAmount` is the whole new debt: `borrow.rs` charges it in full and pays
 * out `amount - floor(amount * originationFeeBps / 10_000)`. `received` is that
 * payout, which is what a receipt may claim reached the wallet. The program also
 * refuses a draw over the reserve's free liquidity, its borrow cap, or the
 * wallet's per-reserve cap (from `RiskConfig`, passed as `wallet`), and
 * `allowed` folds all of them in with the borrow limit.
 */
export const previewBorrow = (
  position: PositionValues | null,
  reserve: ReserveAccount,
  priceScaled: bigint,
  borrowAmount: bigint,
  wallet?: { owed: bigint; perWalletBorrowCap: bigint },
): {
  healthFactor: number | null;
  withinLimit: boolean;
  projectedDebt: bigint;
  /** Origination fee kept by the reserve, in base units. */
  fee: bigint;
  /** What reaches the borrower's wallet: `borrowAmount - fee`. */
  received: bigint;
  withinLiquidity: boolean;
  withinBorrowCap: boolean;
  withinWalletCap: boolean;
  /** Every check the program makes on the draw itself. */
  allowed: boolean;
} => {
  const added = marketValue(borrowAmount, reserve.liquidityDecimals, priceScaled, 'up');
  const projectedDebt = (position?.borrowedValue ?? 0n) + added;
  const limit = position?.allowedBorrowValue ?? 0n;
  const line = position?.unhealthyBorrowValue ?? 0n;
  const fee = mulDivFloor(borrowAmount, BigInt(reserve.config.originationFeeBps), BPS);
  const room = capHeadroom(reserve.config.borrowCap, currentBorrowed(reserve));
  const withinBorrowCap = room === null || borrowAmount <= room;
  const withinLiquidity = borrowAmount <= reserve.availableLiquidity;
  const withinWalletCap = !wallet || wallet.perWalletBorrowCap === 0n || wallet.owed + borrowAmount <= wallet.perWalletBorrowCap;
  const withinLimit = projectedDebt <= limit;
  return {
    projectedDebt,
    withinLimit,
    healthFactor: ratio(line, projectedDebt),
    fee,
    received: borrowAmount - fee,
    withinLiquidity,
    withinBorrowCap,
    withinWalletCap,
    allowed: borrowAmount > 0n && withinLimit && withinLiquidity && withinBorrowCap && withinWalletCap,
  };
};

/** Health factor if `repayAmount` were repaid. */
export const previewRepay = (
  position: PositionValues | null,
  reserve: ReserveAccount,
  priceScaled: bigint,
  repayAmount: bigint,
): { healthFactor: number | null; projectedDebt: bigint } => {
  const removed = marketValue(repayAmount, reserve.liquidityDecimals, priceScaled, 'down');
  const current = position?.borrowedValue ?? 0n;
  const projectedDebt = removed >= current ? 0n : current - removed;
  return { projectedDebt, healthFactor: ratio(position?.unhealthyBorrowValue ?? 0n, projectedDebt) };
};

/**
 * What `shares` of `reserve` redeem for, rounded the way the program is asked
 * to: `Reserve::shares_to_liquidity`, `shares * total_liquidity / max(supply, 1)`.
 *
 * Collateral is posted, valued and withdrawn as *shares*. Valuing the share
 * count as if it were liquidity overstated (or understated) every collateral
 * preview by the exchange rate.
 */
export const collateralSharesToLiquidity = (reserve: ReserveAccount, shares: bigint, round: 'up' | 'down'): bigint => {
  const total = totalLiquidity(reserve);
  const supply = reserve.shareMintSupply > 0n ? reserve.shareMintSupply : 1n;
  return round === 'up' ? mulDivCeil(shares, total, supply) : mulDivFloor(shares, total, supply);
};

/**
 * Health factor if `collateralShares` more of `reserve`'s shares were posted.
 *
 * The shares are converted to liquidity rounding **down**, then valued rounding
 * **down**, and the haircut is applied before LTV and LT, matching
 * `refresh_obligation`.
 */
export const previewDepositCollateral = (
  position: PositionValues | null,
  reserve: ReserveAccount,
  priceScaled: bigint,
  collateralShares: bigint,
): {
  healthFactor: number | null;
  borrowLimit: bigint;
  /** Total post-haircut collateral value after this deposit. */
  effectiveValue: bigint;
} => {
  const liquidity = collateralSharesToLiquidity(reserve, collateralShares, 'down');
  const face = marketValue(liquidity, reserve.liquidityDecimals, priceScaled, 'down');
  const effective = applyHaircut(face, reserve.config.collateralHaircutBps);
  const addedLimit = mulDivFloor(effective, BigInt(reserve.config.loanToValueBps), BPS);
  const addedLine = mulDivFloor(effective, BigInt(reserve.config.liquidationThresholdBps), BPS);
  const debt = position?.borrowedValue ?? 0n;
  return {
    borrowLimit: (position?.allowedBorrowValue ?? 0n) + addedLimit,
    effectiveValue: (position?.effectiveCollateralValue ?? 0n) + effective,
    healthFactor: ratio((position?.unhealthyBorrowValue ?? 0n) + addedLine, debt),
  };
};

/**
 * Health factor if `collateralShares` were withdrawn.
 *
 * The removal rounds **up** at every step, as `withdraw_collateral` does —
 * shares to liquidity, liquidity to value, the haircut, LTV and LT — so a
 * preview never shows a withdrawal as safe that the program would refuse.
 */
export const previewWithdrawCollateral = (
  position: PositionValues | null,
  reserve: ReserveAccount,
  priceScaled: bigint,
  collateralShares: bigint,
): { healthFactor: number | null; allowed: boolean; borrowLimit: bigint } => {
  const liquidity = collateralSharesToLiquidity(reserve, collateralShares, 'up');
  const face = marketValue(liquidity, reserve.liquidityDecimals, priceScaled, 'up');
  const keep = BPS - BigInt(reserve.config.collateralHaircutBps);
  const effective = (face * keep + BPS - 1n) / BPS;
  const removedLimit = (effective * BigInt(reserve.config.loanToValueBps) + BPS - 1n) / BPS;
  const removedLine = (effective * BigInt(reserve.config.liquidationThresholdBps) + BPS - 1n) / BPS;

  const currentLimit = position?.allowedBorrowValue ?? 0n;
  const currentLine = position?.unhealthyBorrowValue ?? 0n;
  const borrowLimit = currentLimit > removedLimit ? currentLimit - removedLimit : 0n;
  const line = currentLine > removedLine ? currentLine - removedLine : 0n;
  const debt = position?.borrowedValue ?? 0n;
  return { borrowLimit, allowed: debt <= borrowLimit, healthFactor: ratio(line, debt) };
};

/**
 * The largest collateral withdrawal that leaves the position healthy.
 *
 * The action sheet's MAX button offered the entire locked balance, which with
 * any debt outstanding is guaranteed to be refused — pressing MAX produced a
 * red "Health after 0.00" and a "repay some first" message every time. A MAX
 * that cannot be submitted is not a maximum, it is a trap.
 *
 * Found by bisecting `previewWithdrawCollateral` rather than by inverting its
 * arithmetic. That function ceilings in three places, and an inverse would have
 * to reproduce each of them exactly or drift by a base unit in whichever
 * direction the rounding happened to fall — and the unsafe direction here is
 * the one that lets a withdrawal through that the program then rejects. Bisection
 * cannot disagree with the predicate it is calling.
 *
 * Takes and returns *shares*, never more than `locked`. With no debt the whole
 * balance is withdrawable and that is what comes back.
 */
export const maxWithdrawCollateral = (position: PositionValues | null, reserve: ReserveAccount, priceScaled: bigint, locked: bigint): bigint => {
  if (locked <= 0n) return 0n;
  const allowed = (amount: bigint) => previewWithdrawCollateral(position, reserve, priceScaled, amount).allowed;
  // No debt, or the whole balance is already safe.
  if (allowed(locked)) return locked;
  // Invariant: `low` is allowed, `high` is not. 0 is always allowed — removing
  // nothing cannot make a position worse.
  let low = 0n;
  let high = locked;
  while (high - low > 1n) {
    const mid = low + (high - low) / 2n;
    if (allowed(mid)) low = mid;
    else high = mid;
  }
  return low;
};
