/**
 * @aera/sdk — TypeScript client for the Aera lending protocol on Cookie Chain.
 *
 * Method names follow Aave's vocabulary (`supply`, `withdraw`,
 * `depositCollateral`, `borrow`, `repay`, `liquidate`, `getReserves`,
 * `getUserAccount`, `healthFactor`, `previewBorrow`) even though the on-chain
 * instructions are snake_case.
 */

export { AeraClient, shareAta, type AeraClientOptions, type BatchedRead, type ProjectedPosition } from './client.js';
export * from './receipts.js';
export * from './receiptVerification.js';
export * from './matchedExit.js';
export * from './strategyAccounting.js';
export * from './yieldEscrow.js';
export * from './strategyBridge.js';
/** SOL from Solana to Cookie Chain over the Cookie team's Hyperlane warp route. */
export * from './bridge.js';
export * from './strategyInventory.js';
export { AeraAdmin } from './admin.js';

/** BakeYourStake's stake pool, driven directly: DepositSol and WithdrawSol. */
export {
  BCOOK_STAKE_POOL,
  STAKE_POOL_ACCOUNT_LEN,
  STAKE_POOL_PROGRAM_ID,
  applyStakePoolFee,
  decodeStakePool,
  depositSolIx,
  feeBps,
  lamportsForWithdrawal,
  poolTokensForDeposit,
  poolTokensForLamports,
  withdrawSolIx,
  withdrawableLamports,
  type StakePoolFee,
  type StakePoolState,
} from './stakePool.js';

export {
  AERA_PROGRAM_ID,
  BPS,
  COOKIE_API_URL,
  COOKIE_EXPLORER_URL,
  COOKIE_RPC_URL,
  COOKIE_WS_URL,
  COOK_DECIMALS,
  FIXED_POINT_SCALE,
  HF_BAND,
  SEED,
} from './constants.js';

export { readEnv, readEnvOr } from './env.js';

export {
  NATIVE_MINT,
  ensureAtaIx,
  isNativeMint,
  unwrapNativeIx,
  wrapNativeIxs,
} from './native.js';

export {
  getAsset,
  resolveMintBySymbol,
  searchFungibleAssets,
  type DasOptions,
  type DasTokenAsset,
  type ResolveOptions,
  type ResolveResult,
} from './das.js';

export {
  decodeGlobal,
  decodeMarket,
  decodeObligation,
  decodeReserve,
  decodeSupplyPosition,
} from './decode.js';

export {
  availableToBorrowValue,
  healthFactor,
  isLiquidatable,
  previewBorrow,
  previewDepositCollateral,
  previewRepay,
  maxWithdrawCollateral,
  previewWithdrawCollateral,
  userAccountView,
  type PositionValues,
} from './health.js';

export {
  applyHaircut,
  borrowRateBps,
  bpsToPercent,
  capHeadroom,
  currentBorrowed,
  fromDisplay,
  grossLiquidity,
  liquidityToShares,
  marketValue,
  mulDivCeil,
  mulDivFloor,
  scaledToDisplay,
  sharesToLiquidity,
  supplyRateBps,
  toDisplay,
  totalLiquidity,
  utilizationBps,
  valueToAmount,
} from './math.js';

export {
  BCOOK_RESERVE_CONFIG,
  COOK_RESERVE_CONFIG,
  CHAIN,
  DEFAULT_SLOTS_PER_YEAR,
  LAUNCH_CONFIG,
  ORACLE_CONFIG,
  STAKE_POOL,
} from './params.js';

export {
  globalPda,
  liquidityVaultPda,
  marketPda,
  obligationPda,
  obligationShareVaultPda,
  marketOraclePda,
  oraclePda,
  riskConfigPda,
  reservePda,
  shareMintPda,
  supplyPositionPda,
} from './pda.js';

export type {
  GlobalAccount,
  MarketAccount,
  ObligationAccount,
  ObligationCollateral,
  ObligationLiquidity,
  PendingConfig,
  ReserveAccount,
  ReserveConfig,
  ReserveView,
  ShareMetadata,
  SupplyPositionAccount,
  UserAccountView,
} from './types.js';

/**
 * The v0.2 oracle.
 *
 * Replaces the guardian `PriceFeed` surface entirely: no quorum, no freshness
 * window, no submissions, no publisher. See `docs/ORACLE_V0_2.md`.
 */
export {
  applyWithdrawalFee,
  decodeMarketOracle,
  decodeOracleState,
  formatRate,
  hasReference,
  haircutRate,
  healthName,
  isBootstrapped,
  OracleHealth,
  OracleSourceKind,
  orderedObservations,
  permits,
  rateView,
  readsSourceAccount,
  refreshReason,
  RiskAction,
  type BreakerConfig,
  type MarketObservation,
  type MarketOracleAccount,
  type MarketOracleConfig,
  type OracleReference,
  type OracleStateAccount,
  type PoolRef,
  AmmKind,
  type RateView,
} from './oracle.js';

export {
  decodeRelayedRate,
  isRelayStale,
  MAX_RELAYED_RATE_AGE_SECONDS,
  RELAYED_RATE_DISCRIMINATOR,
  RELAYED_RATE_LEN,
  relayAgeSeconds,
  type RelayedRateAccount,
} from './relayed.js';

export {
  BPF_LOADER_UPGRADEABLE,
  NO_UPGRADE_AUTHORITY,
  nativeBcookConfig,
  programDataAddress,
  RATE_RECEIVER_PROGRAM_ID,
  relayedRateConfig,
  relayedRateFeedAddress,
  toOracleConfig,
  unitOfAccountConfig,
  type BreakerConfigArgs,
  type OracleConfigArgs,
  type RelayedRateArgs,
} from './oracleConfig.js';

/**
 * Telling a v0.1 deployment from a v0.2 one.
 *
 * The account's length is its version, by design. Reading it as bytes rather
 * than decoding is what lets a tool report "not migrated yet" instead of
 * throwing a buffer-bounds error at an operator mid-launch.
 */
export {
  GLOBAL_V1_LEN,
  GLOBAL_V2_LEN,
  GLOBAL_VERSION_V1,
  GLOBAL_VERSION_V2,
  readDeploymentEra,
  type DeploymentEra,
  type Era,
  type MigrationStatus,
} from './era.js';

/**
 * Liquidation economics: how the bonus is divided between the liquidator and
 * Aera, and what a given close would move.
 *
 * The protocol share is carved OUT of the bonus the borrower already pays and
 * never added to it. `liquidatorBonusBps` is the figure a keeper must size
 * against; the reserve's `liquidationBonusBps` is what the borrower pays.
 */
export {
  bonusSplit,
  liquidatorBonusBps,
  previewLiquidation,
  splitSeizedShares,
  type BonusSplit,
  type LiquidationPreview,
} from './liquidation.js';

export { decodeRiskConfig } from './decode.js';
export type { RiskConfigAccount } from './types.js';
export { SOL_MARKET_ID, BRIDGED_SOL_MINT, ASOL_MINT, SOL_MARKET_COOK_MINT, readSolMarket, solReserveStatus, type SolMarketStatus, type SolReserveStatus } from './solMarket.js';

/**
 * What `refresh_obligation` would write, without sending it.
 *
 * An obligation's stored values are only as fresh as its last refresh, and
 * every user action after one leaves them stale -- a fresh borrow reads as zero
 * debt. Anything that judges a position (liquidator, monitor, alerts) projects
 * the refresh with these instead. Pinned to the program by
 * `config/keeper-vectors.json`.
 */
export {
  accrueReserve,
  accruedReserves,
  applyHaircutOf,
  borrowRateBpsOf,
  borrowRatePerSlotOf,
  currentBorrowedAmount,
  debtAt,
  grossLiquidityOf,
  liquidityToSharesDown,
  marketValueOf,
  projectObligation,
  ProjectionError,
  sharesToLiquidityDown,
  totalLiquidityOf,
  utilizationBpsOf,
  valueToAmountDown,
  type ProjectedBorrow,
  type ProjectedCollateral,
  type ProjectedObligation,
} from './projection.js';

export * from './staking.js';

/** aCOOK as a COOK savings receipt: the disclosure read from chain, and the zap from aCOOK to bCOOK for perps. */
export * from './acookSavings.js';
export * from './exchange.js';
/** The spend guard's pure check, for keepers that build their own swaps (keepers/cook-peg). */
export { assessSpend, NATIVE_FEE_ALLOWANCE, type AccountState, type SpendBudget } from './swapGuard.js';
export * from './spotOrders.js';

/** aSOL staking: stake aSOL, earn SOL every second (protocol/stake-program). */
export * from './asolStaking.js';

/** Perps holder fees to aSOL stakers: the chain-derived ledger, fund records and the yield split. */
export * from './holderFees.js';

/** The retired inverse SOL-PERP of the aSOL program GqvG8 (protocol/perps-live): history and exits only. */
export * from './perpsLive.js';

/** Aera Perps on bCOOK (program AE5G6RFS…, protocol/perps-v2): SOL/BTC/ETH/HYPE/COOK-PERP, the shared LP pool, the settlement band. */
export * from './perpsMarkets.js';
export * from './perpsFinal.js';
export * from './cookFeed.js';
export * from './poolMarkets.js';
export * from './yieldTokens.js';

/** Permissionless creator markets (docs/ISOLATED_MARKETS.md): builders and decoders. */
export * from './isolatedMarkets.js';
/** Creator markets for apps and keepers: discovery, the creator flow, lending, cover. */
export * from './isolatedClient.js';
