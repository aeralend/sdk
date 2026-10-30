/**
 * Aera Perps on bCOOK (SDK 0.3.0): the linear USD markets (BTC, ETH, HYPE,
 * SOL, COOK-PERP) and the shared LP pool of program `AE5G6RFS…`
 * (`protocol/perps-v2`, docs/BCOOK_SETTLEMENT.md). Margin, settlement and LP
 * asset: bCOOK, BakeYourStake's stake-pool token (`EkPafx58…`, CLASSIC SPL
 * Token, 9 decimals).
 *
 * Every USD amount (PnL, fees, maintenance, the wick fee, the leverage check)
 * becomes bCOOK through a COOK/USD settlement price: the program's own pool
 * oracle `["pool-oracle", "MCOOK"]` (a one-hour TWAP of two pinned COOK/SOL
 * pools times RedStone's SOL/USD), used as a BAND `[settleLo, settleHi]`, and
 * bCOOK's rate from the stake pool `GxbNKNYd…`. Each conversion takes the end
 * worse for the trader (`perps-engine/src/linear.rs`): gains at the high end,
 * losses, fees, maintenance and buying power at the low end (which also
 * carries the stake pool's withdrawal fee), liquidation only at both ends,
 * LP deposits at the NAV-high end, withdrawals at the NAV-low end, funding at
 * the TWAP. All of it is mirrored here in exact bigint arithmetic and pinned
 * by `protocol/perps-v2/perps-program/tests/fixtures/perps-bcook-golden.json`
 * (`test/perps-bcook*.test.ts`). The program is the authority.
 *
 * Every action is an order that escrows its bCOOK at submission and fills on
 * the FIRST asset and settlement prices published 2-32 s after it.
 *
 * ## Two programs
 *
 * Every address helper and instruction builder takes a last, optional
 * `program: PerpsProgram` argument: `'bcook'` (the default, the live program)
 * or `'asol-v2'`, the retired aSOL program `GqvG8…`, kept only so its markets
 * can be paused, its LPs withdrawn and its fees collected
 * (scripts/perps-bcook/retire-v2.mjs), and its history read. The two share
 * account layouts, discriminators and the `Action`/`Order` encoding; they
 * differ in program id, mint and token program (aSOL, Token-2022), and in the
 * two price accounts every linear instruction takes (`["price"]` and Aera's
 * SOL reserve on v2; the MCOOK oracle and bCOOK's stake pool here). The
 * arithmetic follows the quote: a `BcookQuote` (settle band) runs the bCOOK
 * engine, a legacy `AsolV2Quote` (`solMicros`) the retired one. The inverse
 * SOL-PERP and its instructions (`perpsLive.ts`) exist only on `GqvG8…`.
 */
import { Connection, PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
// A cycle with poolMarkets.ts, safe: neither module uses the other's bindings at load time.
import { decodePoolOracle, type PoolQuote } from './poolMarkets.js';
import { decodeStakePool, depositSolIx, feeBps as stakePoolFeeBps, poolTokensForDeposit, type StakePoolState } from './stakePool.js';

/** Aera Perps on bCOOK: the live program. */
export const PERPS_PROGRAM_ID = new PublicKey('AE5G6RFSxbyJ5HLCSAiXTb96WUkj9tr9zLxjWwZkp4m2');
/** The retired aSOL perps program: paused, LP withdrawn, read-only history. */
export const RETIRED_ASOL_PERPS_PROGRAM_ID = new PublicKey('GqvG8aNWa8fJ8xuoPqqHbPiowVbX4GWm8gMPsSyFgJfq');
/** The admin of both programs. */
export const PERPS_ADMIN = new PublicKey('GqdCnvFd8ErGTSdz7VdYmMNNh4nvMMmuw7GAA5SQ6gRG');
/** bCOOK: margin, settlement and LP asset. Classic SPL Token, 9 decimals. */
export const PERPS_BCOOK_MINT = new PublicKey('EkPafx58mgwkEnGwo62jXhXDAdJ37Z8G8MFBRPsr9uhz');
/** The stake pool that issues bCOOK: its rate is read by every fill. */
export const PERPS_STAKE_POOL = new PublicKey('GxbNKNYdtNXQkhDkpHdLDAMX64GxaECgANqdfp6cUGH4');
export const PERPS_STAKE_POOL_PROGRAM = new PublicKey('GZgs5uREPp6BvDt8eysmhavQPAHBAtjePgV4zfhgd9pH');
/** The token program of every bCOOK account the program touches: classic SPL Token, never Token-2022. */
export const PERPS_TOKEN_PROGRAM = TOKEN_PROGRAM_ID;
/** Aera's fee destination wallet; its bCOOK (classic) ATA receives protocol fees. */
export const MARKETS_FEE_DESTINATION = new PublicKey('22v7PjUXNu8t9JJhZYFhsS1TFgkqqTxJtq3ZQdy85CyR');
/** Retired program only: aSOL (Token-2022), and Aera's SOL reserve it read aSOL's rate from. */
export const MARKETS_ASOL_MINT = new PublicKey('FHv5bDrikq9sA4ckNNTsvqZHGoWYSnPMFJC8xHszKwbq');
export const MARKETS_SOL_RESERVE = new PublicKey('HEr4uwrN7Cz1uegzYRP7GiHPXN2GjMK6tvQCTm12phjT');

/** Which perps program: the live bCOOK one (default) or the retired aSOL one. */
export type PerpsProgram = 'bcook' | 'asol-v2';
/** What differs between the two programs, for building any instruction. */
export interface PerpsDeployment {
  program: PerpsProgram;
  programId: PublicKey;
  /** Margin and LP mint. */
  mint: PublicKey;
  /** The mint's token program: classic SPL Token (bcook) or Token-2022 (asol-v2). */
  tokenProgram: PublicKey;
  /** Where the share rate comes from: bCOOK's stake pool, or (v2) Aera's SOL reserve. */
  rateAccount: PublicKey;
}
const DEPLOYMENTS: Record<PerpsProgram, PerpsDeployment> = {
  bcook: { program: 'bcook', programId: PERPS_PROGRAM_ID, mint: PERPS_BCOOK_MINT, tokenProgram: TOKEN_PROGRAM_ID, rateAccount: PERPS_STAKE_POOL },
  'asol-v2': { program: 'asol-v2', programId: RETIRED_ASOL_PERPS_PROGRAM_ID, mint: MARKETS_ASOL_MINT, tokenProgram: TOKEN_2022_PROGRAM_ID, rateAccount: MARKETS_SOL_RESERVE },
};
export function perpsDeployment(program: PerpsProgram = 'bcook'): PerpsDeployment {
  const d = DEPLOYMENTS[program];
  if (!d) throw new Error(`unknown perps program ${String(program)}`);
  return d;
}

/** RedStone feeds with linear markets (besides SOL). HYPE is Hyperliquid's token. */
export const LINEAR_FEEDS = ['BTC', 'ETH', 'HYPE'] as const;
/**
 * Feeds priced from AMM pools by the program itself (`post_pool_price`).
 * `MCOOK` is one million COOK: COOK-PERP's asset AND every market's
 * settlement price. Its market fills at the price worse for whoever acts.
 */
export const POOL_FEEDS = ['MCOOK'] as const;
export const isPoolFeed = (feed: string): boolean => (POOL_FEEDS as readonly string[]).includes(feed);
/** The settlement price's feed: `["pool-oracle", "MCOOK"]`. */
export const SETTLE_FEED = 'MCOOK';

/** Fixed terms of the program; per-market limits live in each market account. */
export const LINEAR_TERMS = Object.freeze({
  /**
   * 50x since the final upgrade (3 before). Each market's own limit, leverage
   * tiers and maintenance are admin settings on its account (`LinearRisk`).
   */
  hardMaxLeverage: 50,
  hardMaxNotionalUsdMicros: 100_000_000_000n,
  hardMaxPositions: 32,
  maxLps: 32,
  maxPositionsPerOwner: 4,
  minNotionalUsdMicros: 10_000_000n,
  /**
   * Raw bCOOK: 10,000 bCOOK (~$0.77 on 2026-10-22). The smallest LP deposit,
   * and the smallest LP balance a partial withdrawal may leave (`Accounting`).
   */
  minLpDeposit: 10_000_000_000_000n,
  /** The retired aSOL program's floor: 0.1 aSOL. */
  minLpDepositAsolV2: 100_000_000n,
  /** Charged on opening and again on closing. */
  feeBps: 8n,
  maintenanceBps: 1000n,
  maxPriceAgeSeconds: 35,
  maxPriceSkewSeconds: 10,
  minFillDelaySeconds: 2,
  maxFillDelaySeconds: 32,
  maxDeadlineSeconds: 60,
  /**
   * How long after submission an order may still fill, then becomes refundable.
   * It must outlast the 2-32 s fill window plus RedStone delivery lag, inside
   * the program's 3-60 s; 55 s leaves room for Cookie's clock running behind.
   */
  orderDeadlineSeconds: 55,
  fundingWindowSeconds: 90,
  signerThreshold: 4,
  /** A stake-pool withdrawal fee above this refuses bCOOK's rate: nothing fills. */
  maxWithdrawalFeeBps: 1000,
  /** The stake pool must be updated this epoch or the one before. */
  maxRateEpochsOld: 1n,
  /** An asset price silent this long counts toward an outage... */
  assetOutageSeconds: 21_600,
  /** ...the settlement price (and COOK-PERP's own) only after 72 h in all. */
  settleOutageGraceSeconds: 237_600,
  feeSplitBps: { lp: 4000, insurance: 1000, holders: 3000, protocol: 2000 },
  /**
   * The same fee when the order names a referrer (docs/REFERRALS.md): the
   * referrer takes the protocol's 20%; LPs, holders and insurance get exactly
   * the same units as without one.
   */
  feeSplitWithReferrerBps: { lp: 4000, insurance: 1000, holders: 3000, referrer: 2000, protocol: 0 },
});

// --- integrator referrals (docs/REFERRALS.md) ----------------------------------------

/**
 * Referrals: any wallet or frontend may name itself as an order's referrer
 * and is paid, at each fill, 20% of that fill's 0.08% trading fee, in bCOOK,
 * to its CLASSIC SPL Token bCOOK account (`marketsBcookAccount(referrer)`),
 * which must exist. Paid on opens, closes (partial too) and wick-proof opens;
 * never on the prepaid wick fee, LP deposits and withdrawals, liquidations,
 * expiries, take-profits or outage unwinds. The trader pays the same fee
 * either way.
 */
export const REFERRAL_TERMS = Object.freeze({
  /** The referrer's share of each trading fee, bps of the fee. */
  shareOfFeeBps: 2000,
  /** = 20% of 0.08%: 1.6 bps of notional per side. */
  bpsOfNotionalPerSide: 1.6,
  /** The `Order` layout version that carries a referrer. */
  orderVersion: 1,
});
/** The referrer's share of a fee in raw bCOOK: 20%, rounded down (`linear::referral_share`). */
export const referralShare = (fee: bigint): bigint => fee / 5n;
/**
 * A trading fee's split (`linear::fee_split` / `collect_buckets_ref`):
 * protocol 20% (0 with a referrer, who takes it), insurance 10%, holders
 * 30%, LP the rest (40% plus every rounding unit).
 */
export function linearFeeSplit(fee: bigint, referred: boolean): { lp: bigint; holders: bigint; insurance: bigint; protocol: bigint; referral: bigint } {
  const protocol = fee / 5n;
  const insurance = fee / 10n;
  const holders = (fee * 3n) / 10n;
  const lp = fee - protocol - insurance - holders;
  return referred ? { lp, holders, insurance, protocol: 0n, referral: protocol } : { lp, holders, insurance, protocol, referral: 0n };
}
/** A referrer as the program stores it: none for the owner itself or the default key. */
export function effectiveReferrer(referrer: PublicKey | null | undefined, owner: PublicKey): PublicKey | null {
  if (!referrer || referrer.equals(PublicKey.default) || referrer.equals(owner)) return null;
  return referrer;
}

const SCALE = 1_000_000_000n;
const BPS = 10_000n;
const FUNDING_SCALE = 1_000_000_000_000_000_000n;
/** USD micros to raw bCOOK: `usd * 1e24 / (settle * rate)` (1e15 base units per MCOOK × 1e9). */
const CONVERSION = 1_000_000_000_000_000_000_000_000n;
const U64_MAX = 18_446_744_073_709_551_615n;
const U128_LIMIT = 1n << 128n;
const I128_MAX = (1n << 127n) - 1n;
const I128_MIN = -(1n << 127n);
/** The engine's saturation bound (`i128::MAX / 4`): far beyond any clamp. */
const SATURATED = I128_MAX / 4n;

const hex = (h: string): number[] => h.match(/../g)!.map((b) => parseInt(b, 16));
/** Anchor discriminators (pinned by the golden files; identical on both programs). */
export const MARKETS_DISC = Object.freeze({
  post_price: hex('82f58a8d72320d30'),
  create_market: hex('67e261ebc8bcfbfe'),
  post_feed_price: hex('1d85999bcc8dd51c'),
  set_market_paused: hex('e91fa1f8b26f6641'),
  set_market_limits: hex('7e73b9e57a25763b'),
  submit_order: hex('e696c8355cd06d6c'),
  execute_order: hex('733db418a820d714'),
  cancel_order: hex('5f81edf00831df84'),
  checkpoint_market: hex('eae7de2fd1ed8a40'),
  liquidate_market: hex('6fa1e307e555ac3f'),
  outage_close_market: hex('ae11233d237df075'),
  outage_withdraw_market: hex('60d2a5e0d5e8b409'),
  collect_market_fees: hex('5bd2af37337589ee'),
  collect_market_bucket_fees: hex('6e0d604de6ba0965'),
  LinearMarketState: hex('c20537f1c18b5e48'),
  FeedPrice: hex('2cdf42a727089120'),
  PriceState: hex('ca28259d497598fb'),
  Order: hex('86addfb94d561c33'),
  post_pool_price: hex('4aaa7be432f03f30'),
  create_pool_oracle: hex('dec2ff5285966a36'),
  set_pool_params: hex('9b39981b9a8ca67e'),
  set_pool_pins: hex('628bb90566b21024'),
  PoolOracle: hex('59e0dc068ab42c6a'),
  // The shared LP pool (docs/PERPS_SHARED_POOL.md).
  create_lp_pool: hex('5e33e9a52a264fa0'),
  join_lp_pool: hex('df3d9d92a141a6d0'),
  set_lp_pool_paused: hex('f274f03154499efb'),
  set_lp_pool_member_limit: hex('148ea7bace7e56e6'),
  submit_pool_order: hex('93a145939c8474cb'),
  execute_pool_order: hex('f30d1b2db70b0bee'),
  outage_withdraw_pool: hex('47ba5f5b43c6ef61'),
  LpPoolState: hex('d671878715987318'),
  // Wick-proof positions (docs/WICK_PROOF_PERPS.md).
  set_wick_config: hex('7bff08f6dff99a02'),
  settle_wick: hex('2cbe0d3f1ae5732b'),
  // The final upgrade (golden `v4.instructions`).
  init_config: hex('17eb73e8a86001e7'),
  propose_oracle_settings: hex('5821156a12df1838'),
  apply_oracle_settings: hex('09f50dd58e2f85db'),
  cancel_oracle_settings: hex('074c53541d1c9116'),
  set_market_risk: hex('68086c22310be1fc'),
  apply_market_risk: hex('8f8a0aba86c5fc38'),
  cancel_market_risk: hex('83f947634da0f3ac'),
  migrate_market: hex('c971b578d93c6dcb'),
  migrate_pool_oracle: hex('c887793562a76b80'),
  apply_pool_params: hex('c51ef6dedc6f2b19'),
  cancel_pool_params: hex('3efff9feeae6b8a2'),
  add_margin: hex('d3eeee5adfe4e44c'),
  fund_insurance: hex('3ad825a2c9321442'),
  settle_claim: hex('cdcb1542ffe7d19b'),
  ProgramConfig: hex('c4d25ae790958c3f'),
  // Events.
  MarketPositionOpened: hex('2106801953d8abcc'),
});

// --- addresses -------------------------------------------------------------------

const enc = (s: string) => new TextEncoder().encode(s);
const pda = (program: PerpsProgram, ...seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, perpsDeployment(program).programId)[0];
const le64 = (v: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); return b; };
/** `["pool-oracle", feed]`: a pool feed's oracle. MCOOK's is also the settlement price (`settleOracleAccount`). */
export const poolOracleAccount = (feed: string, program: PerpsProgram = 'bcook'): PublicKey => pda(program, enc('pool-oracle'), enc(feed));
/**
 * The settlement price every linear instruction takes in its `settle` slot
 * (formerly `sol_price`): `["pool-oracle", "MCOOK"]` of the bCOOK program.
 * On the retired program that slot held the SOL price `["price"]`.
 */
export function settleOracleAccount(program: PerpsProgram = 'bcook'): PublicKey {
  return program === 'bcook' ? poolOracleAccount(SETTLE_FEED, 'bcook') : solPriceAccount(program);
}
/** The account in the slot formerly `reserve`: bCOOK's stake pool (Aera's SOL reserve on the retired program). */
export const rateAccount = (program: PerpsProgram = 'bcook'): PublicKey => perpsDeployment(program).rateAccount;
/**
 * The linear SOL market's feed: `["market", "SOL"]`, priced from the SOL price
 * account `["price"]` itself, which `post_price` writes. Never a `FeedPrice`:
 * the program refuses `post_feed_price("SOL")`.
 */
export const SOL_LINEAR_FEED = 'SOL';
/**
 * The shared LP pool's members, in the order `init.mjs` joins them (indices
 * 0..3). Every pool-wide instruction passes their `[market, price]` accounts
 * in the pool ledger's member order: read it from `LpPoolState.members`.
 */
export const POOL_MEMBER_FEEDS = ['BTC', 'ETH', SOL_LINEAR_FEED, 'HYPE'] as const;
/** The retired program's pool member order. */
export const POOL_MEMBER_FEEDS_ASOL_V2 = ['BTC', 'ETH', 'HYPE', SOL_LINEAR_FEED] as const;
/** `["market", feed]`. */
export const linearMarket = (feed: string, program: PerpsProgram = 'bcook'): PublicKey => pda(program, enc('market'), enc(feed));
/** `["custody", feed]`: the market's own vault. */
export const linearVault = (feed: string, program: PerpsProgram = 'bcook'): PublicKey => pda(program, enc('custody'), enc(feed));
/** `["price", feed]`: a feed's `FeedPrice` account (RedStone's `post_feed_price`, or MCOOK's `post_pool_price`). */
export const feedPriceAccount = (feed: string, program: PerpsProgram = 'bcook'): PublicKey => pda(program, enc('price'), enc(feed));
/** `["price"]`: the RedStone SOL/USD price (`post_price`); the linear SOL market's asset price and the pool oracle's SOL leg. */
export const solPriceAccount = (program: PerpsProgram = 'bcook'): PublicKey => pda(program, enc('price'));
/** The price account a linear market reads for its asset: `["price", feed]`, or `["price"]` for SOL. */
export const linearPriceAccount = (feed: string, program: PerpsProgram = 'bcook'): PublicKey =>
  feed === SOL_LINEAR_FEED ? solPriceAccount(program) : feedPriceAccount(feed, program);
/** `["lp_pool", [id]]`: a shared LP pool. Id 0 is the one `init.mjs` creates. */
export const lpPoolAccount = (id = 0, program: PerpsProgram = 'bcook'): PublicKey => pda(program, enc('lp_pool'), Uint8Array.of(id));
/** `["pool_custody", pool]`: the shared pool's vault, owned by the pool. */
export const lpPoolVault = (pool: PublicKey, program: PerpsProgram = 'bcook'): PublicKey => pda(program, enc('pool_custody'), pool.toBytes());
/** `["order", market, owner, nonce]`. */
export const linearOrder = (market: PublicKey, owner: PublicKey, nonce: bigint, program: PerpsProgram = 'bcook'): PublicKey =>
  pda(program, enc('order'), market.toBytes(), owner.toBytes(), le64(nonce));
/** A wallet's classic SPL Token bCOOK ATA: what every bCOOK order, payout and referral uses. */
export const marketsBcookAccount = (owner: PublicKey): PublicKey =>
  getAssociatedTokenAddressSync(PERPS_BCOOK_MINT, owner, true, TOKEN_PROGRAM_ID);
/** Retired program only: a wallet's Token-2022 aSOL ATA. */
export const marketsAsolAccount = (owner: PublicKey): PublicKey =>
  getAssociatedTokenAddressSync(MARKETS_ASOL_MINT, owner, true, TOKEN_2022_PROGRAM_ID);
/** A wallet's margin-token account on `program`. */
export const marketsTokenAccount = (owner: PublicKey, program: PerpsProgram = 'bcook'): PublicKey =>
  program === 'bcook' ? marketsBcookAccount(owner) : marketsAsolAccount(owner);
/** The fee destination's account on `program` (bCOOK classic ATA `4412FLDX…`). */
export const feeDestinationAccount = (program: PerpsProgram = 'bcook'): PublicKey => marketsTokenAccount(MARKETS_FEE_DESTINATION, program);

// --- accounts ----------------------------------------------------------------------

export type LinearSide = 'long' | 'short';
export interface LinearPosition {
  id: bigint;
  owner: PublicKey;
  side: LinearSide;
  /** Raw bCOOK (aSOL on the retired program) after the opening fee. */
  margin: bigint;
  notionalUsdMicros: bigint;
  entryPriceMicros: bigint;
  /** The most this position can win, in raw bCOOK, reserved from LP free cash at entry. */
  profitCap: bigint;
  fundingEntry: bigint;
  /**
   * Set for a wick-proof position (decoded from the ledger's wick trailer):
   * no liquidation, an expiry, a prepaid wick fee. Absent for a normal one.
   */
  wick?: WickTerms;
}
/** A market's wick-proof terms (`set_wick_config`), within the program's hard bounds. */
export interface WickConfig {
  /** Hundredths of a bp of notional per hour: 180 is 1.8 bp/h. */
  rate: number;
  maxLeverage: number;
  maxDurationSeconds: number;
  /** Wick-proof positions open at once; 0 stops new ones (the bCOOK launch value). */
  maxPositions: number;
  /** Share of the member's pool reserve limit wick-proof caps may use, bps. */
  maxReserveBps: number;
}
/** One wick-proof position's terms, fixed at open. */
export interface WickTerms {
  openedAt: number;
  expiresAt: number;
  /** Raw bCOOK prepaid for the whole duration; unused time is refunded on an early close. */
  prepaid: bigint;
  rate: number;
  takeProfit: boolean;
}
export interface LinearLimits { maxNotionalUsdMicros: bigint; maxPositions: number; maxLeverage: number }
/** One leverage tier: positions up to `maxNotionalUsdMicros` may use up to `maxLeverage`. */
export interface LinearTier { maxNotionalUsdMicros: bigint; maxLeverage: number }
/**
 * A market's risk settings (admin, within on-chain bounds; `perps-engine`'s
 * `Risk`): leverage by position size, maintenance, the liquidator's fee, the
 * trading fee and its split, funding, the volatility breaker, delayed
 * settlement. Markets still on the v3 ledger have the default for their limits.
 */
export interface LinearRisk {
  /** Tiers by notional, increasing; leverage never rises with size. */
  tiers: LinearTier[];
  /** Maintenance, bps of notional (floor: half the initial margin at the top leverage, at most 10%). */
  maintenanceBps: number;
  /** The liquidator's fee, bps of the position's MARGIN, out of what is left of it. */
  liquidationFeeBps: number;
  /** Trading fee, bps of notional, on open and again on close. */
  feeBps: number;
  protocolBps: number;
  insuranceBps: number;
  holderBps: number;
  fundingBpsPerHour: number;
  /** While the volatility breaker is on, opens above this leverage are refused. */
  breakerMaxLeverage: number;
  /** Also liquidate a position bankrupt at the band's LOW end (a COOK crash the TWAP has not followed). */
  liquidateBankrupt: boolean;
  /** Insurance above this may be collected with the holder bucket (2^64-1: never). */
  insuranceCap: bigint;
  /** A price move above this many bps between consecutive posts turns the breaker on (0: off). */
  breakerMoveBps: number;
  breakerSeconds: number;
  /** Delayed settlement: a gain above `deferGainUsd` / a loss above `deferLossUsd` (USD micros; 2^64-1: never) is revalued on the TWAP of the `deferWindowSeconds` after the close (0: off). */
  deferGainUsd: bigint;
  deferLossUsd: bigint;
  deferWindowSeconds: number;
}
/** A payout held back by delayed settlement (`settle_claim` pays it once due). */
export interface LinearClaim {
  id: bigint;
  owner: PublicKey;
  kind: 'gain' | 'loss';
  /** Raw bCOOK held in the market's vault for the owner. */
  amount: bigint;
  /** For a loss claim: the loss beyond the threshold, raw bCOOK at the close. */
  basis: bigint;
  /** The close's band end (the high end for a gain, the gross low end for a loss), USD micros per MCOOK. */
  reference: bigint;
  cum: bigint;
  cumAt: number;
  dueAt: number;
}
export interface LinearBadDebt { shortfall: bigint; covered: bigint; uncovered: bigint }
export interface LinearPendingRisk { limits: LinearLimits; risk: LinearRisk; effectiveAt: number }
/** A member market's link to the shared LP pool: the ledger's trailer `[1, pool, member]`. */
export interface PoolLink { pool: PublicKey; member: number }
export interface LinearLedger {
  limits: LinearLimits;
  lpCash: bigint;
  lpShareSupply: bigint;
  lpBalances: Map<string, bigint>;
  positions: LinearPosition[];
  nextId: bigint;
  protocolFees: bigint;
  insuranceFees: bigint;
  holderFees: bigint;
  fundingIndex: bigint;
  fundingRate: bigint;
  fundingTime: bigint;
  fundingValidUntil: bigint;
  lastPublication: bigint;
  /**
   * Set once the market joined a shared LP pool (for good). Its own LP books
   * are then empty: capital, LP balances, profit-cap reserves and trader PnL
   * are the pool's. Null for an isolated market (COOK-PERP).
   */
  pool: PoolLink | null;
  /** The market's wick-proof terms (the ledger's second trailer), or null. */
  wick?: WickConfig | null;
  /** The market's risk settings. A v3 ledger: the default for its limits. */
  risk: LinearRisk;
  /** True once the ledger is the v4 layout (`migrate_market` ran). */
  v4: boolean;
  /** Payouts held back by delayed settlement. */
  claims: LinearClaim[];
  /** Bad debt booked so far, and how much of it the insurance fund covered. */
  badDebt: LinearBadDebt;
  /** The volatility breaker is on until this time (0: off). */
  breakerUntil: number;
  /** A loosening risk change waiting for its timelock. */
  pendingRisk: LinearPendingRisk | null;
}
export interface LinearMarketState {
  feed: string;
  price: PublicKey;
  vault: PublicKey;
  bump: number;
  paused: boolean;
  /** bCOOK escrowed by orders not yet executed or refunded. */
  pending: bigint;
  ledger: LinearLedger;
}
export interface FeedPriceState {
  feed: string;
  priceUsdMicros: bigint;
  publishedAt: number;
  signers: number;
  /** When the price this one replaced was published (8 bytes after the struct); null on an old-size account. */
  previousPublishedAt?: number | null;
  /** The price this one replaced (the next 8 bytes, v4); null on an account not yet posted at the v4 size. The volatility breaker compares the two. */
  previousPriceMicros?: bigint | null;
}
export type LinearAction =
  | { kind: 'open'; long: boolean; collateral: bigint; notional: bigint; profitCap: bigint }
  /** Tag 1: a full close. */
  | { kind: 'close'; position: bigint; minimum: bigint }
  /** Tag 5: close `notional` USD micros of the position (both halves at least $10). */
  | { kind: 'closePart'; position: bigint; minimum: bigint; notional: bigint }
  | { kind: 'deposit'; amount: bigint; minimum: bigint }
  | { kind: 'withdraw'; shares: bigint; minimum: bigint }
  /** Tag 4: a wick-proof open. `collateral` is the whole stake (margin + opening fee + prepaid wick fee). */
  | { kind: 'openWick'; long: boolean; collateral: bigint; notional: bigint; profitCap: bigint; durationSeconds: number; takeProfit: boolean }
  /** Tag 6: take `amount` of margin out of a normal position (it keeps twice its tier's initial margin). */
  | { kind: 'removeMargin'; position: bigint; amount: bigint };
export interface LinearOrderState {
  address: PublicKey;
  market: PublicKey;
  owner: PublicKey;
  nonce: bigint;
  action: LinearAction;
  createdAt: number;
  createdSlot: bigint;
  deadline: number;
  minPrice: bigint;
  maxPrice: bigint;
  active: boolean;
  /** 0: written before referrals (no referrer); 1 (`REFERRAL_TERMS.orderVersion`): carries one. */
  version: number;
  /** The wallet this order pays 20% of its fill's fee to, or null. */
  referrer: PublicKey | null;
}

class Reader {
  o: number;
  constructor(private d: Uint8Array, at = 0) { this.o = at; }
  private view(n: number) { const v = new DataView(this.d.buffer, this.d.byteOffset + this.o, n); this.o += n; return v; }
  u8() { return this.view(1).getUint8(0); }
  u16() { return this.view(2).getUint16(0, true); }
  u32() { return this.view(4).getUint32(0, true); }
  u64() { return this.view(8).getBigUint64(0, true); }
  u128() { const v = this.view(16); return v.getBigUint64(0, true) | (v.getBigUint64(8, true) << 64n); }
  i64() { return this.view(8).getBigInt64(0, true); }
  i128() { const v = this.view(16); return v.getBigUint64(0, true) | (v.getBigInt64(8, true) << 64n); }
  key() { const k = new PublicKey(this.d.subarray(this.o, this.o + 32)); this.o += 32; return k; }
  feed() { const b = this.d.subarray(this.o, this.o + 32); this.o += 32; const n = b.indexOf(0); return new TextDecoder().decode(b.subarray(0, n < 0 ? 32 : n)); }
}
function expect(d: Uint8Array, name: 'LinearMarketState' | 'FeedPrice' | 'Order' | 'LpPoolState' | 'MarketPositionOpened') {
  if (!MARKETS_DISC[name].every((b, i) => d[i] === b)) throw new Error(`not a perps ${name} account`);
}

/** A linear market account, ledger included. */
export function decodeLinearMarket(d: Uint8Array): LinearMarketState {
  expect(d, 'LinearMarketState');
  const r = new Reader(d, 8);
  const feed = r.feed();
  const price = r.key();
  const vault = r.key();
  const bump = r.u8();
  const paused = r.u8() === 1;
  const pending = r.u64();
  const ledgerLength = r.u32();
  // The ledger's own length decides whether it has a trailer.
  const ledgerEnd = r.o + ledgerLength;
  if (LEDGER_MAGIC.every((b, i) => d[r.o + i] === b)) {
    r.o += LEDGER_MAGIC.length;
    return { feed, price, vault, bump, paused, pending, ledger: decodeV4Ledger(r, ledgerEnd) };
  }
  const limits = { maxNotionalUsdMicros: r.u64(), maxPositions: r.u16(), maxLeverage: r.u8() };
  const lpCash = r.u64();
  const lpShareSupply = r.u64();
  const lpBalances = new Map<string, bigint>();
  for (let n = r.u32(); n > 0; n--) lpBalances.set(r.key().toBase58(), r.u64());
  const positions: LinearPosition[] = [];
  for (let n = r.u32(); n > 0; n--) {
    const id = r.u64();
    positions.push({
      id, owner: r.key(), side: r.u8() === 0 ? 'long' : 'short',
      margin: r.u64(), notionalUsdMicros: r.u64(), entryPriceMicros: r.u64(), profitCap: r.u64(), fundingEntry: r.i128(),
    });
  }
  const tail = {
    nextId: r.u64(), protocolFees: r.u64(), insuranceFees: r.u64(), holderFees: r.u64(),
    fundingIndex: r.i128(), fundingRate: r.i128(), fundingTime: r.i64(), fundingValidUntil: r.i64(), lastPublication: r.i64(),
  };
  // Bytes past the ledger's length are dead (older, longer ledgers left them): never read.
  let pool: PoolLink | null = null;
  let wick: WickConfig | null = null;
  if (r.o < ledgerEnd) {
    if (ledgerEnd - r.o < 34 || r.u8() !== 1) throw new Error('bad pool trailer on a linear market ledger');
    pool = { pool: r.key(), member: r.u8() };
  }
  // The wick trailer, only after the pool's: [2, config (10), count, (id, terms) * count].
  if (r.o < ledgerEnd) {
    if (ledgerEnd - r.o < 15 || r.u8() !== 2) throw new Error('bad wick trailer on a linear market ledger');
    wick = { rate: r.u16(), maxLeverage: r.u8(), maxDurationSeconds: r.u32(), maxPositions: r.u8(), maxReserveBps: r.u16() };
    const count = r.u32();
    if (ledgerEnd - r.o !== count * 35) throw new Error('bad wick trailer on a linear market ledger');
    for (let n = count; n > 0; n--) {
      const id = r.u64();
      const terms: WickTerms = { openedAt: Number(r.i64()), expiresAt: Number(r.i64()), prepaid: r.u64(), rate: r.u16(), takeProfit: r.u8() === 1 };
      const p = positions.find((x) => x.id === id);
      if (!p) throw new Error('bad wick trailer on a linear market ledger: no such position');
      p.wick = terms;
    }
  }
  return {
    feed, price, vault, bump, paused, pending,
    ledger: { limits, lpCash, lpShareSupply, lpBalances, positions, ...tail, pool, wick, risk: defaultRisk(limits), v4: false, claims: [], badDebt: { shortfall: 0n, covered: 0n, uncovered: 0n }, breakerUntil: 0, pendingRisk: null },
  };
}

/** The first 8 bytes of a v4 ledger (`linear::LEDGER_MAGIC`); a v3 ledger starts with max_notional, never this. */
export const LEDGER_MAGIC: readonly number[] = Object.freeze(hex('41455241763400ff'));
/** The most leverage tiers a market may have. */
export const MAX_TIERS = 4;
/** The leverage a position of `notional` may use under the market's tiers and limit; null above the last tier (`Risk::leverage_for`). */
export function leverageForNotional(limits: LinearLimits, risk: LinearRisk, notionalUsdMicros: bigint): number | null {
  const tier = risk.tiers.find((t) => notionalUsdMicros <= t.maxNotionalUsdMicros);
  return tier ? Math.min(tier.maxLeverage, limits.maxLeverage) : null;
}
/** A market's initial margin at leverage `l`, bps of notional (`linear::initial_margin_bps`). */
export const initialMarginBps = (l: number): number => Math.floor(10_000 / Math.max(l, 1));
/** The lowest maintenance a market whose top leverage is `l` may set: half its initial margin, at most 10% (`linear::maintenance_floor_bps`). */
export const maintenanceFloorBps = (l: number): number => Math.min(Math.floor(initialMarginBps(l) / 2), 1000);
/**
 * What a market has until its admin sets risk (`Risk::default_for`): v3's
 * behaviour at its limits (10% maintenance where that is valid, else half the
 * initial margin).
 */
export function defaultRisk(limits: LinearLimits): LinearRisk {
  const l = Math.min(Math.max(limits.maxLeverage, 1), LINEAR_TERMS.hardMaxLeverage);
  const im = initialMarginBps(l);
  return {
    tiers: [{ maxNotionalUsdMicros: LINEAR_TERMS.hardMaxNotionalUsdMicros, maxLeverage: LINEAR_TERMS.hardMaxLeverage }],
    maintenanceBps: 1000 + Number(LINEAR_TERMS.feeBps) < im ? 1000 : Math.floor(im / 2),
    liquidationFeeBps: 100, feeBps: Number(LINEAR_TERMS.feeBps), protocolBps: 2000, insuranceBps: 1000, holderBps: 3000,
    fundingBpsPerHour: 1, breakerMaxLeverage: LINEAR_TERMS.hardMaxLeverage, liquidateBankrupt: false, insuranceCap: U64_MAX,
    breakerMoveBps: 0, breakerSeconds: 300, deferGainUsd: U64_MAX, deferLossUsd: U64_MAX, deferWindowSeconds: 0,
  };
}
function readRisk(r: Reader): LinearRisk {
  const raw: LinearTier[] = [];
  for (let i = 0; i < MAX_TIERS; i++) raw.push({ maxNotionalUsdMicros: r.u64(), maxLeverage: r.u8() });
  const count = r.u8();
  return {
    tiers: raw.slice(0, count),
    maintenanceBps: r.u16(), liquidationFeeBps: r.u16(), feeBps: r.u16(), protocolBps: r.u16(), insuranceBps: r.u16(), holderBps: r.u16(),
    fundingBpsPerHour: r.u16(), breakerMaxLeverage: r.u8(), liquidateBankrupt: r.u8() === 1, insuranceCap: r.u64(),
    breakerMoveBps: r.u16(), breakerSeconds: r.u32(), deferGainUsd: r.u64(), deferLossUsd: r.u64(), deferWindowSeconds: r.u32(),
  };
}
/** A v4 ledger (the reader is just past the magic): see `linear::LinearMarket`'s borsh impl. */
function decodeV4Ledger(r: Reader, ledgerEnd: number): LinearLedger {
  const limits = { maxNotionalUsdMicros: r.u64(), maxPositions: r.u16(), maxLeverage: r.u8() };
  const risk = readRisk(r);
  const lpCash = r.u64();
  const lpShareSupply = r.u64();
  const lpBalances = new Map<string, bigint>();
  for (let n = r.u32(); n > 0; n--) lpBalances.set(r.key().toBase58(), r.u64());
  const positions: LinearPosition[] = [];
  for (let n = r.u32(); n > 0; n--) {
    const id = r.u64();
    positions.push({ id, owner: r.key(), side: r.u8() === 0 ? 'long' : 'short', margin: r.u64(), notionalUsdMicros: r.u64(), entryPriceMicros: r.u64(), profitCap: r.u64(), fundingEntry: r.i128() });
  }
  const tail = {
    nextId: r.u64(), protocolFees: r.u64(), insuranceFees: r.u64(), holderFees: r.u64(),
    fundingIndex: r.i128(), fundingRate: r.i128(), fundingTime: r.i64(), fundingValidUntil: r.i64(), lastPublication: r.i64(),
  };
  const pool: PoolLink | null = r.u8() === 1 ? { pool: r.key(), member: r.u8() } : null;
  let wick: WickConfig | null = null;
  if (r.u8() === 1) {
    wick = { rate: r.u16(), maxLeverage: r.u8(), maxDurationSeconds: r.u32(), maxPositions: r.u8(), maxReserveBps: r.u16() };
    for (let n = r.u32(); n > 0; n--) {
      const id = r.u64();
      const terms: WickTerms = { openedAt: Number(r.i64()), expiresAt: Number(r.i64()), prepaid: r.u64(), rate: r.u16(), takeProfit: r.u8() === 1 };
      const p = positions.find((x) => x.id === id);
      if (!p) throw new Error('bad wick terms on a linear market ledger: no such position');
      p.wick = terms;
    }
  }
  const claims: LinearClaim[] = [];
  for (let n = r.u32(); n > 0; n--) {
    claims.push({ id: r.u64(), owner: r.key(), kind: r.u8() === 0 ? 'gain' : 'loss', amount: r.u64(), basis: r.u64(), reference: r.u64(), cum: r.u128(), cumAt: Number(r.i64()), dueAt: Number(r.i64()) });
  }
  const badDebt = { shortfall: r.u64(), covered: r.u64(), uncovered: r.u64() };
  const breakerUntil = Number(r.i64());
  let pendingRisk: LinearPendingRisk | null = null;
  if (r.u8() === 1) {
    const l = { maxNotionalUsdMicros: r.u64(), maxPositions: r.u16(), maxLeverage: r.u8() };
    pendingRisk = { limits: l, risk: readRisk(r), effectiveAt: Number(r.i64()) };
  }
  if (r.o !== ledgerEnd) throw new Error('bad v4 linear market ledger: length');
  return { limits, lpCash, lpShareSupply, lpBalances, positions, ...tail, pool, wick, risk, v4: true, claims, badDebt, breakerUntil, pendingRisk };
}
/** `FeedPrice` is 58 bytes; every post appends the replaced publication time (i64). */
const FEED_PRICE_STRUCT_LEN = 58;
/** `PriceState` (SOL) is 26 bytes; every post appends the replaced publication time (i64). */
const SOL_PRICE_STRUCT_LEN = 26;
const previousAt = (d: Uint8Array, at: number): number | null =>
  d.length >= at + 8 ? Number(new DataView(d.buffer, d.byteOffset + at, 8).getBigInt64(0, true)) : null;
const previousPrice = (d: Uint8Array, at: number): bigint | null =>
  d.length >= at + 8 ? new DataView(d.buffer, d.byteOffset + at, 8).getBigUint64(0, true) : null;
export function decodeFeedPrice(d: Uint8Array): FeedPriceState {
  expect(d, 'FeedPrice');
  const r = new Reader(d, 8);
  return {
    feed: r.feed(), priceUsdMicros: r.u64(), publishedAt: Number(r.i64()), signers: r.u8(),
    previousPublishedAt: previousAt(d, FEED_PRICE_STRUCT_LEN), previousPriceMicros: previousPrice(d, FEED_PRICE_STRUCT_LEN + 8),
  };
}
/** The SOL `PriceState` (`["price"]`): no feed id field. */
export function decodeSolPrice(d: Uint8Array): { priceUsdMicros: bigint; publishedAt: number; signers: number; previousPublishedAt: number | null; previousPriceMicros: bigint | null } {
  const r = new Reader(d, 8);
  return {
    priceUsdMicros: r.u64(), publishedAt: Number(r.i64()), signers: r.u8(), previousPublishedAt: previousAt(d, SOL_PRICE_STRUCT_LEN),
    previousPriceMicros: previousPrice(d, SOL_PRICE_STRUCT_LEN + 8),
  };
}
/**
 * The program's fill rule (`oracle::first_in_window`): an order created at
 * `createdAt` fills only on the FIRST price of each feed published in
 * `[createdAt + 2, createdAt + 32]`: a stored price in the window whose
 * replaced price was published before the window opened. Applies to the asset
 * price AND the settlement price (`PoolQuote.previousPublishedAt`).
 */
export function firstInWindow(
  publishedAt: number, previous: number | null | undefined, createdAt: number,
  window: { minFillDelaySeconds: number; maxFillDelaySeconds: number } = LINEAR_TERMS,
): boolean {
  const earliest = createdAt + window.minFillDelaySeconds;
  const latest = createdAt + window.maxFillDelaySeconds;
  return publishedAt >= earliest && publishedAt <= latest && previous !== null && previous !== undefined && previous < earliest;
}
/** A linear market's asset price, whichever layout its account has: `FeedPrice`, or the SOL `PriceState`. */
export function decodeMarketPrice(feed: string, d: Uint8Array): FeedPriceState {
  return feed === SOL_LINEAR_FEED ? { feed, ...decodeSolPrice(d) } : decodeFeedPrice(d);
}
function decodeAction(r: Reader): LinearAction {
  const tag = r.u8();
  if (tag === 0) return { kind: 'open', long: r.u8() === 1, collateral: r.u64(), notional: r.u64(), profitCap: r.u64() };
  if (tag === 1) return { kind: 'close', position: r.u64(), minimum: r.u64() };
  if (tag === 2) return { kind: 'deposit', amount: r.u64(), minimum: r.u64() };
  if (tag === 3) return { kind: 'withdraw', shares: r.u64(), minimum: r.u64() };
  if (tag === 4) {
    return { kind: 'openWick', long: r.u8() === 1, collateral: r.u64(), notional: r.u64(), profitCap: r.u64(), durationSeconds: r.u32(), takeProfit: r.u8() === 1 };
  }
  if (tag === 5) return { kind: 'closePart', position: r.u64(), minimum: r.u64(), notional: r.u64() };
  if (tag === 6) return { kind: 'removeMargin', position: r.u64(), amount: r.u64() };
  throw new Error(`unknown perps order action ${tag}`);
}
export function decodeLinearOrder(address: PublicKey, d: Uint8Array): LinearOrderState {
  expect(d, 'Order');
  const r = new Reader(d, 8);
  const market = r.key();
  const owner = r.key();
  const nonce = r.u64();
  const action = decodeAction(r);
  const createdAt = Number(r.i64());
  const createdSlot = r.u64();
  const deadline = Number(r.i64());
  const minPrice = r.u64();
  const maxPrice = r.u64();
  const active = r.u8() === 1;
  // v3 tail: version, then the referrer (zeros on an order written before referrals).
  const version = r.o < d.length ? r.u8() : 0;
  const referrer = version >= REFERRAL_TERMS.orderVersion && r.o + 32 <= d.length ? effectiveReferrer(r.key(), owner) : null;
  return { address, market, owner, nonce, action, createdAt, createdSlot, deadline, minPrice, maxPrice, active, version, referrer };
}
/** The `MarketPositionOpened` event (`settle_price` replaced the retired program's `sol_price`, same position). */
export interface MarketPositionOpenedEvent {
  market: PublicKey;
  owner: PublicKey;
  position: bigint;
  long: boolean;
  notional: bigint;
  profitCap: bigint;
  /** The asset price of the fill, USD micros. */
  price: bigint;
  /** The settlement TWAP at the fill, USD micros per million COOK (on the retired program: SOL/USD). */
  settlePrice: bigint;
}
/** Decode `MarketPositionOpened` from its event bytes (discriminator first, as in `Program data:` logs). */
export function decodeMarketPositionOpened(d: Uint8Array): MarketPositionOpenedEvent {
  expect(d, 'MarketPositionOpened');
  const r = new Reader(d, 8);
  return { market: r.key(), owner: r.key(), position: r.u64(), long: r.u8() === 1, notional: r.u64(), profitCap: r.u64(), price: r.u64(), settlePrice: r.u64() };
}

// --- quotes --------------------------------------------------------------------------

/**
 * One execution's prices on the bCOOK program, as `oracle::quote` builds it:
 * the asset, the settlement band in USD micros per MILLION COOK, and bCOOK's
 * gross rate (COOK base units per raw bCOOK, 1e9-scaled). `settleLo` already
 * carries the stake pool's withdrawal fee (`settlementBand`).
 */
export interface BcookQuote {
  assetMicros: bigint;
  settleTwap: bigint;
  settleLo: bigint;
  settleHi: bigint;
  rateE9: bigint;
  /** The settlement post's open-interest ceiling, USD micros: the settlement capacity's source. Unknown when absent. */
  oiCapUsdMicros?: bigint;
}
/** The retired aSOL program's quote: asset, SOL/USD, aSOL's rate (SOL per share, 1e9). */
export interface AsolV2Quote { assetMicros: bigint; solMicros: bigint; rateE9: bigint }
/** Either program's quote: the shape selects the arithmetic. */
export type LinearQuote = BcookQuote | AsolV2Quote;
export const isBcookQuote = (q: LinearQuote): q is BcookQuote => (q as BcookQuote).settleLo !== undefined;

/** bCOOK's rate as the program reads it from the stake pool (`oracle::share_rate`). */
export interface BcookRate {
  /** COOK base units per raw bCOOK, 1e9-scaled: total_lamports * 1e9 / pool_token_supply, floored. */
  grossE9: bigint;
  /** The larger of the stake and SOL withdrawal fees, bps rounded up. */
  withdrawalFeeBps: number;
  lastUpdateEpoch: bigint;
}
/**
 * bCOOK's rate from the stake pool account (its 611 bytes, or the decoded
 * `stakePool.ts` state), with the program's refusals: wrong pool or mint, not
 * classic SPL Token, a withdrawal fee above 10%, and (given `epoch`) a pool
 * not updated this epoch or the one before. Throws where the program would
 * refuse every fill.
 */
export function bcookRate(pool: Uint8Array | StakePoolState, epoch?: bigint | number): BcookRate {
  const s = pool instanceof Uint8Array ? decodeStakePool(PERPS_STAKE_POOL, pool, PERPS_STAKE_POOL_PROGRAM) : pool;
  if (!s.address.equals(PERPS_STAKE_POOL)) throw new Error('not bCOOK’s stake pool');
  if (!s.poolMint.equals(PERPS_BCOOK_MINT) || !s.tokenProgram.equals(TOKEN_PROGRAM_ID)) throw new Error('the stake pool does not issue classic-SPL bCOOK');
  if (s.poolTokenSupply === 0n) throw new Error('the stake pool has no supply');
  if (epoch !== undefined) {
    const now = BigInt(epoch);
    if (s.lastUpdateEpoch > now || now - s.lastUpdateEpoch > LINEAR_TERMS.maxRateEpochsOld) throw new Error(`the stake pool was last updated in epoch ${s.lastUpdateEpoch}: stale, fills halt`);
  }
  const fee = Math.max(stakePoolFeeBps(s.stakeWithdrawalFee), stakePoolFeeBps(s.solWithdrawalFee));
  if (fee > LINEAR_TERMS.maxWithdrawalFeeBps) throw new Error(`the stake pool's withdrawal fee is ${fee} bps: above 10%, fills halt`);
  return { grossE9: (s.totalLamports * SCALE) / s.poolTokenSupply, withdrawalFeeBps: fee, lastUpdateEpoch: s.lastUpdateEpoch };
}
/**
 * The settlement band of a post (`pool::band` + the fee fold of
 * `oracle::quote`): `lo = min(twap, spot_lo) * (10000 - fee) / 10000`,
 * `hi = max(twap, spot_hi)`. Throws above the 10% fee ceiling.
 */
export function settlementBand(q: Pick<PoolQuote, 'twapUsdMicros' | 'spotLoUsdMicros' | 'spotHiUsdMicros'>, withdrawalFeeBps: number): { twap: bigint; lo: bigint; hi: bigint } {
  if (withdrawalFeeBps < 0 || withdrawalFeeBps > LINEAR_TERMS.maxWithdrawalFeeBps) throw new Error(`withdrawal fee ${withdrawalFeeBps} bps: the program refuses the rate`);
  const lo = q.twapUsdMicros < q.spotLoUsdMicros ? q.twapUsdMicros : q.spotLoUsdMicros;
  const hi = q.twapUsdMicros > q.spotHiUsdMicros ? q.twapUsdMicros : q.spotHiUsdMicros;
  return { twap: q.twapUsdMicros, lo: (lo * (BPS - BigInt(withdrawalFeeBps))) / BPS, hi };
}
/**
 * Funding hint: the fewest native COOK lamports a `DepositSol` into the stake
 * pool needs to mint at least `bcookRaw` (its fee and rounding included,
 * `poolTokensForDeposit`). Pair with `stakeForBcookIxs`.
 */
export function cookForBcook(bcookRaw: bigint, pool: StakePoolState): bigint {
  if (bcookRaw <= 0n) return 0n;
  let high = (bcookRaw * pool.totalLamports) / pool.poolTokenSupply + 1n;
  for (let i = 0; poolTokensForDeposit(high, pool) < bcookRaw; i++) {
    if (i === 64) throw new Error('the stake pool mints nothing for a deposit');
    high *= 2n;
  }
  let low = 0n;
  while (high - low > 1n) {
    const mid = (low + high) / 2n;
    if (poolTokensForDeposit(mid, pool) >= bcookRaw) high = mid;
    else low = mid;
  }
  return high;
}
/**
 * Stake `lamports` of `owner`'s native COOK for bCOOK, straight into the
 * owner's classic bCOOK ATA (created first if missing): the way to fund
 * margin or an LP deposit. `pool` is `decodeStakePool(BCOOK_STAKE_POOL, data)`.
 */
export function stakeForBcookIxs(pool: StakePoolState, owner: PublicKey, lamports: bigint): TransactionInstruction[] {
  if (!pool.poolMint.equals(PERPS_BCOOK_MINT)) throw new Error('not bCOOK’s stake pool');
  return [
    createAssociatedTokenAccountIdempotentInstruction(owner, marketsBcookAccount(owner), owner, PERPS_BCOOK_MINT, TOKEN_PROGRAM_ID),
    depositSolIx({ pool, depositor: owner, lamports }),
  ];
}
/** The engine quote a fill would use: `assetMicros`, the settlement post and bCOOK's rate. */
export function bcookQuote(assetMicros: bigint, settle: PoolQuote, rate: Pick<BcookRate, 'grossE9' | 'withdrawalFeeBps'>): BcookQuote {
  const b = settlementBand(settle, rate.withdrawalFeeBps);
  return { assetMicros, settleTwap: b.twap, settleLo: b.lo, settleHi: b.hi, rateE9: rate.grossE9, oiCapUsdMicros: settle.oiCapUsdMicros };
}
/** `quote` with its whole band at one settlement price (marking one end alone). */
export const quoteAtSettle = (q: BcookQuote, settle: bigint): BcookQuote => ({ ...q, settleTwap: settle, settleLo: settle, settleHi: settle });

// --- arithmetic (mirrors perps-engine/src/linear.rs) ------------------------------

const ceilDiv = (n: bigint, d: bigint) => n / d + (n % d === 0n ? 0n : 1n);
/** Euclidean floor for a positive divisor, as Rust's `div_euclid`. */
const floorDiv = (n: bigint, d: bigint) => { const q = n / d; return n % d !== 0n && n < 0n ? q - 1n : q; };
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const i128 = (v: bigint) => (v > I128_MAX ? I128_MAX : v < I128_MIN ? I128_MIN : v);
const inI128 = (v: bigint) => v >= I128_MIN && v <= I128_MAX;

/** `Quote::usd_to_shares_ceil_at`: USD micros (`usdScaled / divisor`) to raw bCOOK at `settle`, rounded up. */
function usdToSharesCeilAt(usdScaled: bigint, divisor: bigint, settle: bigint, rateE9: bigint): bigint {
  return ceilDiv(ceilDiv(usdScaled * CONVERSION, divisor * settle), rateE9);
}
/** The retired program's conversion: USD micros to aSOL at the SOL price, rounded up. */
function asolUsdToSharesCeil(usd: bigint, divisor: bigint, q: AsolV2Quote): bigint {
  const lamports = ceilDiv(usd * SCALE, q.solMicros * divisor);
  return ceilDiv(lamports * SCALE, q.rateE9);
}
/** USD (`usdScaled / divisor`) to shares, rounded up, at the quote's charging end (bCOOK: the low end). */
function chargeShares(usdScaled: bigint, divisor: bigint, q: LinearQuote): bigint {
  return isBcookQuote(q) ? usdToSharesCeilAt(usdScaled, divisor, q.settleLo, q.rateE9) : asolUsdToSharesCeil(usdScaled, divisor, q);
}
/** Raw shares to USD micros at `settle`, rounded down. */
const sharesToUsdAt = (shares: bigint, settle: bigint, rateE9: bigint): bigint => (shares * rateE9 * settle) / CONVERSION;

/** The fee on a notional: 8 bps of its USD value, in shares at the band's low end, rounded up (`linear::fee`). */
export const linearFee = (notional: bigint, q: LinearQuote, feeBps: bigint = LINEAR_TERMS.feeBps): bigint => chargeShares(notional * feeBps, BPS, q);
/** Maintenance requirement: 10% of the notional's USD value, in shares at the band's low end, rounded up. */
export const linearMaintenance = (notional: bigint, q: LinearQuote, maintenanceBps: bigint = LINEAR_TERMS.maintenanceBps): bigint => chargeShares(notional * maintenanceBps, BPS, q);
/** The margin's USD buying power, rounded down: at the band's low end (`Quote::shares_to_usd_floor`). */
export const marginUsdMicros = (margin: bigint, q: LinearQuote): bigint =>
  isBcookQuote(q) ? sharesToUsdAt(margin, q.settleLo, q.rateE9) : ((margin * q.rateE9) / SCALE) * q.solMicros / SCALE;
/**
 * Raw bCOOK valued in USD micros at the settlement TWAP, for display only
 * (balances, PnL, LP value): the program never converts at the TWAP except
 * for funding. Rounded down.
 */
export const bcookUsdValue = (raw: bigint, q: Pick<BcookQuote, 'settleTwap' | 'rateE9'>): bigint => sharesToUsdAt(raw, q.settleTwap, q.rateE9);
/** USD micros as raw bCOOK at the TWAP, rounded up (display, sizing). */
export const usdToBcook = (usdMicros: bigint, q: Pick<BcookQuote, 'settleTwap' | 'rateE9'>): bigint => usdToSharesCeilAt(usdMicros, 1n, q.settleTwap, q.rateE9);

export function linearFundingIndex(l: LinearLedger, now: bigint): bigint {
  const end = now < l.fundingValidUntil ? now : l.fundingValidUntil;
  const seconds = end > l.fundingTime ? end - l.fundingTime : 0n;
  return l.fundingIndex + l.fundingRate * seconds;
}
/**
 * The funding rate a market schedules at `q` (`LinearMarket::schedule`):
 * skew / total x 1 bp of notional per hour, in raw bCOOK per USD micro of
 * notional per second (FUNDING_SCALE-scaled), converted at the settlement
 * TWAP: one rate both sides pay or earn.
 */
export function linearFundingRate(positions: readonly Pick<LinearPosition, 'side' | 'notionalUsdMicros'>[], q: Pick<BcookQuote, 'settleTwap' | 'rateE9'>): bigint {
  let long = 0n;
  let short = 0n;
  for (const p of positions) {
    if (p.side === 'long') long += p.notionalUsdMicros;
    else short += p.notionalUsdMicros;
  }
  const total = long + short;
  if (total === 0n) return 0n;
  const unit = (FUNDING_SCALE * CONVERSION) / (q.settleTwap * q.rateE9 * 10_000n * 3_600n);
  return (unit * (long - short)) / total;
}

/** What a mark needs of a market's risk settings (`linear::MarkRules`). */
export interface MarkRules { feeBps: number; maintenanceBps: number; liquidateBankrupt: boolean }
/** v2/v3's marking: 8 bp fee, 10% maintenance, both ends only. */
export const LEGACY_RULES: MarkRules = Object.freeze({ feeBps: 8, maintenanceBps: 1000, liquidateBankrupt: false });
export const riskRules = (r: Pick<LinearRisk, 'feeBps' | 'maintenanceBps' | 'liquidateBankrupt'>): MarkRules => ({ feeBps: r.feeBps, maintenanceBps: r.maintenanceBps, liquidateBankrupt: r.liquidateBankrupt });

export interface LinearMark {
  /** Signed raw shares, clamped to [-margin, profitCap]: on bCOOK the smaller of the PnL at either end. */
  pnl: bigint;
  /**
   * Bad debt: how far the unclamped loss (price and funding) exceeds the margin,
   * raw bCOOK, at the band end better for the trader. The insurance fund pays it
   * before the LPs.
   */
  shortfall: bigint;
  closingFee: bigint;
  payable: bigint;
  maintenance: bigint;
  /** bCOOK: liquidatable at BOTH ends of the band, each a single consistent price. */
  liquidatable: boolean;
  profitCapReached: boolean;
}

/** `funding_shares`: funding owed to (+) or by the position, saturating far beyond any clamp. */
function fundingShares(p: Pick<LinearPosition, 'side' | 'notionalUsdMicros' | 'fundingEntry'>, fundingIndex: bigint): bigint {
  const dir = p.side === 'long' ? 1n : -1n;
  const saturated = () => -dir * (fundingIndex >= p.fundingEntry ? 1n : -1n) * SATURATED;
  const a = fundingIndex - p.fundingEntry;
  if (!inI128(a)) return saturated();
  const b = a * p.notionalUsdMicros;
  if (!inI128(b)) return saturated();
  const c = b * -dir;
  if (!inI128(c)) return saturated();
  return floorDiv(c, FUNDING_SCALE);
}
/** `signed_floor`: `numerator * 1e24 / (d1 * d2)`, gains floored, losses away from zero, saturating. */
function signedFloor(numerator: bigint, d1: bigint, d2: bigint): bigint {
  const n = numerator < 0n ? -numerator : numerator;
  if (d1 === 0n) return numerator >= 0n ? SATURATED : -SATURATED;
  const q1 = (n * CONVERSION) / d1;
  if (q1 >= U128_LIMIT) return numerator >= 0n ? SATURATED : -SATURATED;
  if (numerator >= 0n) return min(q1 / d2, SATURATED);
  const c1 = q1 + ((n * CONVERSION) % d1 !== 0n ? 1n : 0n);
  return -min(ceilDiv(c1, d2), SATURATED);
}
/** `pnl_at`: (raw, clamped) PnL of `p` at one settlement price. */
function pnlAt(p: LinearPosition, q: BcookQuote, settle: bigint, funding: bigint): [bigint, bigint] {
  const dir = p.side === 'long' ? 1n : -1n;
  const numerator = p.notionalUsdMicros * (q.assetMicros - p.entryPriceMicros) * dir;
  const raw = i128(signedFloor(numerator, p.entryPriceMicros * settle, q.rateE9) + funding);
  const clamped = raw < -p.margin ? -p.margin : raw > p.profitCap ? p.profitCap : raw;
  return [raw, clamped];
}
function markSingle(p: LinearPosition, q: BcookQuote, settle: bigint, funding: bigint, rules: MarkRules): LinearMark {
  const [raw, pnl] = pnlAt(p, q, settle, funding);
  const equity = p.margin + pnl;
  const fee = usdToSharesCeilAt(p.notionalUsdMicros * BigInt(rules.feeBps), BPS, settle, q.rateE9);
  const closingFee = min(fee, equity);
  const maintenance = usdToSharesCeilAt(p.notionalUsdMicros * BigInt(rules.maintenanceBps), BPS, settle, q.rateE9);
  const payable = equity - closingFee;
  const gap = -(p.margin + raw);
  return { pnl, shortfall: gap > 0n ? gap : 0n, closingFee, payable, maintenance, liquidatable: payable <= maintenance, profitCapReached: raw >= p.profitCap };
}
/**
 * `linear::mark_with` on the bCOOK band: PnL the smaller of both ends, fee and
 * maintenance at the low end, liquidatable at both ends, or (with the market's
 * bankruptcy rule) when nothing is left to pay out at the low end.
 */
function bcookMark(p: LinearPosition, q: BcookQuote, fundingIndex: bigint, rules: MarkRules): LinearMark {
  const funding = fundingShares(p, fundingIndex);
  const lo = markSingle(p, q, q.settleLo, funding, rules);
  const bankrupt = rules.liquidateBankrupt && lo.payable === 0n;
  if (q.settleLo === q.settleHi) return { ...lo, liquidatable: lo.liquidatable || bankrupt };
  const hi = markSingle(p, q, q.settleHi, funding, rules);
  const [rawLo] = pnlAt(p, q, q.settleLo, funding);
  const [rawHi] = pnlAt(p, q, q.settleHi, funding);
  const pnl = min(lo.pnl, hi.pnl);
  const equity = p.margin + pnl;
  const closingFee = min(linearFee(p.notionalUsdMicros, q, BigInt(rules.feeBps)), equity);
  return {
    pnl, shortfall: min(lo.shortfall, hi.shortfall), closingFee, payable: equity - closingFee, maintenance: lo.maintenance,
    liquidatable: (lo.liquidatable && hi.liquidatable) || bankrupt, profitCapReached: min(rawLo, rawHi) >= p.profitCap,
  };
}
/** The retired program's mark: PnL_usd = N (P/E - 1) dir, converted at its single SOL price and rate. */
function asolMark(p: LinearPosition, q: AsolV2Quote, fundingIndex: bigint): LinearMark {
  const direction = p.side === 'long' ? 1n : -1n;
  const numerator = p.notionalUsdMicros * (q.assetMicros - p.entryPriceMicros) * direction * SCALE * SCALE;
  const denominator = p.entryPriceMicros * q.solMicros * q.rateE9;
  const funding = (fundingIndex - p.fundingEntry) * p.notionalUsdMicros * -direction;
  const raw = floorDiv(numerator, denominator) + floorDiv(funding, FUNDING_SCALE);
  const pnl = raw < -p.margin ? -p.margin : raw > p.profitCap ? p.profitCap : raw;
  const equity = p.margin + pnl;
  const fee = linearFee(p.notionalUsdMicros, q);
  const closingFee = fee < equity ? fee : equity;
  const maintenance = linearMaintenance(p.notionalUsdMicros, q);
  const payable = equity - closingFee;
  return { pnl, shortfall: 0n, closingFee, payable, maintenance, liquidatable: payable <= maintenance, profitCapReached: raw >= p.profitCap };
}
/**
 * A position marked at `q` with funding to `fundingIndex` (`linear::mark_with`)
 * under a market's rules (`riskRules(ledger.risk)`; default: v3's).
 */
export function linearMark(p: LinearPosition, q: LinearQuote, fundingIndex: bigint, rules: MarkRules = LEGACY_RULES): LinearMark {
  return isBcookQuote(q) ? bcookMark(p, q, fundingIndex, rules) : asolMark(p, q, fundingIndex);
}
/** Which band end an LP NAV takes: a deposit's (NAV high, fewer new shares) or a withdrawal's (NAV low). */
export type NavSide = 'deposit' | 'withdraw';
/** `linear::nav_pnl`: a position's clamped PnL at its worst end for the trader (deposit) or its best (withdraw). */
export function linearNavPnl(p: LinearPosition, q: LinearQuote, fundingIndex: bigint, side: NavSide = 'withdraw'): bigint {
  if (!isBcookQuote(q)) return asolMark(p, q, fundingIndex).pnl;
  const funding = fundingShares(p, fundingIndex);
  const [, lo] = pnlAt(p, q, q.settleLo, funding);
  const [, hi] = pnlAt(p, q, q.settleHi, funding);
  return side === 'deposit' ? min(lo, hi) : max(lo, hi);
}

/**
 * Asset price at which a position becomes liquidatable at today's band and
 * rate, ignoring funding. On bCOOK the position must be liquidatable at both
 * ends; the high end values the margin highest, so that is where it is
 * reached. Null when it never is. A falling COOK price moves it closer.
 */
export function linearLiquidationPrice(p: Pick<LinearPosition, 'side' | 'margin' | 'notionalUsdMicros' | 'entryPriceMicros'>, q: LinearQuote, rules: MarkRules = LEGACY_RULES): number | null {
  const marginUsd = Number(isBcookQuote(q) ? sharesToUsdAt(p.margin, q.settleHi, q.rateE9) : marginUsdMicros(p.margin, q)) / 1e6;
  const notional = Number(p.notionalUsdMicros) / 1e6;
  const entry = Number(p.entryPriceMicros) / 1e6;
  // margin + N(P/E - 1)dir - fee N <= maintenance N
  const need = notional * (rules.maintenanceBps / 10_000 + rules.feeBps / 10_000) - marginUsd;
  if (p.side === 'long') { const price = entry * (1 + need / notional); return price > 0 ? price : null; }
  const price = entry * (1 - need / notional);
  return price > 0 ? price : null;
}

/**
 * How far COOK (the settlement price) must fall, with the asset flat, before the
 * position is liquidatable: the margin is bCOOK, so its dollar value falls with
 * COOK. Measured from the band's high end (a liquidation needs both ends, and
 * the TWAP follows a crash slowly): 0.25 means "COOK down 25%". 0 when it
 * already is; null for a retired-program quote or a position with no margin.
 * (Unrealized PnL and funding are ignored; with the market's bankruptcy rule a
 * fall past this liquidates faster.)
 */
export function cookDropToLiquidate(p: Pick<LinearPosition, 'margin' | 'notionalUsdMicros'>, q: LinearQuote, rules: MarkRules = LEGACY_RULES): number | null {
  if (!isBcookQuote(q) || p.margin <= 0n) return null;
  // Liquidatable when margin * rate * S / CONVERSION <= notional * (maintenance + fee) / 1e4.
  const needUsd = (p.notionalUsdMicros * BigInt(rules.maintenanceBps + rules.feeBps)) / BPS;
  const settleStar = (needUsd * CONVERSION) / (p.margin * q.rateE9);
  if (settleStar >= q.settleHi) return 0;
  return Number(q.settleHi - settleStar) / Number(q.settleHi);
}

/** The parts of a shared LP pool a member's capacity depends on (`LpPoolState` fits). */
export interface PoolBacking {
  lpCash: bigint;
  members: ReadonlyArray<{ reserved: bigint; maxReserveBps: number }>;
}
/** The pool's cash not reserved for any member's positions' maximum wins. */
export function poolFreeCash(pool: PoolBacking): bigint {
  const reserved = pool.members.reduce((sum, m) => sum + m.reserved, 0n);
  return pool.lpCash > reserved ? pool.lpCash - reserved : 0n;
}
/** The most member `i` may have reserved at the pool's cash now: its share, `lpCash * bps / 10,000`. */
export function poolMemberLimit(pool: PoolBacking, i: number): bigint {
  const m = pool.members[i];
  return m ? (pool.lpCash * BigInt(m.maxReserveBps)) / BPS : 0n;
}
/** Profit cap member `i` can still reserve: the pool's free cash, within the member's share (`LpPool::check_reserve`). */
export function poolMemberCapacity(pool: PoolBacking, i: number): bigint {
  const m = pool.members[i];
  if (!m) return 0n;
  const limit = poolMemberLimit(pool, i);
  const room = limit > m.reserved ? limit - m.reserved : 0n;
  const free = poolFreeCash(pool);
  return room < free ? room : free;
}
/**
 * Capital free to back a new position's maximum win. An isolated market: its
 * LP cash minus its open caps. A pool member: its capacity in the pool; 0
 * when the pool is not given.
 */
export function linearFreeCash(l: LinearLedger, pool?: PoolBacking | null): bigint {
  if (l.pool) return pool ? poolMemberCapacity(pool, l.pool.member) : 0n;
  const reserved = l.positions.reduce((sum, p) => sum + p.profitCap, 0n);
  return l.lpCash > reserved ? l.lpCash - reserved : 0n;
}

// --- settlement capacity (docs/BCOOK_SETTLEMENT.md section 4) --------------------------

/**
 * `pool::settle_capacity`: the most a book (the shared pool, or an isolated
 * market such as COOK-PERP) may have reserved in caps, in raw bCOOK: the
 * post's open-interest ceiling converted at the band's HIGH end, floored,
 * saturating at u64. An open whose book would reserve more is refused
 * (`Market`).
 */
export function settleCapacity(q: { oiCapUsdMicros: bigint; settleHi: bigint; rateE9: bigint }): bigint {
  const shares = (q.oiCapUsdMicros * CONVERSION) / (q.settleHi * q.rateE9);
  return shares > U64_MAX ? U64_MAX : shares;
}
/** The caps a market's book has reserved: the whole pool's (every member) for a member, its own for an isolated market. */
export function bookReserved(market: Pick<LinearMarketState, 'ledger'>, pool?: PoolBacking | null): bigint {
  if (market.ledger.pool) return pool ? pool.members.reduce((sum, m) => sum + m.reserved, 0n) : 0n;
  return market.ledger.positions.reduce((sum, p) => sum + p.profitCap, 0n);
}
/**
 * The largest profit cap the remaining settlement capacity allows a new
 * position in `market` (raw bCOOK): capacity at the band's high end raised by
 * `bufferBps` (the fill's post can sit higher) minus what the book has
 * reserved. Null when the quote carries no `oiCapUsdMicros`. The ticket must
 * offer this cap, never assume the margin: at launch a $20 position's margin
 * is above the whole capacity.
 */
export function maxCapThatFits(market: Pick<LinearMarketState, 'ledger'>, q: BcookQuote, pool?: PoolBacking | null, bufferBps = LINEAR_SETTLE_BUFFER_BPS): bigint | null {
  if (q.oiCapUsdMicros === undefined) return null;
  const capacity = settleCapacity({ oiCapUsdMicros: q.oiCapUsdMicros, settleHi: (q.settleHi * (BPS + bufferBps)) / BPS, rateE9: q.rateE9 });
  const reserved = bookReserved(market, pool);
  return capacity > reserved ? capacity - reserved : 0n;
}

// --- opens ---------------------------------------------------------------------------

/**
 * `LinearMarket::open_terms_with` exactly: the opening fee (at the band's low
 * end), the margin (collateral less the fee and any prepaid wick fee), and the
 * reserved cap (at most the margin and twice the notional's value at the
 * band's HIGH end); refused when the margin's USD value at the low end times
 * `leverage` does not cover the notional (`InsufficientCapital`). The
 * settlement-capacity and free-cash checks come after (`settleCapacity`).
 */
export function linearOpenTerms(
  request: { collateral: bigint; notional: bigint; profitCap: bigint },
  q: BcookQuote,
  leverage: number,
  prepaid = 0n,
): { openingFee: bigint; margin: bigint; profitCap: bigint } | { error: 'InvalidAmount' | 'InsufficientCapital' } {
  const openingFee = linearFee(request.notional, q);
  const margin = request.collateral - openingFee - prepaid;
  if (request.collateral <= 0n || request.notional <= 0n || request.profitCap <= 0n || margin <= 0n) return { error: 'InvalidAmount' };
  const bound = 2n * usdToSharesCeilAt(request.notional, 1n, q.settleHi, q.rateE9);
  const profitCap = min(min(request.profitCap, margin), bound);
  if (profitCap <= 0n) return { error: 'InvalidAmount' };
  if (request.notional > marginUsdMicros(margin, q) * BigInt(leverage)) return { error: 'InsufficientCapital' };
  return { openingFee, margin, profitCap };
}

export interface LinearOpenQuote {
  /** Raw bCOOK to escrow: margin plus the opening fee. */
  collateral: bigint;
  margin: bigint;
  openingFee: bigint;
  notional: bigint;
  /** The cap to request: min(margin, 2x the notional's value, LP free cash, remaining settlement capacity). */
  profitCap: bigint;
  /** The settlement capacity left for this cap (null: unknown, the quote had no `oiCapUsdMicros`). */
  capacity: bigint | null;
  liquidationPrice: number | null;
  /** How far COOK must fall (0.25: down 25%), the asset flat, before this position is liquidatable; null on the retired program. */
  cookDrop: number | null;
  /** The most leverage a position of this size may use now (its tier, the breaker's cap while it is on). */
  maxLeverage: number;
  problem: string | null;
}
/**
 * How far an open is sized beyond the quote: the low end lowered (fees and
 * buying power need more bCOOK) and the high end raised (capacity and the cap
 * bound shrink) by this much, for the fill's post landing elsewhere in the
 * band. The TWAP moves at most 1% per 120 s sample.
 */
export const LINEAR_SETTLE_BUFFER_BPS = 100n;
/** @deprecated the retired program's name for `LINEAR_SETTLE_BUFFER_BPS`. */
export const LINEAR_SOL_BUFFER_BPS = LINEAR_SETTLE_BUFFER_BPS;

/** The quote an order is sized at: the low end lowered, the high end raised by `bps`. */
function sizedQuote<Q extends LinearQuote>(q: Q, bps = LINEAR_SETTLE_BUFFER_BPS): Q {
  if (!isBcookQuote(q)) return { ...q, solMicros: (q.solMicros * (BPS - bps)) / BPS };
  return { ...q, settleLo: (q.settleLo * (BPS - bps)) / BPS, settleHi: (q.settleHi * (BPS + bps)) / BPS };
}
/** Margin whose USD value at the sized quote, times `lev`, covers `notional`, plus slack. */
function marginFor(notional: bigint, lev: bigint, sized: LinearQuote, q: LinearQuote): bigint {
  const marginUsd = ceilDiv(notional, lev);
  if (isBcookQuote(sized)) return ceilDiv(marginUsd * CONVERSION, sized.settleLo * sized.rateE9) + 2n;
  return ceilDiv(ceilDiv(marginUsd * SCALE, (sized as AsolV2Quote).solMicros) * SCALE, q.rateE9) + 2n;
}
/** Twice the notional's value in shares: at the (sized) high end on bCOOK. */
function capBound(notional: bigint, sized: LinearQuote, q: LinearQuote): bigint {
  return isBcookQuote(sized) ? 2n * usdToSharesCeilAt(notional, 1n, sized.settleHi, sized.rateE9) : 2n * asolUsdToSharesCeil(notional, 1n, q as AsolV2Quote);
}

/**
 * Size an order at `leverage` on the current quote, against `owner`'s open
 * positions. A pool member's cap comes from `pool` (the shared LP pool's
 * state, with its `paused` flag); without it a member has nothing to back a
 * position. On bCOOK the cap is also held within the remaining settlement
 * capacity (`maxCapThatFits`) when the quote carries `oiCapUsdMicros`.
 */
export function linearOpenQuote(
  market: LinearMarketState,
  owner: PublicKey | null,
  side: LinearSide,
  notionalUsdMicros: bigint,
  leverage: number,
  q: LinearQuote,
  pool?: (PoolBacking & { paused?: boolean }) | null,
  /** The volatility breaker is on (see `breakerActive`): opens above the market's breaker leverage are refused. */
  breakerOn = false,
): LinearOpenQuote {
  const risk = market.ledger.risk;
  // The position's tier (its size lowers the leverage) within the market's limit, and the breaker's cap while it is on.
  const tier = leverageForNotional(market.ledger.limits, risk, notionalUsdMicros);
  const allowed = Math.min(LINEAR_TERMS.hardMaxLeverage, tier ?? 1, breakerOn ? risk.breakerMaxLeverage : LINEAR_TERMS.hardMaxLeverage);
  const maxLev = Math.min(LINEAR_TERMS.hardMaxLeverage, market.ledger.limits.maxLeverage);
  const lev = BigInt(Math.max(1, Math.min(maxLev, Math.floor(leverage))));
  const sized = sizedQuote(q);
  const openingFee = linearFee(notionalUsdMicros, sized, BigInt(risk.feeBps));
  const margin = marginFor(notionalUsdMicros, lev, sized, q);
  const collateral = margin + openingFee;
  const bound = capBound(notionalUsdMicros, sized, q);
  const free = linearFreeCash(market.ledger, pool);
  const capacity = isBcookQuote(q) ? maxCapThatFits(market, q, pool) : null;
  let profitCap = margin < bound ? margin : bound;
  if (free < profitCap) profitCap = free;
  if (capacity !== null && capacity < profitCap) profitCap = capacity;
  const mine = owner ? market.ledger.positions.filter((p) => p.owner.equals(owner)).length : 0;
  let problem: string | null = null;
  if (market.paused) problem = 'This market is paused.';
  else if (tier === null) problem = `This market has no leverage tier above $${(Number(risk.tiers.at(-1)?.maxNotionalUsdMicros ?? 0n) / 1e6).toLocaleString('en-US')}.`;
  else if (Number(lev) > allowed) {
    problem = breakerOn && allowed === risk.breakerMaxLeverage && allowed < (tier ?? 1)
      ? `After a sharp move this market allows up to ${allowed}x for a few minutes.`
      : `A position this size can use up to ${allowed}x here; larger positions get a lower maximum.`;
  } else if (market.ledger.pool && pool?.paused) problem = 'The shared LP pool is paused: no new positions for now.';
  else if (notionalUsdMicros < LINEAR_TERMS.minNotionalUsdMicros) problem = 'The smallest position is $10.';
  else if (notionalUsdMicros > market.ledger.limits.maxNotionalUsdMicros) problem = `This market caps a position at $${(Number(market.ledger.limits.maxNotionalUsdMicros) / 1e6).toLocaleString('en-US')}.`;
  else if (mine >= LINEAR_TERMS.maxPositionsPerOwner) problem = `A wallet can hold ${LINEAR_TERMS.maxPositionsPerOwner} open positions in this market. Close one first.`;
  else if (market.ledger.positions.length >= market.ledger.limits.maxPositions) problem = 'Every position slot is taken. Try again after one closes.';
  else if (free === 0n) {
    problem = market.ledger.pool
      ? 'The shared LP pool has no free capital for this market to back a new position.'
      : 'The LP vault has no free capital to back a new position.';
  } else if (capacity === 0n) problem = 'The settlement capacity is used up: COOK’s pools are too thin for another position until one closes.';
  else if (profitCap === 0n) problem = 'The LP vault has no free capital to back a new position.';
  const rules = riskRules(risk);
  const liquidationPrice = linearLiquidationPrice({ side, margin, notionalUsdMicros, entryPriceMicros: q.assetMicros }, q, rules);
  const cookDrop = cookDropToLiquidate({ margin, notionalUsdMicros }, q, rules);
  return { collateral, margin, openingFee, notional: notionalUsdMicros, profitCap, capacity, liquidationPrice, cookDrop, maxLeverage: allowed, problem };
}

// --- wick-proof positions (docs/WICK_PROOF_PERPS.md) -------------------------------------

/**
 * Wick-proof mode: on shared-pool members only (BTC, ETH, HYPE, linear SOL;
 * never COOK-PERP). No liquidation; a duration with settlement at expiry; the
 * wick fee for all of it prepaid, the unused part refunded on an early close.
 * On the bCOOK program it launches PAUSED (`maxPositions: 0`).
 */
export const WICK_TERMS = Object.freeze({
  /** Program hard bounds (`set_wick_config`). */
  hardMaxLeverage: 5,
  minDurationSeconds: 3_600,
  maxDurationSeconds: 7 * 86_400,
  minRate: 10,
  maxRate: 2_000,
  hardMaxPositions: 16,
  /** The durations the app offers. */
  durations: [
    { seconds: 3_600, label: '1h' },
    { seconds: 4 * 3_600, label: '4h' },
    { seconds: 86_400, label: '1d' },
    { seconds: 3 * 86_400, label: '3d' },
    { seconds: 7 * 86_400, label: '7d' },
  ] as const,
  /** Target (max win) choices, % of margin. */
  targets: [10, 25, 50, 100] as const,
  /** An expiry settles on the first prices published at least 2 s after it. */
  settleDelaySeconds: 2,
  /** The earned wick fee: 80% to the shared pool, 20% to the protocol. */
  feeSplitBps: { lp: 8000, protocol: 2000 },
});
/** The wick fee rate as bp of notional per hour (180 → 1.8). */
export const wickRateBpPerHour = (rate: number): number => rate / 100;
/** The wick fee for `notional` held `seconds` at `rate`, in shares at the band's low end, rounded up (`linear::wick_fee`). */
export const wickFee = (notional: bigint, rate: number, seconds: number, q: LinearQuote): bigint =>
  chargeShares(notional * BigInt(rate) * BigInt(seconds), 1_000_000n * 3600n, q);
/** (earned, refund) of a wick-proof position's prepaid fee at `at` (`WickTerms::split`). */
export function wickSplit(t: WickTerms, at: number): { earned: bigint; refund: bigint } {
  const duration = BigInt(t.expiresAt - t.openedAt);
  if (duration <= 0n) return { earned: t.prepaid, refund: 0n };
  const clamped = Math.min(Math.max(at, t.openedAt), t.expiresAt) - t.openedAt;
  let earned = ceilDiv(t.prepaid * BigInt(clamped), duration);
  if (earned > t.prepaid) earned = t.prepaid;
  return { earned, refund: t.prepaid - earned };
}
/** The earned fee's split: 20% protocol (rounded down), the rest to the pool. */
export const wickFeeSplit = (earned: bigint): { protocol: bigint; lp: bigint } => ({ protocol: earned / 5n, lp: earned - earned / 5n });
/** Whether the market offers wick-proof positions now (terms set, slots left, a pool member, not pool-priced). */
export const wickOffered = (m: LinearMarketState): boolean =>
  !!m.ledger.wick && !!m.ledger.pool && !isPoolFeed(m.feed) && m.ledger.wick.maxPositions > 0;

/**
 * Asset price where a position's PnL reaches `pnlShares` (its cap, or
 * `-margin` for zero) at today's band, ignoring funding: a gain converts at
 * the high end, a loss at the low end. Null when unreachable.
 */
export function linearPriceForPnl(p: Pick<LinearPosition, 'side' | 'notionalUsdMicros' | 'entryPriceMicros'>, pnlShares: bigint, q: LinearQuote): number | null {
  const abs = pnlShares < 0n ? -pnlShares : pnlShares;
  const usd = isBcookQuote(q) ? sharesToUsdAt(abs, pnlShares < 0n ? q.settleLo : q.settleHi, q.rateE9) : marginUsdMicros(abs, q);
  const pnlUsd = (Number(usd) / 1e6) * (pnlShares < 0n ? -1 : 1);
  const notional = Number(p.notionalUsdMicros) / 1e6;
  const entry = Number(p.entryPriceMicros) / 1e6;
  const move = pnlUsd / notional;
  const price = p.side === 'long' ? entry * (1 + move) : entry * (1 - move);
  return price > 0 ? price : null;
}

export interface WickOpenQuote {
  /** Raw bCOOK to escrow: the whole stake, and the most the trader can lose. */
  collateral: bigint;
  margin: bigint;
  openingFee: bigint;
  /** The wick fee for the whole duration, refunded pro rata on an early close. */
  prepaid: bigint;
  notional: bigint;
  /** The most the position can win (the reserved cap). */
  profitCap: bigint;
  durationSeconds: number;
  rate: number;
  /** Asset price where the max win is reached, and where the value is zero. */
  capPrice: number | null;
  zeroPrice: number | null;
  problem: string | null;
}
/**
 * Size a wick-proof order: `leverage` (up to the market's wick maximum, 5x)
 * on the margin left after the opening fee AND the prepaid wick fee, a target
 * of `targetPct` of that margin, for `durationSeconds`. Sized as
 * `linearOpenQuote`, within the remaining settlement capacity.
 */
export function wickOpenQuote(
  market: LinearMarketState,
  owner: PublicKey | null,
  side: LinearSide,
  notionalUsdMicros: bigint,
  leverage: number,
  targetPct: number,
  durationSeconds: number,
  q: LinearQuote,
  pool?: (PoolBacking & { paused?: boolean }) | null,
): WickOpenQuote {
  const config = market.ledger.wick ?? null;
  const rate = config?.rate ?? 0;
  const maxLev = Math.min(WICK_TERMS.hardMaxLeverage, config?.maxLeverage ?? 1);
  const lev = BigInt(Math.max(1, Math.min(maxLev, Math.floor(leverage))));
  const sized = sizedQuote(q);
  const openingFee = linearFee(notionalUsdMicros, sized);
  const prepaid = config ? wickFee(notionalUsdMicros, rate, durationSeconds, sized) : 0n;
  const margin = marginFor(notionalUsdMicros, lev, sized, q);
  const collateral = margin + openingFee + prepaid;
  const target = (margin * BigInt(Math.max(1, Math.min(100, Math.floor(targetPct))))) / 100n;
  const bound = capBound(notionalUsdMicros, sized, q);
  let profitCap = target < bound ? target : bound;
  // A member's wick-proof caps are held within their share of its pool limit.
  const free = linearFreeCash(market.ledger, pool);
  let wickRoom = free;
  if (pool && market.ledger.pool && config) {
    const limit = (poolMemberLimit(pool, market.ledger.pool.member) * BigInt(config.maxReserveBps)) / BPS;
    const used = market.ledger.positions.filter((p) => p.wick).reduce((s, p) => s + p.profitCap, 0n);
    wickRoom = limit > used ? limit - used : 0n;
  }
  const capacity = isBcookQuote(q) ? maxCapThatFits(market, q, pool) : null;
  let room = free < wickRoom ? free : wickRoom;
  if (capacity !== null && capacity < room) room = capacity;
  if (room < profitCap) profitCap = room;
  const mine = owner ? market.ledger.positions.filter((p) => p.owner.equals(owner)).length : 0;
  const open = market.ledger.positions.filter((p) => p.wick).length;
  let problem: string | null = null;
  if (!config || !market.ledger.pool || isPoolFeed(market.feed)) problem = 'Wick-proof positions are not offered on this market.';
  else if (config.maxPositions === 0) problem = 'New wick-proof positions are paused on this market.';
  else if (market.paused) problem = 'This market is paused.';
  else if (pool?.paused) problem = 'The shared LP pool is paused: no new positions for now.';
  else if (durationSeconds < WICK_TERMS.minDurationSeconds || durationSeconds > Math.min(config.maxDurationSeconds, WICK_TERMS.maxDurationSeconds)) problem = 'Choose a duration this market offers.';
  else if (notionalUsdMicros < LINEAR_TERMS.minNotionalUsdMicros) problem = 'The smallest position is $10.';
  else if (notionalUsdMicros > market.ledger.limits.maxNotionalUsdMicros) problem = `This market caps a position at $${(Number(market.ledger.limits.maxNotionalUsdMicros) / 1e6).toLocaleString('en-US')}.`;
  else if (mine >= LINEAR_TERMS.maxPositionsPerOwner) problem = `A wallet can hold ${LINEAR_TERMS.maxPositionsPerOwner} open positions in this market. Close one first.`;
  else if (market.ledger.positions.length >= market.ledger.limits.maxPositions) problem = 'Every position slot is taken. Try again after one closes.';
  else if (open >= Math.min(config.maxPositions, WICK_TERMS.hardMaxPositions)) problem = 'Every wick-proof slot in this market is taken. Try again after one closes.';
  else if (capacity === 0n) problem = 'The settlement capacity is used up: COOK’s pools are too thin for another position until one closes.';
  else if (profitCap === 0n) problem = 'Needs liquidity: the shared LP pool has no free capital for this market to back a new wick-proof position.';
  const entry = { side, notionalUsdMicros, entryPriceMicros: q.assetMicros };
  const capPrice = profitCap > 0n ? linearPriceForPnl(entry, profitCap, q) : null;
  const zeroPrice = linearPriceForPnl(entry, -margin, q);
  return { collateral, margin, openingFee, prepaid, notional: notionalUsdMicros, profitCap, durationSeconds, rate, capPrice, zeroPrice, problem };
}

/** What closing a wick-proof position now would pay: its value plus the unused wick fee. */
export function wickCloseValue(p: LinearPosition, q: LinearQuote, fundingIndex: bigint, now: number): { payable: bigint; refund: bigint; earned: bigint; total: bigint } {
  const mark = linearMark(p, q, fundingIndex);
  const { earned, refund } = p.wick ? wickSplit(p.wick, now) : { earned: 0n, refund: 0n };
  return { payable: mark.payable, refund, earned, total: mark.payable + refund };
}

// --- partial closes (docs/PARTIAL_CLOSE.md) ------------------------------------------------

/** The quick picks the app offers, % of the position's notional. */
export const PARTIAL_CLOSE_PRESETS = [25, 50, 75, 100] as const;

/**
 * `linear::split_position`: `notional` (USD micros) of `p` closes, the rest
 * stays open. Margin and cap split pro rata, the closing half's share rounded
 * down; entry price and funding entry are shared. Null when the program
 * refuses it (either half under $10, the whole notional or more, or a closing
 * half with no margin or no cap).
 */
export function linearSplitPosition(p: LinearPosition, notional: bigint): { closing: LinearPosition; rest: LinearPosition } | null {
  const N = p.notionalUsdMicros;
  if (notional >= N) return null;
  const restN = N - notional;
  if (notional < LINEAR_TERMS.minNotionalUsdMicros || restN < LINEAR_TERMS.minNotionalUsdMicros) return null;
  const margin = (p.margin * notional) / N;
  const cap = (p.profitCap * notional) / N;
  if (margin === 0n || cap === 0n) return null;
  const wick = p.wick ? wickSplitPrepaid(p.wick, notional, N) : null;
  return {
    closing: { ...p, margin, notionalUsdMicros: notional, profitCap: cap, ...(wick ? { wick: wick.closing } : {}) },
    rest: { ...p, margin: p.margin - margin, notionalUsdMicros: restN, profitCap: p.profitCap - cap, ...(wick ? { wick: wick.rest } : {}) },
  };
}
/** `WickTerms::split_prepaid`: a partial close's share of the prepaid wick fee (rounded down). */
export function wickSplitPrepaid(t: WickTerms, notional: bigint, total: bigint): { closing: WickTerms; rest: WickTerms } {
  const part = total > 0n ? (t.prepaid * notional) / total : 0n;
  return { closing: { ...t, prepaid: part }, rest: { ...t, prepaid: t.prepaid - part } };
}
/** The notional a percentage of `p` closes (rounded down; 100% is all of it). */
export function partialNotional(p: Pick<LinearPosition, 'notionalUsdMicros'>, pct: number): bigint {
  if (pct >= 100) return p.notionalUsdMicros;
  const bps = BigInt(Math.max(0, Math.round(pct * 100)));
  return (p.notionalUsdMicros * bps) / BPS;
}

export interface LinearPartialCloseQuote {
  /** What closes, USD micros; `full` when it is the whole position. */
  notional: bigint;
  full: boolean;
  /** The closing half's realized PnL (raw shares, signed) and closing fee. */
  pnl: bigint;
  closingFee: bigint;
  /** Its value after the fee, plus (wick-proof) its share of the unused wick fee. */
  payable: bigint;
  refund: bigint;
  total: bigint;
  /** 20% of the closing fee to the order's referrer, if any (the trader pays the same). */
  referral: bigint;
  /** What stays open (null: nothing), and its mark at the same prices. */
  rest: LinearPosition | null;
  restMark: LinearMark | null;
  /** Why the program would refuse this close (null: it would fill). */
  problem: string | null;
}
/**
 * What closing `notional` of `p` now would realize at quote `q`, as the
 * engine's `settle` / `settle_in_pool` would: the closing half marked on its
 * own, a wick-proof half's unused share of the prepaid fee refunded, the rest
 * left open with the same entry, funding entry and expiry. A normal
 * position's rest must not be liquidatable at the fill.
 */
export function linearPartialClose(p: LinearPosition, notional: bigint, q: LinearQuote, fundingIndex: bigint, now: number, referred = false): LinearPartialCloseQuote {
  const full = notional === p.notionalUsdMicros;
  let problem: string | null = null;
  let closing = p;
  let rest: LinearPosition | null = null;
  if (!full) {
    const split = linearSplitPosition(p, notional);
    if (notional > p.notionalUsdMicros) problem = 'That is more than the position.';
    else if (notional < LINEAR_TERMS.minNotionalUsdMicros) problem = 'The smallest partial close is $10.';
    else if (p.notionalUsdMicros - notional < LINEAR_TERMS.minNotionalUsdMicros) problem = 'Leave at least $10 open, or close all of it.';
    else if (!split) problem = 'Too small to split: close all of it.';
    if (split) ({ closing, rest } = split);
  }
  const mark = linearMark(closing, q, fundingIndex);
  const { refund } = closing.wick ? wickSplit(closing.wick, now) : { refund: 0n };
  const restMark = rest ? linearMark(rest, q, fundingIndex) : null;
  if (!problem && rest && !rest.wick && restMark?.liquidatable) {
    problem = 'What would stay open could be liquidated at this price: close all of it instead.';
  }
  return {
    notional, full, pnl: mark.pnl, closingFee: mark.closingFee, payable: mark.payable, refund, total: mark.payable + refund,
    referral: referred ? referralShare(mark.closingFee) : 0n, rest, restMark, problem,
  };
}

// --- reading -----------------------------------------------------------------------------

/** The retired program's aSOL rate, read from Aera's SOL reserve. */
function reserveRate(d: Uint8Array): bigint {
  const v = new DataView(d.buffer, d.byteOffset, d.length);
  const available = v.getBigUint64(169, true);
  const supply = v.getBigUint64(177, true);
  const principal = v.getBigUint64(185, true) | (v.getBigUint64(193, true) << 64n);
  const index = v.getBigUint64(201, true) | (v.getBigUint64(209, true) << 64n);
  const fees = v.getBigUint64(225, true);
  if (supply === 0n) return SCALE;
  const product = principal * index;
  const borrowed = product / FUNDING_SCALE + (product % FUNDING_SCALE === 0n ? 0n : 1n);
  return ((available + borrowed - fees) * SCALE) / supply;
}

export interface LinearMarketView {
  program: PerpsProgram;
  market: LinearMarketState;
  price: FeedPriceState | null;
  /** bCOOK: the settlement post (the MCOOK oracle's quote); null before it publishes. */
  settle: PoolQuote | null;
  /** bCOOK: the stake pool's rate (null when the program would refuse it). */
  rate: BcookRate | null;
  /** Retired program only: its SOL price. */
  solPrice: { priceUsdMicros: bigint; publishedAt: number; signers: number } | null;
  /** The share rate the quote uses (bCOOK gross, or aSOL's). */
  rateE9: bigint;
  /** The quote a fill would use now (null without prices). */
  quote: LinearQuote | null;
  slot: number;
  /** A member's shared LP pool, read with it; null for an isolated market. */
  pool: LpPoolState | null;
  mine: { positions: LinearPosition[]; lpShares: bigint; orders: LinearOrderState[]; balance: bigint } | null;
}
/** One market, its prices, the share rate and (optionally) one wallet's positions, LP, open orders and margin-token balance. */
export async function fetchLinearMarket(connection: Connection, feed: string, owner?: PublicKey, program: PerpsProgram = 'bcook'): Promise<LinearMarketView> {
  const d = perpsDeployment(program);
  const keys = [linearMarket(feed, program), linearPriceAccount(feed, program), settleOracleAccount(program), d.rateAccount, ...(owner ? [marketsTokenAccount(owner, program)] : [])];
  const { context, value } = await connection.getMultipleAccountsInfoAndContext(keys, 'confirmed');
  const [m, p, s, r, ata] = value;
  if (!m || !m.owner.equals(d.programId)) throw new Error(`the ${feed} market is not on chain (${program})`);
  const market = decodeLinearMarket(m.data);
  let mine: LinearMarketView['mine'] = null;
  if (owner) {
    const raw = await connection.getProgramAccounts(d.programId, {
      commitment: 'confirmed',
      filters: [
        { dataSize: 200 },
        { memcmp: { offset: 8, bytes: linearMarket(feed, program).toBase58() } },
        { memcmp: { offset: 40, bytes: owner.toBase58() } },
      ],
    });
    const orders = raw.map((a) => decodeLinearOrder(a.pubkey, a.account.data)).filter((o) => o.active);
    const balance = ata && ata.data.length >= 72 ? new DataView(ata.data.buffer, ata.data.byteOffset + 64, 8).getBigUint64(0, true) : 0n;
    mine = { positions: market.ledger.positions.filter((x) => x.owner.equals(owner)), lpShares: market.ledger.lpBalances.get(owner.toBase58()) ?? 0n, orders, balance };
  }
  let pool: LpPoolState | null = null;
  if (market.ledger.pool) {
    const info = await connection.getAccountInfo(market.ledger.pool.pool, 'confirmed');
    if (info && info.owner.equals(d.programId)) pool = decodeLpPool(info.data);
  }
  const price = p && p.owner.equals(d.programId) ? decodeMarketPrice(feed, p.data) : null;
  if (program === 'asol-v2') {
    const solPrice = s ? decodeSolPrice(s.data) : null;
    const rateE9 = r ? reserveRate(r.data) : SCALE;
    const quote = price && solPrice ? { assetMicros: price.priceUsdMicros, solMicros: solPrice.priceUsdMicros, rateE9 } : null;
    return { program, market, pool, price, settle: null, rate: null, solPrice, rateE9, quote, slot: context.slot, mine };
  }
  const settle = s && s.owner.equals(d.programId) ? decodePoolOracle(s.data, 'bcook').quote : null;
  let rate: BcookRate | null = null;
  try { rate = r ? bcookRate(r.data) : null; } catch { rate = null; }
  const quote = price && settle && settle.publishedAt > 0 && rate ? bcookQuote(price.priceUsdMicros, settle, rate) : null;
  return { program, market, pool, price, settle, rate, solPrice: null, rateE9: rate?.grossE9 ?? SCALE, quote, slot: context.slot, mine };
}

// --- instructions --------------------------------------------------------------------------

const w = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });
const ro = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
const u32le = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const u16le = (n: number) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b; };
const ix = (program: PerpsProgram, keys: AccountMeta[], data: Iterable<number> | Uint8Array) =>
  new TransactionInstruction({ programId: perpsDeployment(program).programId, keys, data: Buffer.from(Uint8Array.from(data)) });
const mintKeys = (program: PerpsProgram) => { const d = perpsDeployment(program); return [ro(d.mint), ro(d.tokenProgram)]; };
/** `[asset price, settle, rate]`: the price accounts of a linear instruction. */
const priceKeys = (feed: string, program: PerpsProgram, withRate = true) =>
  [ro(linearPriceAccount(feed, program)), ro(settleOracleAccount(program)), ...(withRate ? [ro(rateAccount(program)), ...configKeys(program)] : [])];
/** `["config"]`, which every price-reading instruction of the final upgrade takes (the retired program has none). */
export const configAccount = (program: PerpsProgram = 'bcook'): PublicKey => pda(program, enc('config'));
const configKeys = (program: PerpsProgram) => (program === 'bcook' ? [ro(configAccount(program))] : []);

export function encodeLinearAction(a: LinearAction): Uint8Array {
  if (a.kind === 'removeMargin') {
    const out = new Uint8Array(17);
    const v = new DataView(out.buffer);
    out[0] = 6;
    v.setBigUint64(1, a.position, true); v.setBigUint64(9, a.amount, true);
    return out;
  }
  if (a.kind === 'closePart') {
    const out = new Uint8Array(25);
    const v = new DataView(out.buffer);
    out[0] = 5;
    v.setBigUint64(1, a.position, true); v.setBigUint64(9, a.minimum, true); v.setBigUint64(17, a.notional, true);
    return out;
  }
  if (a.kind === 'openWick') {
    const out = new Uint8Array(31);
    const v = new DataView(out.buffer);
    out[0] = 4; out[1] = a.long ? 1 : 0;
    v.setBigUint64(2, a.collateral, true); v.setBigUint64(10, a.notional, true); v.setBigUint64(18, a.profitCap, true);
    v.setUint32(26, a.durationSeconds, true); out[30] = a.takeProfit ? 1 : 0;
    return out;
  }
  const out = new Uint8Array(a.kind === 'open' ? 26 : 17);
  const v = new DataView(out.buffer);
  if (a.kind === 'open') {
    out[0] = 0; out[1] = a.long ? 1 : 0;
    v.setBigUint64(2, a.collateral, true); v.setBigUint64(10, a.notional, true); v.setBigUint64(18, a.profitCap, true);
  } else {
    out[0] = a.kind === 'close' ? 1 : a.kind === 'deposit' ? 2 : 3;
    const [x, y] = a.kind === 'close' ? [a.position, a.minimum] : a.kind === 'deposit' ? [a.amount, a.minimum] : [a.shares, a.minimum];
    v.setBigUint64(1, x, true); v.setBigUint64(9, y, true);
  }
  return out;
}

/**
 * `submit_order(nonce, action, deadline, min_price, max_price, referrer?)`
 * data. Without a referrer it ends at `max_price`; with one in `[1, referrer]`.
 */
export function submitOrderData(nonce: bigint, action: LinearAction, deadline: number, minPrice: bigint, maxPrice: bigint, referrer?: PublicKey | null): Uint8Array {
  const tail = new Uint8Array(24);
  const v = new DataView(tail.buffer);
  v.setBigInt64(0, BigInt(deadline), true);
  v.setBigUint64(8, minPrice, true);
  v.setBigUint64(16, maxPrice, true);
  const ref = referrer ? [1, ...referrer.toBytes()] : [];
  return Uint8Array.from([...MARKETS_DISC.submit_order, ...le64(nonce), ...encodeLinearAction(action), ...tail, ...ref]);
}

/**
 * Submit an order. `nowSeconds` should be the chain's clock; the deadline is
 * `LINEAR_TERMS.orderDeadlineSeconds` after it. Bounds are on the ASSET
 * price, USD micros. `referrer` (integrators: your own wallet) is paid 20%
 * of this order's trading fee at its fill, into its classic bCOOK ATA.
 */
export function linearSubmitIx(feed: string, owner: PublicKey, nonce: bigint, action: LinearAction, nowSeconds: number, minPrice: bigint, maxPrice: bigint, referrer?: PublicKey | null, program: PerpsProgram = 'bcook'): TransactionInstruction {
  const market = linearMarket(feed, program);
  // As the program stores it: no referrer on LP orders, none to oneself.
  const trade = action.kind !== 'deposit' && action.kind !== 'withdraw';
  const ref = trade ? effectiveReferrer(referrer, owner) : null;
  return ix(
    program,
    [w(owner, true), w(linearOrder(market, owner, nonce, program)), w(marketsTokenAccount(owner, program)), w(market), w(linearVault(feed, program)), ...mintKeys(program), ro(SystemProgram.programId)],
    submitOrderData(nonce, action, nowSeconds + LINEAR_TERMS.orderDeadlineSeconds, minPrice, maxPrice, ref),
  );
}
/** Refund an order that missed its deadline; closes the order account to its owner. */
export function linearCancelIx(feed: string, owner: PublicKey, order: PublicKey, program: PerpsProgram = 'bcook'): TransactionInstruction {
  return ix(program, [w(owner, true), w(order), w(marketsTokenAccount(owner, program)), w(linearMarket(feed, program)), w(linearVault(feed, program)), ...mintKeys(program)], MARKETS_DISC.cancel_order);
}
/** A pool-priced market's fills and liquidations read its oracle as the first remaining account (COOK-PERP: the same account as `settle`). */
const poolOracleKeys = (feed: string, program: PerpsProgram) => (isPoolFeed(feed) ? [ro(poolOracleAccount(feed, program))] : []);
/** A shared-pool member's settlements take `[pool (w), pool vault (w)]` as remaining accounts. */
const memberPoolKeys = (pool: PublicKey | null | undefined, program: PerpsProgram) => (pool ? [w(pool), w(lpPoolVault(pool, program))] : []);
/**
 * Permissionless: execute an order on the current prices (the keeper's job).
 * Pass the market's pool (`ledger.pool?.pool`) for a shared-pool member, and
 * the order's `referrer`: its bCOOK ATA goes last and is paid 20% of the
 * fill's fee (nothing, and the fill goes on, if it is missing or invalid).
 */
export function linearExecuteIx(feed: string, order: PublicKey, owner: PublicKey, pool?: PublicKey | null, referrer?: PublicKey | null, program: PerpsProgram = 'bcook'): TransactionInstruction {
  const ref = effectiveReferrer(referrer, owner);
  return ix(
    program,
    [w(order), w(marketsTokenAccount(owner, program)), w(linearMarket(feed, program)), w(linearVault(feed, program)), ...mintKeys(program), ...priceKeys(feed, program), w(owner), ...poolOracleKeys(feed, program), ...memberPoolKeys(pool, program), ...(ref ? [w(marketsTokenAccount(ref, program))] : [])],
    MARKETS_DISC.execute_order,
  );
}
export function linearCheckpointIx(feed: string, program: PerpsProgram = 'bcook'): TransactionInstruction {
  return ix(program, [w(linearMarket(feed, program)), ...priceKeys(feed, program)], MARKETS_DISC.checkpoint_market);
}
/** Pass the market's pool (`ledger.pool?.pool`) for a shared-pool member. */
export function linearLiquidateIx(feed: string, keeper: PublicKey, position: bigint, positionOwner: PublicKey, pool?: PublicKey | null, program: PerpsProgram = 'bcook'): TransactionInstruction {
  return ix(
    program,
    [{ pubkey: keeper, isSigner: true, isWritable: false }, w(marketsTokenAccount(keeper, program)), w(marketsTokenAccount(positionOwner, program)), w(linearMarket(feed, program)), w(linearVault(feed, program)), ...mintKeys(program), ...priceKeys(feed, program), ...poolOracleKeys(feed, program), ...memberPoolKeys(pool, program)],
    [...MARKETS_DISC.liquidate_market, ...le64(position)],
  );
}
/**
 * After the outage rule (6 h without the asset price, 72 h without the
 * settlement price): the position's margin back to its owner at zero PnL. A
 * shared-pool member also takes the pool (and, for a wick-proof position, its
 * vault).
 */
export function linearOutageCloseIx(feed: string, position: bigint, positionOwner: PublicKey, pool?: PublicKey | null, wick = false, program: PerpsProgram = 'bcook'): TransactionInstruction {
  const poolKeys = pool ? (wick ? memberPoolKeys(pool, program) : [w(pool)]) : [];
  return ix(
    program,
    [w(marketsTokenAccount(positionOwner, program)), w(linearMarket(feed, program)), w(linearVault(feed, program)), ...mintKeys(program), ...priceKeys(feed, program, false), ...poolKeys],
    [...MARKETS_DISC.outage_close_market, ...le64(position)],
  );
}
/**
 * Permissionless: settle a wick-proof position at its expiry (`takeProfit:
 * false`) or at its cap (`takeProfit: true`). Proceeds go only to the owner.
 */
export function linearSettleWickIx(feed: string, position: bigint, positionOwner: PublicKey, pool: PublicKey, takeProfit: boolean, program: PerpsProgram = 'bcook'): TransactionInstruction {
  return ix(
    program,
    [w(marketsTokenAccount(positionOwner, program)), w(linearMarket(feed, program)), w(linearVault(feed, program)), ...mintKeys(program), ...priceKeys(feed, program), ...memberPoolKeys(pool, program)],
    [...MARKETS_DISC.settle_wick, ...le64(position), takeProfit ? 1 : 0],
  );
}
/** Admin: set a pool member's wick-proof terms (hard bounds in `WICK_TERMS`; the program re-checks). */
export function setWickConfigIx(admin: PublicKey, feed: string, c: WickConfig, program: PerpsProgram = 'bcook'): TransactionInstruction {
  const d = new Uint8Array(10);
  const v = new DataView(d.buffer);
  v.setUint16(0, c.rate, true); d[2] = c.maxLeverage; v.setUint32(3, c.maxDurationSeconds, true); d[7] = c.maxPositions; v.setUint16(8, c.maxReserveBps, true);
  return ix(program, [{ pubkey: admin, isSigner: true, isWritable: false }, w(linearMarket(feed, program))], [...MARKETS_DISC.set_wick_config, ...d]);
}
export function linearOutageWithdrawIx(feed: string, owner: PublicKey, shares: bigint, program: PerpsProgram = 'bcook'): TransactionInstruction {
  return ix(
    program,
    [{ pubkey: owner, isSigner: true, isWritable: false }, w(marketsTokenAccount(owner, program)), w(linearMarket(feed, program)), w(linearVault(feed, program)), ...mintKeys(program), ...priceKeys(feed, program, false)],
    [...MARKETS_DISC.outage_withdraw_market, ...le64(shares)],
  );
}
/** Protocol fees (or, with `buckets`, the insurance and holder buckets) to Aera's fee destination's account. */
export function linearCollectIx(feed: string, buckets = false, program: PerpsProgram = 'bcook'): TransactionInstruction {
  return ix(
    program,
    [w(feeDestinationAccount(program)), w(linearMarket(feed, program)), w(linearVault(feed, program)), ...mintKeys(program)],
    buckets ? MARKETS_DISC.collect_market_bucket_fees : MARKETS_DISC.collect_market_fees,
  );
}
export interface FeedPackage { value: bigint; timestampMs: number; signature: Uint8Array }
const packagesBody = (packages: FeedPackage[]) => packages.flatMap((p) => {
  const b = new Uint8Array(81);
  const v = new DataView(b.buffer);
  v.setBigUint64(0, p.value, true); v.setBigUint64(8, BigInt(p.timestampMs), true); b.set(p.signature, 16);
  return [...b];
});
/** `post_feed_price(feed_id, packages)`. At most 6 packages fit a transaction. */
export function postFeedPriceData(feed: string, packages: FeedPackage[]): Uint8Array {
  const id = enc(feed);
  return Uint8Array.from([...MARKETS_DISC.post_feed_price, ...u32le(id.length), ...id, ...u32le(packages.length), ...packagesBody(packages)]);
}
export function postFeedPriceIx(feed: string, payer: PublicKey, packages: FeedPackage[], program: PerpsProgram = 'bcook'): TransactionInstruction {
  // The linear SOL market reads ["price"], which post_price writes; the program refuses this.
  if (feed === SOL_LINEAR_FEED) throw new Error('SOL is posted with post_price, never post_feed_price');
  if (isPoolFeed(feed)) throw new Error(`${feed} is priced by post_pool_price, never post_feed_price`);
  return ix(program, [w(payer, true), w(feedPriceAccount(feed, program)), ...configKeys(program), ro(SystemProgram.programId)], postFeedPriceData(feed, packages));
}
/** `post_price(packages)`: the RedStone SOL/USD price into `["price"]` (asset of the linear SOL market, SOL leg of the pool oracle). */
export function postSolPriceIx(payer: PublicKey, packages: FeedPackage[], program: PerpsProgram = 'bcook'): TransactionInstruction {
  return ix(program, [w(payer, true), w(solPriceAccount(program)), ...configKeys(program), ro(SystemProgram.programId)], [...MARKETS_DISC.post_price, ...u32le(packages.length), ...packagesBody(packages)]);
}

/** Slippage bounds around `priceMicros`: `bps` either side. */
export function linearPriceBounds(priceMicros: bigint, bps = 100n): [bigint, bigint] {
  return [(priceMicros * (BPS - bps)) / BPS, (priceMicros * (BPS + bps)) / BPS];
}
/** Asset-price bounds for closing `side`: only the side that hurts the trader is limited. */
export function linearCloseBounds(side: LinearSide, assetMicros: bigint, bps = 100n): [bigint, bigint] {
  return side === 'long' ? [(assetMicros * (BPS - bps)) / BPS, U64_MAX] : [1n, (assetMicros * (BPS + bps)) / BPS];
}
/**
 * The least a close may pay, in raw bCOOK: the position's payout at the worst
 * asset price its bounds allow, with the settlement band widened by
 * `settleBps` at both ends (the fill's post is not bounded by the order).
 * Worst-of marking makes the widened band's payout the lowest inside it.
 */
export function linearCloseMinimum(p: LinearPosition, worstAssetMicros: bigint, q: LinearQuote, fundingIndex: bigint, settleBps = LINEAR_SETTLE_BUFFER_BPS): bigint {
  if (isBcookQuote(q)) return linearMark(p, { ...sizedQuote(q, settleBps), assetMicros: worstAssetMicros }, fundingIndex).payable;
  const at = (solMicros: bigint) => linearMark(p, { ...q, assetMicros: worstAssetMicros, solMicros }, fundingIndex).payable;
  const low = at((q.solMicros * (BPS - settleBps)) / BPS);
  const high = at((q.solMicros * (BPS + settleBps)) / BPS);
  return low < high ? low : high;
}

/**
 * An isolated market's LP NAV as the engine prices it (`LinearMarket::nav`):
 * cash minus traders' unrealized PnL, each position at the band end `side`
 * picks (a withdrawal by default: the lower NAV). Never negative.
 */
export function linearLpNav(l: LinearLedger, q: LinearQuote, now: bigint, side: NavSide = 'withdraw'): bigint {
  const funding = linearFundingIndex(l, now);
  const pnl = l.positions.reduce((sum, p) => sum + linearNavPnl(p, q, funding, side), 0n);
  const nav = l.lpCash - pnl;
  return nav > 0n ? nav : 0n;
}
/** Shares an isolated-market LP deposit of `amount` mints at the deposit NAV (1:1 into an empty market). */
export function linearDepositShares(l: Pick<LinearLedger, 'lpShareSupply'>, amount: bigint, depositNav: bigint): bigint {
  if (l.lpShareSupply === 0n) return amount;
  return depositNav > 0n ? (amount * l.lpShareSupply) / depositNav : 0n;
}

// --- the shared LP pool (docs/PERPS_SHARED_POOL.md) ------------------------------------
//
// One pool's LP capital backs the RedStone-priced markets (BTC, ETH, SOL,
// HYPE). A member keeps its positions, funding, margins and fee buckets; its
// LP capital, LP balances and profit-cap reserves are the pool's. LPs deposit
// and withdraw with pool orders filled by the keeper at the pool's NAV over
// every member (deposits at NAV-high, withdrawals at NAV-low) on prices
// published 2-32 s after the order; after the deadline the same instruction
// refunds the owner. COOK-PERP is never a member.

/** Most LPs one pool may hold (an isolated market holds 32). */
export const POOL_MAX_LPS = 64;
/** Most markets one pool may back. */
export const POOL_MAX_MEMBERS = 8;
/** Compute budget for `execute_pool_order` and `outage_withdraw_pool`: they mark every member's positions. */
export const POOL_ORDER_COMPUTE_UNITS = 1_400_000;

export interface LpPoolMember {
  /** The member market's account address. */
  market: PublicKey;
  /** Sum of the reserved caps of this member's open positions (cached; exact). */
  reserved: bigint;
  /** Most of the pool's cash this member's positions may reserve, in bps. */
  maxReserveBps: number;
}
export interface LpPoolLedger {
  lpCash: bigint;
  lpShareSupply: bigint;
  lpBalances: Map<string, bigint>;
  /** In member order: indices never change. */
  members: LpPoolMember[];
}
export interface LpPoolState {
  id: number;
  bump: number;
  vault: PublicKey;
  /** Paused: no LP deposits and no opens in any member; closes, liquidations and withdrawals run. */
  paused: boolean;
  /** bCOOK escrowed by deposit orders not yet executed or refunded. */
  pending: bigint;
  ledger: LpPoolLedger;
  /** The ledger's cash and members again, so the state itself is a `PoolBacking`. */
  lpCash: bigint;
  members: LpPoolMember[];
}

/** An `LpPoolState` account, ledger included. */
export function decodeLpPool(d: Uint8Array): LpPoolState {
  expect(d, 'LpPoolState');
  const r = new Reader(d, 8);
  const id = r.u8();
  const bump = r.u8();
  const vault = r.key();
  const paused = r.u8() === 1;
  const pending = r.u64();
  r.u32(); // ledger byte length
  const lpCash = r.u64();
  const lpShareSupply = r.u64();
  const lpBalances = new Map<string, bigint>();
  for (let n = r.u32(); n > 0; n--) lpBalances.set(r.key().toBase58(), r.u64());
  const members: LpPoolMember[] = [];
  for (let n = r.u32(); n > 0; n--) members.push({ market: r.key(), reserved: r.u64(), maxReserveBps: r.u16() });
  return { id, bump, vault, paused, pending, ledger: { lpCash, lpShareSupply, lpBalances, members }, lpCash, members };
}

/** The pool's cached reserves, summed. */
export const poolReserved = (pool: PoolBacking): bigint => pool.members.reduce((sum, m) => sum + m.reserved, 0n);
/** Member index of `market` in `pool`, or -1. */
export const poolMemberIndex = (pool: Pick<LpPoolState, 'members'>, market: PublicKey): number => pool.members.findIndex((m) => m.market.equals(market));

/** One member as NAV needs it: its books and the quote it is marked at (null without prices). */
export interface PoolMemberMark { ledger: LinearLedger; quote: LinearQuote | null }

/**
 * Every member's marked PnL, summed, each position at the band end `side`
 * picks (`LedgerView::unrealized_pnl`). Null when a member with open
 * positions has no quote: the program would refuse to price an LP order.
 */
export function poolUnrealizedPnl(members: readonly PoolMemberMark[], now: bigint, side: NavSide = 'withdraw'): bigint | null {
  let pnl = 0n;
  for (const m of members) {
    if (m.ledger.positions.length === 0) continue;
    if (!m.quote) return null;
    const funding = linearFundingIndex(m.ledger, now);
    for (const p of m.ledger.positions) pnl += linearNavPnl(p, m.quote, funding, side);
  }
  return pnl;
}
/** The pool's NAV as the program prices LP orders: cash minus every member's marked PnL (never negative). */
export function poolNav(pool: Pick<LpPoolLedger, 'lpCash'>, members: readonly PoolMemberMark[], now: bigint, side: NavSide = 'withdraw'): bigint | null {
  const pnl = poolUnrealizedPnl(members, now, side);
  if (pnl === null) return null;
  const nav = pool.lpCash - pnl;
  return nav > 0n ? nav : 0n;
}
/** `shares` of the pool in raw bCOOK at `nav`. */
export function poolShareValue(pool: Pick<LpPoolLedger, 'lpShareSupply'>, shares: bigint, nav: bigint): bigint {
  return pool.lpShareSupply > 0n ? (shares * nav) / pool.lpShareSupply : 0n;
}
/** Shares a deposit of `amount` mints at `nav` (the deposit NAV; 1:1 into an empty pool), as `LpPool::deposit`. */
export function poolDepositShares(pool: Pick<LpPoolLedger, 'lpShareSupply'>, amount: bigint, nav: bigint): bigint {
  if (pool.lpShareSupply === 0n) return amount;
  return nav > 0n ? (amount * pool.lpShareSupply) / nav : 0n;
}
/**
 * Why an LP order would be refused by the 10,000-bCOOK floor
 * (`Accounting`): a deposit below it, or a partial withdrawal leaving a
 * balance worth less. Null when it passes. `floor` defaults to the bCOOK one.
 */
export function lpFloorProblem(
  order: { kind: 'deposit'; amount: bigint } | { kind: 'withdraw'; shares: bigint; balance: bigint; nav: bigint; supply: bigint },
  floor = LINEAR_TERMS.minLpDeposit,
): string | null {
  if (order.kind === 'deposit') return order.amount < floor ? 'The smallest LP deposit is 10,000 bCOOK.' : null;
  const left = order.balance - order.shares;
  if (left > 0n && order.supply > 0n && (left * order.nav) / order.supply < floor) return 'Withdraw all of it, or leave at least 10,000 bCOOK in.';
  return null;
}

/** A member's `[market, price]` remaining accounts, and the feed it trades. */
export interface PoolMemberAccounts { market: PublicKey; price: PublicKey; feed: string }
/**
 * The member accounts every pool-wide instruction takes, in the pool's member
 * order, for a pool whose members are markets of `feeds`. Throws on a member
 * it cannot name: the program refuses a list that leaves one out.
 */
export function poolMemberAccounts(pool: Pick<LpPoolState, 'members'>, feeds: readonly string[] = [...LINEAR_FEEDS, SOL_LINEAR_FEED], program: PerpsProgram = 'bcook'): PoolMemberAccounts[] {
  const byMarket = new Map(feeds.map((f) => [linearMarket(f, program).toBase58(), f] as const));
  return pool.members.map((m) => {
    const feed = byMarket.get(m.market.toBase58());
    if (!feed) throw new Error(`pool member ${m.market.toBase58()} is not a known market`);
    return { market: m.market, price: linearPriceAccount(feed, program), feed };
  });
}
const memberKeys = (members: readonly PoolMemberAccounts[]): AccountMeta[] => members.flatMap((m) => [ro(m.market), ro(m.price)]);

export type PoolAction = Extract<LinearAction, { kind: 'deposit' | 'withdraw' }>;
/** `["order", pool, owner, nonce]`: a pool LP order (the `Order` type; its `market` is the pool). */
export const poolOrder = (owner: PublicKey, nonce: bigint, id = 0, program: PerpsProgram = 'bcook'): PublicKey => linearOrder(lpPoolAccount(id, program), owner, nonce, program);

/** `submit_pool_order(nonce, action, deadline)` data. */
export function submitPoolOrderData(nonce: bigint, action: PoolAction, deadline: number): Uint8Array {
  const tail = new Uint8Array(8);
  new DataView(tail.buffer).setBigInt64(0, BigInt(deadline), true);
  return Uint8Array.from([...MARKETS_DISC.submit_pool_order, ...le64(nonce), ...encodeLinearAction(action), ...tail]);
}
/**
 * An LP deposit (escrowed in the pool's vault) or withdrawal order on the
 * shared pool. Slippage is the action's `minimum` (shares for a deposit,
 * bCOOK for a withdrawal). A deposit needs the pool unpaused and at least
 * 10,000 bCOOK (`lpFloorProblem`).
 */
export function poolSubmitIx(owner: PublicKey, nonce: bigint, action: PoolAction, nowSeconds: number, id = 0, program: PerpsProgram = 'bcook'): TransactionInstruction {
  const pool = lpPoolAccount(id, program);
  return ix(
    program,
    [w(owner, true), w(poolOrder(owner, nonce, id, program)), w(marketsTokenAccount(owner, program)), w(pool), w(lpPoolVault(pool, program)), ...mintKeys(program), ro(SystemProgram.programId)],
    submitPoolOrderData(nonce, action, nowSeconds + LINEAR_TERMS.orderDeadlineSeconds),
  );
}
/**
 * Permissionless: fill a pool LP order at NAV, or after its deadline refund
 * it (there is no separate cancel). `members` in member order
 * (`poolMemberAccounts`). Send with `POOL_ORDER_COMPUTE_UNITS`.
 */
export function poolExecuteIx(order: PublicKey, owner: PublicKey, members: readonly PoolMemberAccounts[], id = 0, program: PerpsProgram = 'bcook'): TransactionInstruction {
  const pool = lpPoolAccount(id, program);
  return ix(
    program,
    [w(order), w(marketsTokenAccount(owner, program)), w(pool), w(lpPoolVault(pool, program)), ...mintKeys(program), ro(settleOracleAccount(program)), ro(rateAccount(program)), ...configKeys(program), w(owner), ...memberKeys(members)],
    MARKETS_DISC.execute_pool_order,
  );
}
/** LP exit with no price, once every member is in an outage and holds no position. */
export function poolOutageWithdrawIx(owner: PublicKey, shares: bigint, members: readonly PoolMemberAccounts[], id = 0, program: PerpsProgram = 'bcook'): TransactionInstruction {
  const pool = lpPoolAccount(id, program);
  return ix(
    program,
    [{ pubkey: owner, isSigner: true, isWritable: false }, w(marketsTokenAccount(owner, program)), w(pool), w(lpPoolVault(pool, program)), ...mintKeys(program), ro(settleOracleAccount(program)), ...memberKeys(members)],
    [...MARKETS_DISC.outage_withdraw_pool, ...le64(shares)],
  );
}

// --- admin (scripts/perps-bcook/init.mjs, retire-v2.mjs) -----------------------------------

const adminKey = (admin: PublicKey, writable = false): AccountMeta => ({ pubkey: admin, isSigner: true, isWritable: writable });

/** `create_lp_pool(id)`: the pool and its vault, paused, with no members. */
export function createLpPoolIx(admin: PublicKey, id = 0, program: PerpsProgram = 'bcook'): TransactionInstruction {
  const pool = lpPoolAccount(id, program);
  return ix(program, [adminKey(admin, true), w(pool), w(lpPoolVault(pool, program)), ...mintKeys(program), ro(SystemProgram.programId)], [...MARKETS_DISC.create_lp_pool, id]);
}
/** `join_lp_pool(max_reserve_bps)`: `feed`'s market joins the pool for good. */
export function joinLpPoolIx(admin: PublicKey, feed: string, maxReserveBps: number, id = 0, program: PerpsProgram = 'bcook'): TransactionInstruction {
  const pool = lpPoolAccount(id, program);
  return ix(
    program,
    [adminKey(admin), w(pool), w(lpPoolVault(pool, program)), w(linearMarket(feed, program)), w(linearVault(feed, program)), ...mintKeys(program)],
    [...MARKETS_DISC.join_lp_pool, ...u16le(maxReserveBps)],
  );
}
export function setLpPoolPausedIx(admin: PublicKey, paused: boolean, id = 0, program: PerpsProgram = 'bcook'): TransactionInstruction {
  return ix(program, [adminKey(admin), w(lpPoolAccount(id, program))], [...MARKETS_DISC.set_lp_pool_paused, paused ? 1 : 0]);
}
export function setLpPoolMemberLimitIx(admin: PublicKey, member: number, maxReserveBps: number, id = 0, program: PerpsProgram = 'bcook'): TransactionInstruction {
  return ix(program, [adminKey(admin), w(lpPoolAccount(id, program))], [...MARKETS_DISC.set_lp_pool_member_limit, member, ...u16le(maxReserveBps)]);
}
const encodeLimits = (limits: LinearLimits) => {
  const l = new Uint8Array(11);
  const v = new DataView(l.buffer);
  v.setBigUint64(0, limits.maxNotionalUsdMicros, true);
  v.setUint16(8, limits.maxPositions, true);
  l[10] = limits.maxLeverage;
  return l;
};
/** `create_market(feed, limits)`, paused. For "SOL" the price account is `["price"]`: the linear SOL market. */
export function createLinearMarketIx(admin: PublicKey, feed: string, limits: LinearLimits, program: PerpsProgram = 'bcook'): TransactionInstruction {
  const id = enc(feed);
  const d = perpsDeployment(program);
  return ix(
    program,
    [adminKey(admin, true), w(linearMarket(feed, program)), w(linearVault(feed, program)), ro(d.mint), ro(linearPriceAccount(feed, program)), ro(d.tokenProgram), ro(SystemProgram.programId)],
    [...MARKETS_DISC.create_market, ...u32le(id.length), ...id, ...encodeLimits(limits)],
  );
}
/** `set_market_limits(limits)`: applies to positions opened afterwards. */
export function setMarketLimitsIx(admin: PublicKey, feed: string, limits: LinearLimits, program: PerpsProgram = 'bcook'): TransactionInstruction {
  return ix(program, [adminKey(admin), w(linearMarket(feed, program))], [...MARKETS_DISC.set_market_limits, ...encodeLimits(limits)]);
}
export function setMarketPausedIx(admin: PublicKey, feed: string, paused: boolean, program: PerpsProgram = 'bcook'): TransactionInstruction {
  return ix(program, [adminKey(admin), w(linearMarket(feed, program))], [...MARKETS_DISC.set_market_paused, paused ? 1 : 0]);
}

/** The shared pool `id`, or null before it exists. */
export async function fetchLpPool(connection: Connection, id = 0, program: PerpsProgram = 'bcook'): Promise<LpPoolState | null> {
  const info = await connection.getAccountInfo(lpPoolAccount(id, program), 'confirmed');
  return info && info.owner.equals(perpsDeployment(program).programId) ? decodeLpPool(info.data) : null;
}
