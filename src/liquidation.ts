/**
 * What a liquidation pays, and to whom.
 *
 * Aera takes a share of the liquidation bonus a borrower already pays. It does
 * **not** add one. A borrower repaying 1,000 COOK against a 12% bonus loses
 * collateral worth 1,120 COOK whether Aera's share is zero or three hundred
 * basis points; what moves is the split of the 120, never the 1,120.
 *
 * Everything here mirrors `risk::split_seized_shares` and exists so that no
 * caller -- frontend, keeper, or analytics -- reimplements protocol arithmetic
 * from a screenshot of the docs. A liquidator keeper that sized its profit
 * against the *total* bonus rather than its own would systematically overstate
 * every opportunity by the protocol's share, and would keep taking trades that
 * lose money by exactly that margin.
 */

import type { PublicKey } from '@solana/web3.js';

const BPS = 10_000n;

/** How a reserve's liquidation bonus is divided. */
export interface BonusSplit {
  /** What the borrower pays, in bps of value repaid. Unaffected by the share. */
  totalBonusBps: number;
  /** Aera's slice, in bps of value repaid. Carved out of the total. */
  protocolShareBps: number;
  /** What the liquidator actually earns: total minus protocol. */
  liquidatorBonusBps: number;
}

/**
 * Split a reserve's bonus, clamping as the program does.
 *
 * `protocolShareBps` above `totalBonusBps` is clamped rather than applied. Both
 * admin paths refuse to configure it, and the program clamps anyway because the
 * two values live in different accounts and `set_params` can lower the bonus
 * after the share was set against the old one.
 */
export const bonusSplit = (totalBonusBps: number, protocolShareBps: number): BonusSplit => {
  const protocol = Math.max(0, Math.min(protocolShareBps, totalBonusBps));
  return {
    totalBonusBps,
    protocolShareBps: protocol,
    liquidatorBonusBps: totalBonusBps - protocol,
  };
};

/** What one liquidation moves, in collateral share tokens. */
export interface LiquidationPreview extends BonusSplit {
  /** Debt closed, in the repay asset's base units. */
  repay: bigint;
  /** Everything removed from the borrower. The borrower's whole penalty. */
  seizedShares: bigint;
  /** What the liquidator receives. */
  liquidatorShares: bigint;
  /** What Aera receives. Zero when the share rounds away on a small close. */
  protocolShares: bigint;
  /** Where Aera's share goes, if the caller supplied the destination owner. */
  protocolDestination?: PublicKey;
}

/**
 * Divide an already-computed seizure, exactly as the program does.
 *
 * `seizedShares` corresponds to value `repay x (BPS + totalBonus) / BPS`, and
 * Aera's claim is `repay x share / BPS`. The `repay` and the `BPS` cancel:
 *
 * ```text
 *   protocolShares = seizedShares x shareBps / (BPS + totalBonusBps)
 * ```
 *
 * The protocol side floors and the liquidator takes the remainder, so the two
 * always sum to `seizedShares` exactly. Splitting rather than computing two
 * seizures is what makes that true — two independent conversions would each
 * round down and leave a unit belonging to nobody.
 */
export const splitSeizedShares = (
  seizedShares: bigint,
  totalBonusBps: number,
  protocolShareBps: number,
): { protocolShares: bigint; liquidatorShares: bigint } => {
  const share = BigInt(Math.max(0, Math.min(protocolShareBps, totalBonusBps)));
  if (share === 0n || seizedShares <= 0n) {
    return { protocolShares: 0n, liquidatorShares: seizedShares > 0n ? seizedShares : 0n };
  }
  const denominator = BPS + BigInt(totalBonusBps);
  const protocolShares = (seizedShares * share) / denominator;
  return { protocolShares, liquidatorShares: seizedShares - protocolShares };
};

/**
 * The full picture for one liquidation, given the seizure the protocol would
 * compute.
 *
 * `seizedShares` is deliberately an input rather than something derived here:
 * it depends on both oracles, the collateral exchange rate and the reserve's
 * decimals, and a second implementation of that chain is exactly the kind of
 * mirror that agrees with a bug. Take it from a simulation, which stays
 * authoritative.
 */
export const previewLiquidation = (input: {
  repay: bigint;
  seizedShares: bigint;
  totalBonusBps: number;
  protocolShareBps: number;
  protocolDestination?: PublicKey;
}): LiquidationPreview => {
  const split = bonusSplit(input.totalBonusBps, input.protocolShareBps);
  const { protocolShares, liquidatorShares } = splitSeizedShares(
    input.seizedShares,
    input.totalBonusBps,
    input.protocolShareBps,
  );
  return {
    ...split,
    repay: input.repay,
    seizedShares: input.seizedShares,
    liquidatorShares,
    protocolShares,
    protocolDestination: input.protocolDestination,
  };
};

/**
 * The bonus a liquidator should size its profit against.
 *
 * This is the number a keeper needs, and it is not the reserve's
 * `liquidationBonusBps`. Using the total would overstate every opportunity by
 * the protocol's share -- at a 12% bonus and a 150 bps share, a keeper checking
 * against 12% would take trades whose real margin is 10.5% and lose the
 * difference on every one.
 */
export const liquidatorBonusBps = (totalBonusBps: number, protocolShareBps: number): number =>
  bonusSplit(totalBonusBps, protocolShareBps).liquidatorBonusBps;
