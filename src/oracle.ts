/**
 * The v0.2 oracle, client side.
 *
 * Replaces the guardian `PriceFeed` entirely. There is no quorum, no freshness
 * window, no submission list and no publisher, because there is no instruction
 * in the program that accepts a price. bCOOK is valued from BakeYourStake's own
 * stake-pool accounting and COOK is one COOK by definition.
 *
 * ## The three rates, and why they are three
 *
 * ```text
 *   gross      = total_lamports / pool_token_supply     what the pool says
 *   effective  = gross x (1 - withdrawal_fee)           what redeeming pays
 *   collateral = effective x (1 - aera_haircut)         what Aera will lend on
 * ```
 *
 * The withdrawal fee belongs to BakeYourStake and is taken *inside* the oracle,
 * because bCOOK really is worth less if redeeming it costs more. The haircut is
 * Aera's own risk margin and is applied on top. Merging them would make a fee
 * change indistinguishable from a risk-policy change, and they are set by
 * different people for different reasons.
 *
 * Everything here is integer arithmetic on `bigint`. A rate is an 18-decimal
 * fixed-point number, so it exceeds `Number.MAX_SAFE_INTEGER` by nine orders of
 * magnitude and `number` would silently lose the low digits.
 */

import { PublicKey } from '@solana/web3.js';

import { BPS, FIXED_POINT_SCALE } from './constants.js';

/**
 * What the protocol will currently permit.
 *
 * Mirrors `oracle::breaker::OracleHealth`. Stored on chain as a `u8`, so the
 * numbers are part of the account layout and cannot be reordered.
 */
export enum OracleHealth {
  /** The rate moved within its per-epoch allowance. Everything is permitted. */
  Healthy = 0,
  /**
   * Accepted, but the source has not updated for several epochs. Nothing is
   * restricted — a stale pool understates bCOOK, which is the safe direction —
   * but it is worth surfacing.
   */
  RateWarning = 1,
  /** The rate moved beyond its allowance. No new risk; exits stay open. */
  BorrowFrozen = 2,
  /** The rate moved beyond the absolute bound, or the source is unreadable. */
  Emergency = 3,
  /**
   * A reference exists but no later pool epoch has confirmed it yet.
   *
   * A new or reconfigured oracle values existing positions and permits no new
   * ones. See `docs/ORACLE_V0_2.md` on why one reading is not enough.
   */
  Bootstrapping = 4,
}

/** Where an oracle derives its rate. Mirrors `oracle::OracleSourceKind`. */
export enum OracleSourceKind {
  /** One COOK is one COOK. Reads no program, so nothing can go wrong with it. */
  UnitOfAccount = 0,
  /** Derived from a stake pool's own accounting. */
  NativeExchangeRate = 1,
  /**
   * A time-weighted average of two AMM pools, combined by taking the lower.
   *
   * Refreshed by `refresh_market_oracle` rather than `refresh_oracle` — sending
   * the wrong one fails with `UnknownOracleSource`. `AeraClient.refreshOracleIx`
   * dispatches on this, so callers do not have to.
   */
  MarketTwap = 2,
  /**
   * A stake pool's books from another chain — JitoSOL's, from Solana — relayed
   * over Hyperlane into a `rate_receiver` feed. Judged exactly like
   * `NativeExchangeRate`, plus one check: if nothing has been relayed for
   * `MAX_RELAYED_RATE_AGE_SECONDS`, borrowing freezes until a relay lands.
   */
  RelayedRate = 3,
}

/**
 * Whether `refresh_oracle` needs the source account and its program's
 * `ProgramData` in `remainingAccounts` for this kind.
 */
export function readsSourceAccount(kind: OracleSourceKind): boolean {
  return kind === OracleSourceKind.NativeExchangeRate || kind === OracleSourceKind.RelayedRate;
}

/** The last observation the breaker accepted: the protocol's anchor. */
export interface OracleReference {
  /** `total_lamports / pool_token_supply`, at 18 decimals. */
  grossRate: bigint;
  /** `gross x (1 - withdrawal_fee)`. What redeeming actually pays. */
  effectiveRate: bigint;
  /** The pool's redemption fee at the moment of the reading. */
  withdrawalFeeBps: number;
  /** The pool epoch this reading came from. */
  sourceEpoch: bigint;
  slot: bigint;
  unixTimestamp: bigint;
}

/** The movement bounds the breaker judges observations against. */
export interface BreakerConfig {
  maxUpBpsPerEpoch: number;
  maxDownBpsPerEpoch: number;
  emergencyDeviationBps: number;
  maxEpochAllowance: bigint;
}

/** An `OracleState` account. */
export interface OracleStateAccount {
  address: PublicKey;
  market: PublicKey;
  mint: PublicKey;
  sourceKind: OracleSourceKind;
  /** The program that owns the source account. Zero for `UnitOfAccount`. */
  sourceProgram: PublicKey;
  /** The account the rate is read from. Zero for `UnitOfAccount`. */
  sourceAccount: PublicKey;
  maxWithdrawalFeeBps: number;
  rateFloor: bigint;
  rateCeiling: bigint;
  /**
   * The source program's `ProgramData` deploy slot at configuration time.
   *
   * A redeploy moves this and every later observation is refused. See
   * `docs/KNOWN_RISKS.md`: the stake-pool program's upgrade authority is a
   * single wallet key.
   */
  expectedDeploySlot: bigint;
  /** All zeros means the source program was already immutable. */
  expectedUpgradeAuthority: PublicKey;
  breaker: BreakerConfig;
  reference: OracleReference;
  health: OracleHealth;
  lastMovedBps: bigint;
  lastRefreshSlot: bigint;
  /** The last pool epoch *seen*, accepted or not. */
  lastSourceEpoch: bigint;
  bump: number;
}

/**
 * Which decoder reads a pool, mirroring the program's `AmmKind`.
 *
 * The oracle never implements an AMM: it reads two mints and two vaults out of
 * a pool account and takes the reserves from the vaults. A kind is just where a
 * given AMM keeps those four addresses.
 */
export const AmmKind = {
  /** Meteora DAMM v2 (Cookiebox), `DAMMjDCE…`. */
  DammV2: 0,
  /** SPL Token Swap V1 (CookieSwap's CPAMM), `xYBN2zdd…`. */
  SplTokenSwap: 1,
} as const;
export type AmmKind = (typeof AmmKind)[keyof typeof AmmKind];

/**
 * One pool a market oracle reads, its two vaults, and the AMM it belongs to.
 *
 * Each pool pins its own AMM, so the two pools may sit on different AMMs with
 * different upgrade keys — the stronger arrangement, because one bug or one
 * compromised key then moves only one of the two readings.
 */
export interface PoolRef {
  pool: PublicKey;
  collateralVault: PublicKey;
  quoteVault: PublicKey;
  ammKind: AmmKind;
  ammProgram: PublicKey;
  /** The AMM's ProgramData, and the slot it stood at when pinned. */
  ammProgramData: PublicKey;
  expectedDeploySlot: bigint;
}

/** One recorded reading. Weighted by how long it stood, not counted. */
export interface MarketObservation {
  /** Quote units per whole collateral token, 1e18-scaled. */
  price: bigint;
  slot: bigint;
  unixTimestamp: bigint;
  /** Combined quote-side depth, in quote base units. */
  quoteDepth: bigint;
}

/**
 * The thresholds a `MarketOracle` judges its readings against.
 *
 * Thresholds only. Which pools, on which AMMs, is identity and lives in
 * `PoolRef`.
 */
export interface MarketOracleConfig {
  twapWindowSeconds: number;
  minObservations: number;
  minSpanSeconds: number;
  /**
   * Observations closer together than this are not appended.
   *
   * A refresh inside this window still succeeds and still restates freshness —
   * it has to, because every write path needs a same-slot refresh — it simply
   * adds no history and may not raise the reference. So a keeper cranking more
   * often than this is harmless, and wasteful.
   */
  minSpacingSeconds: number;
  maxObservationAgeSeconds: number;
  warnAgeSeconds: number;
  /** Tolerated disagreement between the two pools, in bps of their midpoint. */
  maxCrossPoolDeviationBps: number;
  /** Per pool, in QUOTE BASE UNITS — not whole tokens. */
  minPoolQuoteDepth: bigint;
  maxRiseBpsPerWindow: number;
}

/** A `MarketOracle` account: the observation history behind a Tier 3 price. */
export interface MarketOracleAccount {
  address: PublicKey;
  oracle: PublicKey;
  collateralMint: PublicKey;
  quoteMint: PublicKey;
  collateralDecimals: number;
  quoteDecimals: number;
  config: MarketOracleConfig;
  pendingConfig: MarketOracleConfig;
  pendingEta: bigint;
  pools: PoolRef[];
  observations: MarketObservation[];
  nextIndex: number;
  bump: number;
}

const big = (v: unknown): bigint => BigInt(v?.toString() ?? '0');

/** Decode an `OracleState` from an Anchor-decoded account. */
export const decodeOracleState = (address: PublicKey, raw: any): OracleStateAccount => ({
  address,
  market: raw.market,
  mint: raw.mint,
  sourceKind: raw.sourceKind as OracleSourceKind,
  sourceProgram: raw.sourceProgram,
  sourceAccount: raw.sourceAccount,
  maxWithdrawalFeeBps: raw.maxWithdrawalFeeBps,
  rateFloor: big(raw.rateFloor),
  rateCeiling: big(raw.rateCeiling),
  expectedDeploySlot: big(raw.expectedDeploySlot),
  expectedUpgradeAuthority: raw.expectedUpgradeAuthority,
  breaker: {
    maxUpBpsPerEpoch: raw.breaker.maxUpBpsPerEpoch,
    maxDownBpsPerEpoch: raw.breaker.maxDownBpsPerEpoch,
    emergencyDeviationBps: raw.breaker.emergencyDeviationBps,
    maxEpochAllowance: big(raw.breaker.maxEpochAllowance),
  },
  reference: {
    grossRate: big(raw.reference.grossRate),
    effectiveRate: big(raw.reference.effectiveRate),
    withdrawalFeeBps: raw.reference.withdrawalFeeBps,
    sourceEpoch: big(raw.reference.sourceEpoch),
    slot: big(raw.reference.slot),
    unixTimestamp: big(raw.reference.unixTimestamp),
  },
  health: raw.health as OracleHealth,
  lastMovedBps: big(raw.lastMovedBps),
  lastRefreshSlot: big(raw.lastRefreshSlot),
  lastSourceEpoch: big(raw.lastSourceEpoch),
  bump: raw.bump,
});

/**
 * The actions the oracle state machine gates.
 *
 * Mirrors `oracle::breaker::RiskAction`, named by effect on risk rather than by
 * instruction, so the table below reads as policy.
 */
export enum RiskAction {
  Borrow = 'borrow',
  WithdrawCollateral = 'withdrawCollateral',
  WithdrawLiquidity = 'withdrawLiquidity',
  SupplyLiquidity = 'supplyLiquidity',
  Repay = 'repay',
  DepositCollateral = 'depositCollateral',
  Liquidate = 'liquidate',
}

/**
 * Whether an oracle in this state permits an action.
 *
 * The same matrix as `OracleHealth::permits` on chain. Duplicated here so a
 * client can grey out a button rather than let the user sign a transaction that
 * will certainly fail — and cross-checked against the Rust in
 * `sdk/test/oracle.test.ts`, because a client that disagreed with the program
 * about what is allowed would be worse than one that did not try.
 *
 * | Action | Healthy | Warning | Bootstrapping | BorrowFrozen | Emergency |
 * |---|---|---|---|---|---|
 * | Borrow | yes | yes | **no** | **no** | **no** |
 * | WithdrawCollateral | yes | yes | **no** | **no** | **no** |
 * | WithdrawLiquidity | yes | yes | yes | yes | **no** |
 * | SupplyLiquidity | yes | yes | yes | yes | yes |
 * | Repay | yes | yes | yes | yes | yes |
 * | DepositCollateral | yes | yes | yes | yes | yes |
 * | Liquidate | yes | yes | yes | yes | yes |
 *
 * Repay is permitted in every state without exception: a borrower who cannot
 * repay during an incident has been harmed by the protection.
 */
export function permits(health: OracleHealth, action: RiskAction): boolean {
  switch (action) {
    case RiskAction.SupplyLiquidity:
    case RiskAction.Repay:
    case RiskAction.DepositCollateral:
    case RiskAction.Liquidate:
      return true;
    case RiskAction.WithdrawLiquidity:
      return health !== OracleHealth.Emergency;
    case RiskAction.Borrow:
    case RiskAction.WithdrawCollateral:
      return health === OracleHealth.Healthy || health === OracleHealth.RateWarning;
  }
}

/**
 * The collateral rate: effective, less Aera's haircut.
 *
 * Floors, matching `risk::collateral_value` on chain. Rounding a collateral
 * value up would lend against value that is not there.
 */
export function haircutRate(effectiveRate: bigint, haircutBps: number): bigint {
  const remaining = BPS - BigInt(haircutBps);
  return (effectiveRate * remaining) / BPS;
}

/**
 * Apply a redemption fee to a gross rate.
 *
 * Floors, so the effective rate is never overstated. Mirrors
 * `oracle::apply_withdrawal_fee`.
 */
export function applyWithdrawalFee(grossRate: bigint, feeBps: number): bigint {
  const remaining = BPS - BigInt(feeBps);
  return (grossRate * remaining) / BPS;
}

/** The three rates an oracle currently implies, for display. */
export interface RateView {
  gross: bigint;
  effective: bigint;
  collateral: bigint;
  withdrawalFeeBps: number;
  haircutBps: number;
}

export function rateView(oracle: OracleStateAccount, haircutBps: number): RateView {
  return {
    gross: oracle.reference.grossRate,
    effective: oracle.reference.effectiveRate,
    collateral: haircutRate(oracle.reference.effectiveRate, haircutBps),
    withdrawalFeeBps: oracle.reference.withdrawalFeeBps,
    haircutBps,
  };
}

/**
 * Whether the oracle has ever accepted an observation.
 *
 * `gross_rate == 0` is the unset sentinel, matching `Reference::is_set()`.
 */
export const hasReference = (oracle: OracleStateAccount): boolean =>
  oracle.reference.grossRate > 0n;

/**
 * Whether an oracle needs cranking, and why.
 *
 * Returns `null` when a refresh would achieve nothing. The crank uses this to
 * avoid submitting transactions that cost fees and change no state — see
 * `keepers/crank`.
 */
export function refreshReason(
  oracle: OracleStateAccount,
  poolEpoch: bigint,
  currentSlot: bigint,
  staleSlots: bigint,
): string | null {
  if (oracle.sourceKind === OracleSourceKind.UnitOfAccount) {
    // Its rate is a constant, but it still has to be refreshed this slot for
    // any health-dependent instruction to accept it.
    return currentSlot > oracle.lastRefreshSlot ? 'unit oracle needs a same-slot refresh' : null;
  }
  if (!hasReference(oracle)) return 'no reference yet';
  if (oracle.health === OracleHealth.Bootstrapping) {
    return poolEpoch > oracle.reference.sourceEpoch
      ? 'a later pool epoch can confirm the bootstrap'
      : null;
  }
  if (poolEpoch > oracle.lastSourceEpoch) return 'the pool has a new epoch';
  if (currentSlot - oracle.lastRefreshSlot >= staleSlots) return 'the last refresh is stale';
  return null;
}

/** A human-readable name for a health state. */
export const healthName = (health: OracleHealth): string =>
  ({
    [OracleHealth.Healthy]: 'healthy',
    [OracleHealth.RateWarning]: 'rate warning',
    [OracleHealth.BorrowFrozen]: 'borrow frozen',
    [OracleHealth.Emergency]: 'emergency',
    [OracleHealth.Bootstrapping]: 'bootstrapping',
  })[health] ?? `unknown (${health})`;

/** Format an 18-decimal rate for display, without floating point. */
export function formatRate(rate: bigint, decimals = 6): string {
  const whole = rate / FIXED_POINT_SCALE;
  const fraction = rate % FIXED_POINT_SCALE;
  const padded = fraction.toString().padStart(18, '0').slice(0, decimals);
  return decimals > 0 ? `${whole}.${padded}` : whole.toString();
}

const decodeMarketOracleConfig = (raw: any): MarketOracleConfig => ({
  twapWindowSeconds: Number(raw.twapWindowSeconds),
  minObservations: Number(raw.minObservations),
  minSpanSeconds: Number(raw.minSpanSeconds),
  minSpacingSeconds: Number(raw.minSpacingSeconds),
  maxObservationAgeSeconds: Number(raw.maxObservationAgeSeconds),
  warnAgeSeconds: Number(raw.warnAgeSeconds),
  maxCrossPoolDeviationBps: Number(raw.maxCrossPoolDeviationBps),
  minPoolQuoteDepth: big(raw.minPoolQuoteDepth),
  maxRiseBpsPerWindow: Number(raw.maxRiseBpsPerWindow),
});

/** Decode a `MarketOracle` from an Anchor-decoded account. */
export const decodeMarketOracle = (address: PublicKey, raw: any): MarketOracleAccount => ({
  address,
  oracle: raw.oracle,
  collateralMint: raw.collateralMint,
  quoteMint: raw.quoteMint,
  collateralDecimals: Number(raw.collateralDecimals),
  quoteDecimals: Number(raw.quoteDecimals),
  config: decodeMarketOracleConfig(raw.config),
  pendingConfig: decodeMarketOracleConfig(raw.pendingConfig),
  pendingEta: big(raw.pendingEta),
  pools: (raw.pools ?? []).map((entry: any) => ({
    pool: entry.pool,
    collateralVault: entry.collateralVault,
    quoteVault: entry.quoteVault,
    ammKind: Number(entry.ammKind) as AmmKind,
    ammProgram: entry.ammProgram,
    ammProgramData: entry.ammProgramData,
    expectedDeploySlot: big(entry.expectedDeploySlot),
  })),
  observations: (raw.observations ?? []).map((entry: any) => ({
    price: big(entry.price),
    slot: big(entry.slot),
    unixTimestamp: big(entry.unixTimestamp),
    quoteDepth: big(entry.quoteDepth),
  })),
  nextIndex: Number(raw.nextIndex),
  bump: Number(raw.bump),
});

/**
 * Observations ordered oldest to newest.
 *
 * The on-chain buffer is written in place once it is full, so its array order
 * is insertion order and not time order. Mirrors `MarketOracle::ordered`.
 */
export const orderedObservations = (oracle: MarketOracleAccount): MarketObservation[] =>
  [...oracle.observations].sort((a, b) => Number(a.unixTimestamp - b.unixTimestamp));

/**
 * Whether the market has enough history, over enough elapsed time, to lend
 * against. Mirrors `MarketOracle::is_bootstrapped`.
 */
export const isBootstrapped = (oracle: MarketOracleAccount): boolean => {
  const ordered = orderedObservations(oracle);
  if (ordered.length < oracle.config.minObservations) return false;
  const span = Number(ordered[ordered.length - 1]!.unixTimestamp - ordered[0]!.unixTimestamp);
  return span >= oracle.config.minSpanSeconds;
};
