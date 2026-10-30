/**
 * Anchor decodes u64/u128 into BN. Everything downstream of this file uses
 * BigInt, so the conversion happens once, here, at the boundary.
 */

import type { PublicKey } from '@solana/web3.js';

import type {
  RiskConfigAccount,
  GlobalAccount,
  MarketAccount,
  ObligationAccount,
  PendingConfig,
  ReserveAccount,
  ReserveConfig,
  SupplyPositionAccount,
} from './types.js';

/** Anything BN-like, plus the primitives Anchor may hand back directly. */
type Numeric = { toString(): string } | number | bigint | string;

const big = (value: Numeric): bigint => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  return BigInt(value.toString());
};

/* eslint-disable @typescript-eslint/no-explicit-any */

const reserveConfig = (raw: any): ReserveConfig => ({
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
  supplyCap: big(raw.supplyCap),
  borrowCap: big(raw.borrowCap),
  perWalletSupplyCap: big(raw.perWalletSupplyCap),
  borrowEnabled: raw.borrowEnabled,
  collateralEnabled: raw.collateralEnabled,
  isolated: raw.isolated,
  slotsPerYear: big(raw.slotsPerYear),
});

const pendingConfig = (raw: any): PendingConfig => ({
  config: reserveConfig(raw.config),
  eta: big(raw.eta),
});

export const decodeReserve = (address: PublicKey, raw: any): ReserveAccount => ({
  address,
  market: raw.market,
  liquidityMint: raw.liquidityMint,
  liquidityVault: raw.liquidityVault,
  shareMint: raw.shareMint,
  oracle: raw.oracle,
  liquidityDecimals: raw.liquidityDecimals,
  availableLiquidity: big(raw.availableLiquidity),
  shareMintSupply: big(raw.shareMintSupply),
  borrowedPrincipal: big(raw.borrowedPrincipal),
  borrowIndex: big(raw.borrowIndex),
  lastUpdateSlot: big(raw.lastUpdateSlot),
  accruedFees: big(raw.accruedFees),
  config: reserveConfig(raw.config),
  pending: pendingConfig(raw.pending),
  bump: raw.bump,
});

export const decodeGlobal = (address: PublicKey, raw: any): GlobalAccount => ({
  address,
  admin: raw.admin,
  feeDestination: raw.feeDestination,
  paused: raw.paused,
  borrowPaused: raw.borrowPaused,
  paramTimelockSeconds: big(raw.paramTimelockSeconds),
  bump: raw.bump,
});

export const decodeMarket = (address: PublicKey, raw: any): MarketAccount => ({
  address,
  global: raw.global,
  marketId: big(raw.marketId),
  quoteCurrencyMint: raw.quoteCurrencyMint,
  name: raw.name,
  bump: raw.bump,
});

export const decodeObligation = (address: PublicKey, raw: any): ObligationAccount => ({
  address,
  market: raw.market,
  owner: raw.owner,
  lastUpdateSlot: big(raw.lastUpdateSlot),
  stale: raw.stale,
  pricesStressed: raw.pricesStressed,
  depositedValue: big(raw.depositedValue),
  effectiveCollateralValue: big(raw.effectiveCollateralValue),
  borrowedValue: big(raw.borrowedValue),
  allowedBorrowValue: big(raw.allowedBorrowValue),
  unhealthyBorrowValue: big(raw.unhealthyBorrowValue),
  deposits: (raw.deposits ?? []).map((entry: any) => ({
    reserve: entry.reserve,
    depositedShares: big(entry.depositedShares),
    marketValue: big(entry.marketValue),
  })),
  borrows: (raw.borrows ?? []).map((entry: any) => ({
    reserve: entry.reserve,
    borrowedPrincipal: big(entry.borrowedPrincipal),
    marketValue: big(entry.marketValue),
  })),
  bump: raw.bump,
});

/**
 * A reserve's `RiskConfig`, or the defaults for a reserve that has none.
 *
 * Absent means unconstrained: no per-wallet cap, and Aera taking no share of
 * liquidations. Note the two fields mean OPPOSITE things by zero --
 * `perWalletBorrowCap` of zero is unlimited and therefore loosest,
 * `protocolLiquidationShareBps` of zero is Aera taking nothing and therefore
 * tightest. That is why raising the share waits out the timelock while setting
 * a cap for the first time does not.
 */
export const decodeRiskConfig = (address: PublicKey, raw: any): RiskConfigAccount => ({
  address,
  reserve: raw.reserve,
  perWalletBorrowCap: BigInt(raw.perWalletBorrowCap?.toString() ?? '0'),
  protocolLiquidationShareBps: Number(raw.protocolLiquidationShareBps ?? 0),
  pendingPerWalletBorrowCap: BigInt(raw.pendingPerWalletBorrowCap?.toString() ?? '0'),
  pendingProtocolLiquidationShareBps: Number(raw.pendingProtocolLiquidationShareBps ?? 0),
  pendingEta: BigInt(raw.pendingEta?.toString() ?? '0'),
  bump: Number(raw.bump ?? 0),
});

export const decodeSupplyPosition = (address: PublicKey, raw: any): SupplyPositionAccount => ({
  address,
  reserve: raw.reserve,
  owner: raw.owner,
  suppliedLiquidity: big(raw.suppliedLiquidity),
  bump: raw.bump,
});

/* eslint-enable @typescript-eslint/no-explicit-any */
