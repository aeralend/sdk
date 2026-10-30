/**
 * aCOOK as a COOK savings receipt, and the way from it into perps.
 *
 * aCOOK is Aera market 0's COOK reserve share. Nothing is staked. Its value in
 * COOK (`totalLiquidity / shareSupply`) rises only when a borrower pays
 * interest, so everything a holder should know is a fact of the reserve, of
 * the loans against it and of who holds it. This module reads those facts and
 * does the arithmetic that turns them into statements, and it leaves the words
 * to the app. Nothing here is a forecast, an APY or a promise.
 *
 * ## Two halves
 *
 * 1. **Disclosure** (`readSavingsReport`, `savingsStats`, `rateCurve`,
 *    `holderConcentration`, `borrowerBreakdown`). Every figure comes from the
 *    chain at one slot, or is reported as not computed with the reason. The
 *    borrowers' share of interest needs no model: all loans in one reserve pay
 *    the same rate on the same index, so a wallet's share of the debt is its
 *    share of the interest.
 *
 * 2. **The zap** (`zapQuote`, `prepareAcookZap`, `buildZapInstructions`).
 *    aCOOK to COOK (Aera `withdraw`, limited by the cash nobody has borrowed),
 *    COOK to bCOOK (BakeYourStake `DepositSol`, with its minimum enforced ON
 *    CHAIN), ready to be perps margin or a pool deposit. The steps are one
 *    transaction, so the wallet cannot be left half-way: either it holds the
 *    bCOOK or nothing changed. Perps margin and LP deposits are taken from the
 *    wallet's bCOOK when the order is placed, so the zap ends there.
 *
 * Pure functions take plain values; the two `read`/`prepare` functions are the
 * only ones that touch a connection, and they only read.
 */

import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  unpackAccount,
} from '@solana/spl-token';
import { PublicKey, type Connection, type TransactionInstruction } from '@solana/web3.js';

import { AeraClient } from './client.js';
import { AERA_PROGRAM_ID, BPS, FIXED_POINT_SCALE } from './constants.js';
import { decodeGlobal, decodeReserve } from './decode.js';
import { LAUNCH } from './launch.generated.js';
import { globalPda } from './pda.js';
import { programDataAddress } from './oracleConfig.js';
import { COOK_POOL_PINS } from './poolMarkets.js';
import { accrueReserve, debtAt, totalLiquidityOf, utilizationBpsOf } from './projection.js';
import { borrowRateBps, supplyRateBps } from './math.js';
import { NATIVE_MINT, ensureAtaIx, unwrapNativeIx } from './native.js';
import { readReceiptPortfolio, receiptIdentity, redeemableReceiptShares, type ReceiptBalance } from './receipts.js';
import { withStakingMinimum } from './staking.js';
import {
  BCOOK_STAKE_POOL,
  STAKE_POOL_PROGRAM_ID,
  decodeStakePool,
  depositSolIx,
  feeBps,
  lamportsForWithdrawal,
  poolTokensForDeposit,
  poolTokensForLamports,
  withdrawableLamports,
  type StakePoolState,
} from './stakePool.js';
import type { ObligationAccount, ReserveAccount, ReserveConfig } from './types.js';

// ---------------------------------------------------------------------------
// Disclosure: the reserve
// ---------------------------------------------------------------------------

/** Wallets Aera's own records and its owner name as the project's. Shown only as labels on chain-derived shares. */
export const DOCUMENTED_PROJECT_WALLETS: Readonly<Record<string, string>> = {
  // docs/AERA_DEPLOYMENT_2026_10_10.md: "the operator wallet `zbUkycruoGyf5jcpmthQpMUq3Y2hp6ywY4WsDFDozok`".
  zbUkycruoGyf5jcpmthQpMUq3Y2hp6ywY4WsDFDozok: 'the Aera operator wallet',
  // The owner confirmed on 2026-10-27 that this wallet is his own; it holds nearly all aCOOK and is a borrower.
  EH5c4qiAzQhMmWbabbB8QjgZ9VU6DoSfy2HJYRJwvsFv: 'Aera’s owner',
};

export interface SavingsStats {
  slot: bigint;
  /** `Global.paused`: while true every withdrawal is refused. */
  paused: boolean;
  /** COOK per aCOOK, FIXED_POINT_SCALE-scaled. 1.0 while no share exists. */
  rate: bigint;
  /** COOK the receipts claim in all (cash plus loans, less Aera's accrued fee). */
  totalSupplied: bigint;
  /** COOK in the vault that nobody has borrowed: what redeems at par now. */
  available: bigint;
  /** COOK owed by borrowers, interest included. */
  borrowed: bigint;
  shareSupply: bigint;
  utilizationBps: number;
  borrowRateBps: number;
  /** The reserve's supply rate at this utilisation, a per-year rate that moves with every loan. Not an APY. */
  supplyRateBps: number;
  kinkBps: number;
  reserveFactorBps: number;
  originationFeeBps: number;
  /** `available / totalSupplied` in basis points, 0 to 10,000. */
  parBps: number;
  supplyCap: bigint;
  borrowCap: bigint;
  perWalletSupplyCap: bigint;
  borrowEnabled: boolean;
}

/** The reserve at `slot`, as the disclosure states it. */
export function savingsStats(reserve: ReserveAccount, slot: bigint, paused = false): SavingsStats {
  const a = accrueReserve(reserve, slot);
  const total = totalLiquidityOf(a);
  const supply = a.shareMintSupply;
  const available = a.availableLiquidity;
  const claim = total > 0n ? total : 0n;
  const parBps = claim === 0n ? 0 : Number(available >= claim ? BPS : (available * BPS) / claim);
  return {
    slot,
    paused,
    rate: supply === 0n ? FIXED_POINT_SCALE : (claim * FIXED_POINT_SCALE) / supply,
    totalSupplied: claim,
    available,
    borrowed: claim > available ? claim - available : 0n,
    shareSupply: supply,
    utilizationBps: Number(utilizationBpsOf(a)),
    borrowRateBps: Number(borrowRateBps(a)),
    supplyRateBps: Number(supplyRateBps(a)),
    kinkBps: a.config.optimalUtilizationBps,
    reserveFactorBps: a.config.reserveFactorBps,
    originationFeeBps: a.config.originationFeeBps,
    parBps,
    supplyCap: a.config.supplyCap,
    borrowCap: a.config.borrowCap,
    perWalletSupplyCap: a.config.perWalletSupplyCap,
    borrowEnabled: a.config.borrowEnabled,
  };
}

export interface CurveRow {
  utilizationBps: number;
  borrowRateBps: number;
  supplyRateBps: number;
}

/** The borrow and supply rate this reserve's curve gives at a utilisation: `borrowRateBps` and `supplyRateBps` of `math.ts`, at a chosen point. */
export function rateAtUtilization(config: Pick<ReserveConfig, 'optimalUtilizationBps' | 'minBorrowRateBps' | 'optimalBorrowRateBps' | 'maxBorrowRateBps' | 'reserveFactorBps'>, utilizationBps: number): CurveRow {
  if (!Number.isInteger(utilizationBps) || utilizationBps < 0 || utilizationBps > 10_000) throw new RangeError('utilisation must be 0 to 10,000 bps');
  const u = BigInt(utilizationBps);
  const kink = BigInt(config.optimalUtilizationBps);
  const min = BigInt(config.minBorrowRateBps);
  const optimal = BigInt(config.optimalBorrowRateBps);
  const max = BigInt(config.maxBorrowRateBps);
  const borrow = u <= kink ? min + ((optimal - min) * u) / (kink === 0n ? 1n : kink) : optimal + ((max - optimal) * (u - kink)) / (BPS - kink);
  const supply = (((borrow * u) / BPS) * (BPS - BigInt(config.reserveFactorBps))) / BPS;
  return { utilizationBps, borrowRateBps: Number(borrow), supplyRateBps: Number(supply) };
}

/**
 * The curve at five points: nearly idle, light, the kink, heavy, fully borrowed.
 *
 * This is what the same market pays at other loan volumes. It is not a
 * forecast: it shows that the rate is a function of how much is borrowed, and
 * how little a receipt earns when nobody borrows.
 */
export function rateCurve(config: Parameters<typeof rateAtUtilization>[0]): CurveRow[] {
  const points = [500, 3_000, config.optimalUtilizationBps, 8_000, 10_000];
  return [...new Set(points)].sort((x, y) => x - y).map((u) => rateAtUtilization(config, u));
}

// ---------------------------------------------------------------------------
// Disclosure: who holds it, who owes
// ---------------------------------------------------------------------------

export interface HolderEntry {
  owner: string;
  amount: bigint;
}

export interface HolderShare {
  owner: string;
  amount: bigint;
  /** 0 to 1, from the exact ratio. */
  share: number;
}

export interface HolderConcentration {
  supply: bigint;
  /** Owners, largest first, merged across their token accounts. */
  holders: HolderShare[];
  topShare: number;
  top3Share: number;
  /** Share of the supply the listed accounts account for. Below 1 means holders beyond the list. */
  listedShare: number;
  /** `getTokenLargestAccounts` lists at most 20 accounts: with 20 listed, there may be more holders. */
  mayHaveMoreHolders: boolean;
}

const ratio = (part: bigint, whole: bigint): number => (whole <= 0n ? 0 : Number((part * 1_000_000_000n) / whole) / 1_000_000_000);

/** The largest accounts of the receipt mint, merged by owner. `supply` is the receipt supply; entries may come from several token accounts per owner. */
export function holderConcentration(entries: HolderEntry[], supply: bigint, accountsListed = entries.length): HolderConcentration {
  const merged = new Map<string, bigint>();
  for (const e of entries) if (e.amount > 0n) merged.set(e.owner, (merged.get(e.owner) ?? 0n) + e.amount);
  const holders = [...merged.entries()]
    .map(([owner, amount]) => ({ owner, amount, share: ratio(amount, supply) }))
    .sort((a, b) => (a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1));
  const sum = (n: number) => holders.slice(0, n).reduce((acc, h) => acc + h.amount, 0n);
  const listed = holders.reduce((acc, h) => acc + h.amount, 0n);
  return {
    supply,
    holders,
    topShare: holders[0]?.share ?? 0,
    top3Share: ratio(sum(3), supply),
    listedShare: Math.min(1, ratio(listed, supply)),
    mayHaveMoreHolders: accountsListed >= 20,
  };
}

export interface BorrowerShare {
  owner: string;
  /** COOK owed now, interest included. */
  debt: bigint;
  /** Share of all COOK debt, which is the share of the interest it pays. */
  share: number;
  label: string | null;
}

export interface BorrowerBreakdown {
  borrowers: BorrowerShare[];
  count: number;
  totalDebt: bigint;
  largestShare: number;
  /** Share of the debt held by wallets the records name as the project's. */
  labelledShare: number;
}

/**
 * Who owes the COOK reserve, from the obligations. `reserve` must be the
 * accrued reserve (debt = principal x index, rounded up, as the program does).
 */
export function borrowerBreakdown(
  obligations: ReadonlyArray<Pick<ObligationAccount, 'owner' | 'borrows'>>,
  reserve: Pick<ReserveAccount, 'address' | 'borrowIndex'>,
  labels: Readonly<Record<string, string>> = DOCUMENTED_PROJECT_WALLETS,
): BorrowerBreakdown {
  const rows: Array<{ owner: string; debt: bigint }> = [];
  for (const o of obligations) {
    const entry = o.borrows.find((b) => b.reserve.equals(reserve.address));
    if (!entry || entry.borrowedPrincipal === 0n) continue;
    rows.push({ owner: o.owner.toBase58(), debt: debtAt(entry.borrowedPrincipal, reserve.borrowIndex) });
  }
  const totalDebt = rows.reduce((acc, r) => acc + r.debt, 0n);
  const borrowers = rows
    .sort((a, b) => (a.debt === b.debt ? 0 : a.debt > b.debt ? -1 : 1))
    .map((r) => ({ owner: r.owner, debt: r.debt, share: ratio(r.debt, totalDebt), label: labels[r.owner] ?? null }));
  const labelled = borrowers.filter((b) => b.label !== null).reduce((acc, b) => acc + b.debt, 0n);
  return { borrowers, count: borrowers.length, totalDebt, largestShare: borrowers[0]?.share ?? 0, labelledShare: ratio(labelled, totalDebt) };
}

// ---------------------------------------------------------------------------
// Disclosure: who can change the program
// ---------------------------------------------------------------------------

export interface AuthorityInfo {
  /** The wallet that can replace Aera's program code, or null when the program is immutable. */
  programUpgradeAuthority: string | null;
  /** True when that address is an ordinary keypair wallet; false when program-derived (possibly a multisig); null when none. */
  upgradeAuthorityIsWallet: boolean | null;
  /** `Global.admin`: pauses, tightens limits at once, loosens them after the timelock. Cannot take funds. */
  admin: string;
  adminIsUpgradeAuthority: boolean;
  /** Seconds a loosening waits (`Global.param_timelock_seconds`). */
  paramTimelockSeconds: number;
  /** Where Aera's cut of the interest is paid. */
  feeDestination: string;
  /** BakeYourStake's stake-pool program upgrade authority, read from its ProgramData (the code's pinned value if the read failed). */
  stakePoolUpgradeAuthority: string | null;
  stakePoolUpgradeAuthoritySource: 'chain' | 'code';
}

/** `UpgradeableLoaderState::ProgramData`: u32 tag 3, u64 slot, Option<Pubkey>. Reads the authority from the first 45 bytes. */
export function upgradeAuthorityOf(programData: Uint8Array): PublicKey | null {
  const b = Buffer.from(programData.buffer, programData.byteOffset, programData.byteLength);
  if (b.length < 45 || b.readUInt32LE(0) !== 3) throw new Error('not a ProgramData account');
  return b[12] === 0 ? null : new PublicKey(b.subarray(13, 45));
}

// ---------------------------------------------------------------------------
// Disclosure: how deep COOK's market is
// ---------------------------------------------------------------------------

export interface CookMarketDepth {
  /** COOK in the two pinned SOL/COOK pools, in base units. */
  totalCook: bigint;
  /** Bridged SOL in the same two pools, in base units. */
  totalSol: bigint;
  pools: Array<{ pool: string; cook: bigint; sol: bigint }>;
}

/**
 * Price impact, in basis points, of selling `cookIn` COOK into a constant-product
 * pool holding `reserveCook` COOK, before fees: `in / (reserve + in)`. An
 * estimate (a concentrated-liquidity pool would be cheaper inside its range
 * and dearer outside it), good for saying how thin the market is.
 */
export function sellImpactBps(cookIn: bigint, reserveCook: bigint): number {
  if (cookIn <= 0n) return 0;
  if (reserveCook <= 0n) return 10_000;
  return Number((cookIn * 10_000n) / (reserveCook + cookIn));
}

/** The vault balances of the two pools Aera prices COOK from (`COOK_POOL_PINS`). Reads only. */
export async function readCookMarketDepth(connection: Connection): Promise<CookMarketDepth> {
  const keys = COOK_POOL_PINS.flatMap((p) => [p.tokenVault, p.solVault]);
  const infos = await connection.getMultipleAccountsInfo(keys, 'confirmed');
  const pools: CookMarketDepth['pools'] = [];
  COOK_POOL_PINS.forEach((pin, i) => {
    const cookInfo = infos[i * 2];
    const solInfo = infos[i * 2 + 1];
    if (!cookInfo || !solInfo) throw new Error('A COOK pool vault is not readable.');
    pools.push({
      pool: pin.pool.toBase58(),
      cook: unpackAccount(pin.tokenVault, cookInfo, cookInfo.owner).amount,
      sol: unpackAccount(pin.solVault, solInfo, solInfo.owner).amount,
    });
  });
  return { pools, totalCook: pools.reduce((a, p) => a + p.cook, 0n), totalSol: pools.reduce((a, p) => a + p.sol, 0n) };
}

// ---------------------------------------------------------------------------
// Disclosure: the whole report
// ---------------------------------------------------------------------------

export interface SavingsReport {
  slot: bigint;
  readAt: number;
  stats: SavingsStats;
  curve: CurveRow[];
  holders: HolderConcentration | null;
  borrowers: BorrowerBreakdown | null;
  /** COOK's two pools, where redeemed COOK would be sold. */
  market: CookMarketDepth | null;
  /** Estimated price impact of selling all the COOK that redeems at par now into those pools, in bps. Null when the pools were not read. */
  parSellImpactBps: number | null;
  /** The largest aCOOK holder's own loan, when that wallet is also a borrower. */
  topHolderBorrows: { owner: string; share: number; debt: bigint } | null;
  authority: AuthorityInfo | null;
  /** What could not be computed this time, and why. Empty when everything was. */
  gaps: string[];
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Read the disclosure from Cookie Chain. Reads only.
 *
 * The reserve, the global account and the share mint come from one batched
 * call (one slot). Holders, borrowers and authorities are separate reads; if
 * one fails the report still carries the rest and names the gap.
 */
export async function readSavingsReport(connection: Connection, client: AeraClient = new AeraClient({ connection })): Promise<SavingsReport> {
  const { reserve: reserveAddress, shareMint } = receiptIdentity('aCOOK');
  const { context, value } = await connection.getMultipleAccountsInfoAndContext([globalPda(), reserveAddress], { commitment: 'confirmed' });
  const globalInfo = value[0];
  const reserveInfo = value[1];
  if (!globalInfo || !globalInfo.owner.equals(AERA_PROGRAM_ID) || !reserveInfo || !reserveInfo.owner.equals(AERA_PROGRAM_ID)) throw new Error('The COOK market is not readable on this RPC.');
  const global = decodeGlobal(globalPda(), client.decodeAccountData('Global', globalInfo.data));
  const stored = decodeReserve(reserveAddress, client.decodeAccountData('Reserve', reserveInfo.data));
  if (!stored.shareMint.equals(shareMint)) throw new Error('The COOK receipt mint is not the expected one.');
  const slot = BigInt(context.slot);
  const reserve = accrueReserve(stored, slot);
  const stats = savingsStats(stored, slot, Boolean(global.paused));
  const gaps: string[] = [];

  const [holdersResult, borrowersResult, authorityResult, marketResult] = await Promise.allSettled([
    (async () => {
      const largest = await connection.getTokenLargestAccounts(shareMint, 'confirmed');
      const live = largest.value.filter((v) => BigInt(v.amount) > 0n);
      const infos = live.length ? await connection.getMultipleAccountsInfo(live.map((v) => new PublicKey(v.address)), 'confirmed') : [];
      const entries: HolderEntry[] = [];
      live.forEach((v, i) => {
        const info = infos[i];
        if (!info) return;
        const account = unpackAccount(new PublicKey(v.address), info, TOKEN_2022_PROGRAM_ID);
        entries.push({ owner: account.owner.toBase58(), amount: account.amount });
      });
      return holderConcentration(entries, stored.shareMintSupply, largest.value.length);
    })(),
    (async () => {
      const obligations = await client.getObligations();
      const labels: Record<string, string> = { ...DOCUMENTED_PROJECT_WALLETS };
      const admin = global.admin.toBase58();
      labels[admin] = 'the Aera admin wallet';
      return borrowerBreakdown(obligations, reserve, labels);
    })(),
    (async (): Promise<AuthorityInfo> => {
      const stakeProgramData = new PublicKey(LAUNCH.stakePool.programData);
      const [aera, stake] = await connection.getMultipleAccountsInfo([programDataAddress(AERA_PROGRAM_ID), stakeProgramData], { commitment: 'confirmed', dataSlice: { offset: 0, length: 45 } });
      if (!aera) throw new Error('Aera’s program data account is not readable');
      const upgrade = upgradeAuthorityOf(aera.data);
      const admin = global.admin.toBase58();
      let stakeAuthority: string | null = LAUNCH.stakePool.upgradeAuthority;
      let source: 'chain' | 'code' = 'code';
      if (stake) {
        try {
          stakeAuthority = upgradeAuthorityOf(stake.data)?.toBase58() ?? null;
          source = 'chain';
        } catch {
          // keep the code's pinned value
        }
      }
      return {
        programUpgradeAuthority: upgrade?.toBase58() ?? null,
        upgradeAuthorityIsWallet: upgrade ? PublicKey.isOnCurve(upgrade.toBytes()) : null,
        admin,
        adminIsUpgradeAuthority: upgrade?.toBase58() === admin,
        paramTimelockSeconds: Number(global.paramTimelockSeconds),
        feeDestination: global.feeDestination.toBase58(),
        stakePoolUpgradeAuthority: stakeAuthority,
        stakePoolUpgradeAuthoritySource: source,
      };
    })(),
    readCookMarketDepth(connection),
  ]);

  const holders = holdersResult.status === 'fulfilled' ? holdersResult.value : null;
  if (holdersResult.status === 'rejected') gaps.push(`Who holds aCOOK: ${message(holdersResult.reason)}`);
  const borrowers = borrowersResult.status === 'fulfilled' ? borrowersResult.value : null;
  if (borrowersResult.status === 'rejected') gaps.push(`Who has borrowed: ${message(borrowersResult.reason)}`);
  const authority = authorityResult.status === 'fulfilled' ? authorityResult.value : null;
  if (authorityResult.status === 'rejected') gaps.push(`Who can change the program: ${message(authorityResult.reason)}`);

  const market = marketResult.status === 'fulfilled' ? marketResult.value : null;
  if (marketResult.status === 'rejected') gaps.push(`How deep COOK’s market is: ${message(marketResult.reason)}`);

  let topHolderBorrows: SavingsReport['topHolderBorrows'] = null;
  const top = holders?.holders[0];
  const asBorrower = top && borrowers?.borrowers.find((b) => b.owner === top.owner);
  if (top && asBorrower) topHolderBorrows = { owner: top.owner, share: asBorrower.share, debt: asBorrower.debt };

  return { slot, readAt: Date.now(), stats, curve: rateCurve(stored.config), holders, borrowers, market, parSellImpactBps: market ? sellImpactBps(stats.available, market.totalCook) : null, topHolderBorrows, authority, gaps };
}

// ---------------------------------------------------------------------------
// The zap: aCOOK to COOK to bCOOK
// ---------------------------------------------------------------------------

/** Default tolerance on the bCOOK the stake step mints, enforced on chain. The Stake page uses the same. */
export const ZAP_SLIPPAGE_BPS = 50;
/** How long a prepared zap stays valid, as the Stake page's quotes do. */
export const ZAP_QUOTE_TTL_MS = 45_000;
/** Native COOK the wallet must hold already: network fee, the wrapper account's rent (refunded), the bCOOK account's rent and the position account's. 0.01 COOK. */
export const ZAP_MIN_NATIVE_COOK = 10_000_000n;

export type ZapBlocker =
  | 'no-shares'
  | 'paused'
  | 'no-liquidity'
  | 'pool-stale'
  | 'pool-restricted'
  | 'too-small'
  | 'wallet-fees';

export interface ZapReserveInput {
  /** Un-borrowed COOK in the vault. */
  available: bigint;
  /** COOK all receipts claim. */
  total: bigint;
  /** aCOOK supply. */
  supply: bigint;
  paused: boolean;
}

export interface ZapInput {
  /** aCOOK to convert, raw. */
  shares: bigint;
  /** Unlocked aCOOK in the wallet. */
  walletShares: bigint;
  reserve: ZapReserveInput;
  stake: StakePoolState;
  /** The chain's current epoch, to know whether the stake pool has been updated for it. */
  epoch: bigint | null;
  /** The wallet's native COOK, or null when unread. */
  walletNativeCook?: bigint | null;
  slippageBps?: number;
}

export interface ZapQuote {
  sharesRequested: bigint;
  /** aCOOK actually converted: the request, limited by the wallet and by the cash at par. */
  sharesIn: bigint;
  cappedBy: 'wallet' | 'liquidity' | null;
  /** The most this wallet can convert now: its aCOOK, limited by the cash at par. */
  maxShares: bigint;
  maxCook: bigint;
  /** The most anyone can redeem at par now (the whole reserve's un-borrowed cash). */
  parShares: bigint;
  parCook: bigint;
  /** COOK the redeem step pays, at the quote's slot. The chain pays at least this: the rate only rises between quote and send. */
  cookOut: bigint;
  /** COOK the stake step deposits: exactly `cookOut`. */
  stakeLamports: bigint;
  bcookOut: bigint;
  /** The least bCOOK the stake step may mint; the program refuses the transaction below it. */
  minBcookOut: bigint;
  slippageBps: number;
  /** COOK per bCOOK before fees, 1e9-scaled. */
  cookPerBcookE9: bigint;
  depositFeeBps: number;
  withdrawalFeeBps: number;
  /** COOK back from bCOOK by redeeming the bCOOK just minted, immediately. */
  roundTripCookBack: bigint;
  /** Both pool fees together as a percent of the COOK staked, from the exact amounts (2.49 for 0.5% in and 2% out). */
  roundTripCostPct: number;
  blockers: ZapBlocker[];
}

/** COOK that `shares` redeem for, as the program computes it (`shares * total / supply`, floored). */
const claimOf = (shares: bigint, r: ZapReserveInput): bigint => (r.supply === 0n ? 0n : (shares * r.total) / r.supply);

/** The most aCOOK redeemable at par now, for a holder of `held` (see `redeemableReceiptShares`). */
export function parRedeemableShares(held: bigint, r: ZapReserveInput): bigint {
  if (r.paused || held <= 0n) return 0n;
  return redeemableReceiptShares(held < r.supply ? held : r.supply, r.total, r.supply, r.available);
}

/** Price the whole zap. Pure. */
export function zapQuote(input: ZapInput): ZapQuote {
  const { reserve: r, stake } = input;
  const slippageBps = input.slippageBps ?? ZAP_SLIPPAGE_BPS;
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 100) throw new RangeError('slippage must be 1 to 100 bps');
  const blockers: ZapBlocker[] = [];

  const parShares = parRedeemableShares(r.supply, r);
  const parCook = claimOf(parShares, r);
  const maxShares = parRedeemableShares(input.walletShares, r);
  const maxCook = claimOf(maxShares, r);

  let sharesIn = input.shares < 0n ? 0n : input.shares;
  let cappedBy: ZapQuote['cappedBy'] = null;
  if (sharesIn > input.walletShares) {
    sharesIn = input.walletShares;
    cappedBy = 'wallet';
  }
  if (sharesIn > maxShares) {
    sharesIn = maxShares;
    cappedBy = 'liquidity';
  }

  const cookOut = claimOf(sharesIn, r);
  const bcookOut = cookOut > 0n ? poolTokensForDeposit(cookOut, stake) : 0n;
  const minBcookOut = (bcookOut * BigInt(10_000 - slippageBps)) / 10_000n;
  const back = bcookOut > 0n ? lamportsForWithdrawal(bcookOut, stake) : 0n;

  if (input.walletShares === 0n || input.shares === 0n) blockers.push('no-shares');
  if (r.paused) blockers.push('paused');
  else if (maxShares === 0n && input.walletShares > 0n) blockers.push('no-liquidity');
  if (input.epoch !== null && stake.lastUpdateEpoch !== input.epoch) blockers.push('pool-stale');
  if (stake.solDepositAuthority) blockers.push('pool-restricted');
  if (sharesIn > 0n && minBcookOut === 0n) blockers.push('too-small');
  if (input.walletNativeCook != null && input.walletNativeCook < ZAP_MIN_NATIVE_COOK) blockers.push('wallet-fees');

  return {
    sharesRequested: input.shares,
    sharesIn,
    cappedBy,
    maxShares,
    maxCook,
    parShares,
    parCook,
    cookOut,
    stakeLamports: cookOut,
    bcookOut,
    minBcookOut,
    slippageBps,
    cookPerBcookE9: (stake.totalLamports * 1_000_000_000n) / stake.poolTokenSupply,
    depositFeeBps: feeBps(stake.solDepositFee),
    withdrawalFeeBps: feeBps(stake.solWithdrawalFee),
    roundTripCookBack: back,
    roundTripCostPct: cookOut > 0n ? Number(((cookOut - back) * 1_000_000n) / cookOut) / 10_000 : 0,
    blockers,
  };
}

/**
 * The aCOOK whose redemption stakes into at least `bcookRaw` bCOOK, with one
 * unit of headroom for rounding; for a caller that knows the bCOOK it is short of.
 */
export function zapSharesForBcook(bcookRaw: bigint, stake: StakePoolState, reserve: ZapReserveInput): bigint {
  if (bcookRaw <= 0n || reserve.total === 0n) return 0n;
  // Fewest COOK whose deposit mints bcookRaw.
  let high = (bcookRaw * stake.totalLamports) / stake.poolTokenSupply + 1n;
  for (let i = 0; poolTokensForDeposit(high, stake) < bcookRaw; i += 1) {
    if (i === 64) return 0n;
    high *= 2n;
  }
  let low = 0n;
  while (high - low > 1n) {
    const mid = (low + high) / 2n;
    if (poolTokensForDeposit(mid, stake) >= bcookRaw) high = mid;
    else low = mid;
  }
  // Fewest aCOOK whose claim covers those COOK.
  return (high * reserve.supply + reserve.total - 1n) / reserve.total + 1n;
}

/** How many instructions `buildZapInstructions` returns, for a caller that labels them. */
export const ZAP_INSTRUCTION_COUNT = 6;

export interface ZapInstructionInput {
  client: AeraClient;
  owner: PublicKey;
  quote: Pick<ZapQuote, 'sharesIn' | 'stakeLamports' | 'minBcookOut'>;
  stake: StakePoolState;
}

/**
 * The zap's instructions, in order, for ONE transaction:
 *
 *   1. create the wallet's wCOOK account if missing (Aera pays COOK out as wCOOK)
 *   2. Aera `accrue`, then `withdraw`: burn aCOOK, receive COOK
 *   3. close the wCOOK account: the COOK becomes the wallet's native balance
 *   4. create the wallet's bCOOK account if missing
 *   5. BakeYourStake `DepositSolWithSlippage`: stake exactly the redeemed COOK, minimum bCOOK enforced by the program
 *
 * Creating an account is idempotent, so a stale view of which accounts exist
 * cannot fail the transaction.
 */
export async function buildZapInstructions({ client, owner, quote, stake }: ZapInstructionInput): Promise<TransactionInstruction[]> {
  if (quote.sharesIn <= 0n || quote.stakeLamports <= 0n || quote.minBcookOut <= 0n) throw new Error('nothing to convert');
  if (!stake.poolMint.equals(new PublicKey(LAUNCH.chain.bcookMint))) throw new Error('not bCOOK’s stake pool');
  const reserve = client.reserveAddress(NATIVE_MINT);
  const bcookAccount = getAssociatedTokenAddressSync(stake.poolMint, owner, true, TOKEN_PROGRAM_ID);
  return [
    ensureAtaIx(owner, NATIVE_MINT),
    await client.accrueIx(reserve),
    await client.withdrawIx(owner, NATIVE_MINT, quote.sharesIn),
    unwrapNativeIx(owner),
    createAssociatedTokenAccountIdempotentInstruction(owner, bcookAccount, owner, stake.poolMint, TOKEN_PROGRAM_ID),
    withStakingMinimum(depositSolIx({ pool: stake, depositor: owner, lamports: quote.stakeLamports }), 'stake', quote.minBcookOut),
  ];
}

export interface PreparedZap {
  quote: ZapQuote;
  /** Empty while `quote.blockers` is not. */
  instructions: TransactionInstruction[];
  slot: bigint;
  epoch: bigint;
  /** Unix ms after which the prepared zap must be rebuilt. */
  expiresAt: number;
  walletShares: bigint;
  walletNativeCook: bigint;
  /** The stake pool's own state, for the reverse path. */
  stake: StakePoolState;
  /** COOK the pool's reserve can pay out now (the bCOOK exit's real limit). */
  stakeWithdrawable: bigint;
}

/**
 * Read everything the zap depends on, price it, and build its instructions.
 * Reads only; nothing is signed or sent.
 */
export async function prepareAcookZap(
  connection: Connection,
  owner: PublicKey,
  shares: bigint,
  options: { slippageBps?: number; client?: AeraClient; now?: number } = {},
): Promise<PreparedZap> {
  if ((await connection.getGenesisHash()) !== LAUNCH.chain.genesis) throw new Error('Wrong chain');
  const client = options.client ?? new AeraClient({ connection });
  const [portfolio, poolAccount, epochInfo, balance] = await Promise.all([
    readReceiptPortfolio(connection, owner),
    connection.getAccountInfo(BCOOK_STAKE_POOL, 'confirmed'),
    connection.getEpochInfo('confirmed'),
    connection.getBalance(owner, 'confirmed'),
  ]);
  const receipt = portfolio.receipts.find((r): r is ReceiptBalance => r.symbol === 'aCOOK');
  if (!receipt) throw new Error('The COOK receipt is not readable.');
  if (!poolAccount?.owner.equals(STAKE_POOL_PROGRAM_ID)) throw new Error('Stake pool identity changed');
  const stake = decodeStakePool(BCOOK_STAKE_POOL, poolAccount.data, poolAccount.owner);
  if (stake.poolMint.toBase58() !== LAUNCH.chain.bcookMint || !stake.tokenProgram.equals(TOKEN_PROGRAM_ID)) throw new Error('Stake pool mint changed');
  const reserveStake = await connection.getAccountInfo(stake.reserveStake, 'confirmed');
  const stakeWithdrawable = reserveStake ? withdrawableLamports(reserveStake) : 0n;

  const epoch = BigInt(epochInfo.epoch);
  const quote = zapQuote({
    shares,
    walletShares: BigInt(receipt.unlockedShares),
    reserve: { available: BigInt(receipt.reserveAvailable), total: BigInt(receipt.reserveTotal), supply: BigInt(receipt.shareSupply), paused: receipt.redemptionPaused },
    stake,
    epoch,
    walletNativeCook: BigInt(balance),
    slippageBps: options.slippageBps,
  });
  const instructions = quote.blockers.length === 0 ? await buildZapInstructions({ client, owner, quote, stake }) : [];
  return {
    quote,
    instructions,
    slot: BigInt(portfolio.slot),
    epoch,
    expiresAt: (options.now ?? Date.now()) + ZAP_QUOTE_TTL_MS,
    walletShares: BigInt(receipt.unlockedShares),
    walletNativeCook: BigInt(balance),
    stake,
    stakeWithdrawable,
  };
}

// ---------------------------------------------------------------------------
// The way back: bCOOK to COOK
// ---------------------------------------------------------------------------

export interface ReverseQuote {
  bcookIn: bigint;
  cookOut: bigint;
  /** The pool's SOL-withdrawal fee, read from the pool. */
  feeBps: number;
  /** Most bCOOK the pool's reserve can pay out now, or null when unread. */
  maxBcook: bigint | null;
  /** True when `bcookIn` is more than the reserve can pay now. */
  exceedsReserve: boolean;
}

/** What redeeming `bcookIn` for COOK pays at BakeYourStake, and whether its reserve can pay it now. */
export function bcookToCookQuote(bcookIn: bigint, stake: StakePoolState, withdrawable: bigint | null): ReverseQuote {
  const cookOut = bcookIn > 0n ? lamportsForWithdrawal(bcookIn, stake) : 0n;
  let maxBcook: bigint | null = null;
  if (withdrawable !== null) {
    let t = poolTokensForLamports(withdrawable, stake) ?? 0n;
    while (t > 0n && lamportsForWithdrawal(t, stake) > withdrawable) t -= 1n;
    maxBcook = t;
  }
  return { bcookIn, cookOut, feeBps: feeBps(stake.solWithdrawalFee), maxBcook, exceedsReserve: withdrawable !== null && cookOut > withdrawable };
}
