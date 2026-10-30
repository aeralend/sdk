import type { OracleHealth } from './oracle.js';
import type { ProjectedObligation } from './projection.js';
import type { PublicKey } from '@solana/web3.js';

/**
 * Account shapes as the SDK exposes them.
 *
 * Anchor decodes u64/u128 into BN; `decode.ts` converts those to BigInt at the
 * boundary so nothing downstream has to think about which is which. Field names
 * are camelCase, matching Anchor's IDL client.
 */

export interface ReserveConfig {
  loanToValueBps: number;
  liquidationThresholdBps: number;
  liquidationBonusBps: number;
  closeFactorBps: number;
  collateralHaircutBps: number;
  optimalUtilizationBps: number;
  minBorrowRateBps: number;
  optimalBorrowRateBps: number;
  maxBorrowRateBps: number;
  /** Kept by the protocol; all of it accrues to `Global.feeDestination`. */
  reserveFactorBps: number;
  /** One-off fee on each draw. Ships at 0, hard-capped at 50 bps. */
  originationFeeBps: number;
  supplyCap: bigint;
  borrowCap: bigint;
  perWalletSupplyCap: bigint;
  borrowEnabled: boolean;
  collateralEnabled: boolean;
  isolated: boolean;
  slotsPerYear: bigint;
}

/**
 * Name, symbol and URI written into a share mint's TokenMetadata extension.
 * These are what a wallet shows for aCOOK.
 */
export interface ShareMetadata {
  name: string;
  symbol: string;
  uri: string;
}

export interface PendingConfig {
  config: ReserveConfig;
  /** Unix seconds from which the queued change may be applied. 0 = nothing queued. */
  eta: bigint;
}

export interface ReserveAccount {
  address: PublicKey;
  market: PublicKey;
  liquidityMint: PublicKey;
  liquidityVault: PublicKey;
  shareMint: PublicKey;
  /** The `OracleState` this reserve is priced by. Was `priceFeed` in v0.1. */
  oracle: PublicKey;
  liquidityDecimals: number;
  availableLiquidity: bigint;
  shareMintSupply: bigint;
  borrowedPrincipal: bigint;
  borrowIndex: bigint;
  lastUpdateSlot: bigint;
  /** Interest owed to the protocol, carved out of the suppliers' pool. */
  accruedFees: bigint;
  config: ReserveConfig;
  pending: PendingConfig;
  bump: number;
}

export interface GlobalAccount {
  address: PublicKey;
  admin: PublicKey;
  /** Where the protocol's whole cut of interest is paid. */
  feeDestination: PublicKey;
  paused: boolean;
  borrowPaused: boolean;
  paramTimelockSeconds: bigint;
  bump: number;
}

export interface MarketAccount {
  address: PublicKey;
  global: PublicKey;
  marketId: bigint;
  quoteCurrencyMint: PublicKey;
  name: string;
  bump: number;
}

export interface ObligationCollateral {
  reserve: PublicKey;
  depositedShares: bigint;
  /** Face value, before the haircut. */
  marketValue: bigint;
}

export interface ObligationLiquidity {
  reserve: PublicKey;
  borrowedPrincipal: bigint;
  marketValue: bigint;
}

export interface ObligationAccount {
  address: PublicKey;
  market: PublicKey;
  owner: PublicKey;
  lastUpdateSlot: bigint;
  stale: boolean;
  /** Any feed this position depends on had a latched circuit breaker at the last refresh. */
  pricesStressed: boolean;
  /** Collateral at face value. */
  depositedValue: bigint;
  /** Collateral after haircuts — what actually backs the limits below. */
  effectiveCollateralValue: bigint;
  borrowedValue: bigint;
  allowedBorrowValue: bigint;
  unhealthyBorrowValue: bigint;
  deposits: ObligationCollateral[];
  borrows: ObligationLiquidity[];
  bump: number;
}

export interface SupplyPositionAccount {
  address: PublicKey;
  reserve: PublicKey;
  owner: PublicKey;
  suppliedLiquidity: bigint;
  bump: number;
}

/** A reserve with everything the UI needs, derived once. */
export interface ReserveView {
  reserve: ReserveAccount;
  symbol: string;
  utilizationBps: bigint;
  borrowRateBps: bigint;
  supplyRateBps: bigint;
  totalLiquidity: bigint;
  borrowed: bigint;
  available: bigint;
  /** null when the cap is 0 ("no cap"). */
  supplyCapHeadroom: bigint | null;
  borrowCapHeadroom: bigint | null;
  /**
   * The rate Aera will actually lend against: effective, less the haircut.
   *
   * Not the pool's gross rate. `grossRateScaled` and `effectiveRateScaled` are
   * both here so a UI can show the three separately -- what the pool says, what
   * redeeming pays after BakeYourStake's fee, and what Aera lends on after its
   * own margin -- rather than one number that is none of them.
   */
  priceScaled: bigint;
  grossRateScaled: bigint;
  effectiveRateScaled: bigint;
  /** BakeYourStake's redemption fee at the last accepted observation. */
  withdrawalFeeBps: number;
  oracleHealth: OracleHealth | null;
  /** The slot of the last accepted observation, not a wall-clock age. */
  oracleAgeSlots: bigint | null;
  /** The pool epoch the reference came from. */
  sourceEpoch: bigint | null;
  /** True whenever the oracle permits no new risk, for whatever reason. */
  breakerTripped: boolean;
}

/** A borrower's position, with health resolved from a projection, never from the account's cached values. */
export interface UserAccountView {
  position: ProjectedObligation | null;
  /** null when there is no debt — render as infinity, not a made-up number. */
  healthFactor: number | null;
  collateralValue: bigint;
  effectiveCollateralValue: bigint;
  debtValue: bigint;
  borrowLimit: bigint;
  liquidationLine: bigint;
  availableToBorrow: bigint;
}

/** A reserve's post-v0.2 risk limits. Absent means unconstrained. */
export interface RiskConfigAccount {
  address: PublicKey;
  reserve: PublicKey;
  /** The most one wallet may owe here. `0n` is unlimited. */
  perWalletBorrowCap: bigint;
  /**
   * Aera's share of this reserve's liquidation bonus, in bps of value repaid.
   *
   * Carved OUT of `liquidationBonusBps`, never added to it. A borrower's
   * penalty does not depend on this number.
   */
  protocolLiquidationShareBps: number;
  pendingPerWalletBorrowCap: bigint;
  pendingProtocolLiquidationShareBps: number;
  /** `0n` when nothing is queued. */
  pendingEta: bigint;
  bump: number;
}
