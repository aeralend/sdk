/**
 * Aera Core's launch configuration.
 *
 * Every value here is read from `config/aera.launch.json`, which is **generated
 * from the program's own constants** by
 * `protocol/programs/aera/tests/test_launch_config.rs`. Nothing in this file
 * declares a number.
 *
 * ## Why it works this way now
 *
 * These figures used to be written out here as well as in the program, the
 * deployment scripts and the keeper configuration, and they had already
 * drifted: this file carried `slotsPerYear = 67_609_680` while the program
 * carried `70_881_876`, a 4.8% disagreement in the divisor that turns an APR
 * into a per-slot rate. Because `init_reserve` takes its configuration from
 * whoever calls it, *this file* was what a deployment would actually have
 * written on chain — so the SDK's stale copy would have become the live
 * parameters, not a documentation problem.
 *
 * One source, generated, with a test that fails if the JSON and the constants
 * disagree.
 *
 * ## Two generated artifacts, one source
 *
 * `config/aera.launch.json` is canonical for everything that is not TypeScript
 * — the deployment scripts, `preflight.sh`, anything reading it with `jq`.
 * `launch.generated.ts` is the same content as a typed module, because this
 * package's `rootDir` is `src` and it cannot import JSON from outside itself
 * without either widening that or copying the file in at build time. Both are
 * written by the same Rust generator, and the same test fails if either drifts.
 *
 * ## bigint, not number
 *
 * Caps are base units at nine decimals, so 1,000,000 COOK is 10^15 — inside
 * `Number.MAX_SAFE_INTEGER`, but only just, and `slotsPerYear` multiplied by
 * anything is not. They are carried through the JSON as strings and parsed
 * with `BigInt` here. No financial quantity in this SDK is ever a `number`.
 */

import { LAUNCH as launch } from './launch.generated.js';
import type { ReserveConfig } from './types.js';

/** The shape of the generated file, as far as this module reads it. */
interface RawReserveConfig {
  loanToValueBps: number;
  liquidationThresholdBps: number;
  liquidationBonusBps: number;
  closeFactorBps: number;
  collateralHaircutBps: number;
  optimalUtilizationBps: number;
  minBorrowRateBps: number;
  optimalBorrowRateBps: number;
  maxBorrowRateBps: number;
  reserveFactorBps: number;
  originationFeeBps: number;
  supplyCap: string;
  borrowCap: string;
  perWalletSupplyCap: string;
  borrowEnabled: boolean;
  collateralEnabled: boolean;
  isolated: boolean;
  slotsPerYear: string;
}

function toReserveConfig(raw: RawReserveConfig): ReserveConfig {
  return {
    loanToValueBps: raw.loanToValueBps,
    liquidationThresholdBps: raw.liquidationThresholdBps,
    liquidationBonusBps: raw.liquidationBonusBps,
    closeFactorBps: raw.closeFactorBps,
    collateralHaircutBps: raw.collateralHaircutBps,
    optimalUtilizationBps: raw.optimalUtilizationBps,
    minBorrowRateBps: raw.minBorrowRateBps,
    optimalBorrowRateBps: raw.optimalBorrowRateBps,
    maxBorrowRateBps: raw.maxBorrowRateBps,
    reserveFactorBps: raw.reserveFactorBps,
    originationFeeBps: raw.originationFeeBps,
    supplyCap: BigInt(raw.supplyCap),
    borrowCap: BigInt(raw.borrowCap),
    perWalletSupplyCap: BigInt(raw.perWalletSupplyCap),
    borrowEnabled: raw.borrowEnabled,
    collateralEnabled: raw.collateralEnabled,
    isolated: raw.isolated,
    slotsPerYear: BigInt(raw.slotsPerYear),
  };
}

/** The whole generated configuration, for tools that want more than a reserve. */
export const LAUNCH_CONFIG = launch;

/** COOK: borrowable, never collateral, capped at 1,000,000 / 600,000 / 250,000. */
export const COOK_RESERVE_CONFIG: ReserveConfig = toReserveConfig(
  launch.reserves.cook as RawReserveConfig,
);

/** bCOOK: collateral only, 55/65/8 with a 5% haircut, uncapped. */
export const BCOOK_RESERVE_CONFIG: ReserveConfig = toReserveConfig(
  launch.reserves.bcook as RawReserveConfig,
);

/**
 * Slots in a year, as the program deploys it.
 *
 * The divisor turning an APR into a per-slot rate. Cookie's slot time drifts,
 * and `LAUNCH_CONFIG.slotTime` records what it was last measured at and by how
 * much the deployed figure differs — 2.2% high as of 2026-08-31, which means
 * interest accrues 2.2% slower than quoted. Adopting a new measurement changes
 * the economics of every open position, so it is an operator decision made
 * through `set_params` behind the timelock, never a value this file quietly
 * updates.
 */
export const DEFAULT_SLOTS_PER_YEAR = BigInt(launch.reserves.cook.slotsPerYear);

/** Identities on Cookie Chain that a deployment must match. */
export const CHAIN = launch.chain;

/** BakeYourStake's stake pool, its program, and the deployment Aera pins to. */
export const STAKE_POOL = launch.stakePool;

/**
 * The oracle bounds Aera Core launches with.
 *
 * Replaces the v0.1 `ORACLE_DEFAULTS`, which described a guardian median —
 * quorum, freshness window, breaker percentage — none of which exists any more.
 */
export const ORACLE_CONFIG = launch.oracle;
