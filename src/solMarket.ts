/** The isolated SOL pilot. Core keeps its own market and accounting. */
import { PublicKey } from '@solana/web3.js';
import { AeraClient } from './client.js';
import { LAUNCH_CONFIG } from './params.js';
import { accrueReserve, currentBorrowedAmount, totalLiquidityOf, borrowRateBpsOf } from './projection.js';
import { supplyRateBps } from './math.js';
import type { ReserveAccount } from './types.js';

export const SOL_MARKET_ID = 1;
export const BRIDGED_SOL_MINT = new PublicKey('6tL24Fn75uCMrBSZAvohAq57LSv6KrY6ceEq1wonvucb');
export const ASOL_MINT = new PublicKey('FHv5bDrikq9sA4ckNNTsvqZHGoWYSnPMFJC8xHszKwbq');
export const SOL_MARKET_COOK_MINT = new PublicKey('So11111111111111111111111111111111111111112');

export interface SolReserveStatus {
  address: string; mint: string; shareMint: string; symbol: string; decimals: number;
  available: string; borrowed: string; total: string; shareSupply: string;
  supplyCap: string; perWalletSupplyCap: string; borrowCap: string;
  borrowEnabled: boolean; collateralEnabled: boolean; supplyAprBps: number; borrowAprBps: number;
  reserveFactorBps: number;
  /**
   * The reserve's own compounding divisor. `supplyAprBps` and `borrowAprBps`
   * are nominal annual rates the program divides by this and accrues every
   * slot, so a screen that labels them APY cannot compound them without it.
   */
  slotsPerYear: string;
  /** Unix seconds from which the queued config may be applied; null with nothing queued. */
  pendingEta: string | null;
  /**
   * What the queued config sets, so a screen can state the change rather than
   * only its date. Both are the stored pending values and mean nothing while
   * `pendingEta` is null.
   */
  pendingBorrowEnabled: boolean; pendingBorrowCap: string;
}
export interface SolMarketStatus {
  marketId: 1; market: string; name: string; slot: string; observedAt: string;
  paused: boolean; borrowPaused: boolean; sol: SolReserveStatus; cook: SolReserveStatus;
  oracleHealth: number; oracleLastRefreshSlot: string;
  /** Pilot status is deliberate; oracle bootstrap alone is not launch approval. */
  phase: 'pilot'; stakingYieldEnabled: false;
  wallet: null | { owner: string; sol: string; gasCOOK: string; aSOL: string; suppliedSOL: string; redeemableSOL: string };
}
export function solReserveStatus(reserve: ReserveAccount, symbol: string, slot: bigint): SolReserveStatus {
  const r = accrueReserve(reserve, slot);
  return { address: r.address.toBase58(), mint: r.liquidityMint.toBase58(), shareMint: r.shareMint.toBase58(),
    symbol, decimals: r.liquidityDecimals, available: r.availableLiquidity.toString(),
    borrowed: currentBorrowedAmount(r).toString(), total: totalLiquidityOf(r).toString(), shareSupply: r.shareMintSupply.toString(),
    supplyCap: r.config.supplyCap.toString(), perWalletSupplyCap: r.config.perWalletSupplyCap.toString(), borrowCap: r.config.borrowCap.toString(),
    borrowEnabled: r.config.borrowEnabled, collateralEnabled: r.config.collateralEnabled,
    supplyAprBps: Number(supplyRateBps(r)), borrowAprBps: Number(borrowRateBpsOf(r)), reserveFactorBps: r.config.reserveFactorBps,
    slotsPerYear: r.config.slotsPerYear.toString(),
    pendingEta: r.pending.eta > 0n ? r.pending.eta.toString() : null,
    pendingBorrowEnabled: r.pending.config.borrowEnabled, pendingBorrowCap: r.pending.config.borrowCap.toString() };
}
export async function readSolMarket(client: AeraClient, owner?: PublicKey | null): Promise<SolMarketStatus> {
  if (client.marketId !== SOL_MARKET_ID) throw new Error('SOL status requires market 1');
  if (await client.connection.getGenesisHash() !== LAUNCH_CONFIG.chain.genesis) throw new Error('Wrong chain');
  // readAtSlot's field names describe Core roles; explicit mints select the SOL
  // reserve as the supplied asset. All balances and economic data share a slot.
  const read = await client.readAtSlot({ cookMint: BRIDGED_SOL_MINT, bcookMint: SOL_MARKET_COOK_MINT, owner });
  if (!read.programExecutable || !read.global || !read.market || !read.cookReserve || !read.bcookReserve || !read.cookOracle) throw new Error('SOL market is unavailable');
  if (!read.cookReserve.shareMint.equals(ASOL_MINT)) throw new Error('Unexpected aSOL mint');
  const sol = solReserveStatus(read.cookReserve, 'SOL', BigInt(read.slot));
  const cook = solReserveStatus(read.bcookReserve, 'COOK', BigInt(read.slot));
  const shares = read.balances.acook;
  const claim = BigInt(sol.shareSupply) === 0n ? 0n : shares * BigInt(sol.total) / BigInt(sol.shareSupply);
  return { marketId: 1, market: client.market.toBase58(), name: read.market.name, slot: String(read.slot), observedAt: new Date().toISOString(),
    paused: read.global.paused, borrowPaused: read.global.borrowPaused, sol, cook,
    oracleHealth: read.cookOracle.health, oracleLastRefreshSlot: read.cookOracle.lastRefreshSlot.toString(),
    phase: 'pilot', stakingYieldEnabled: false,
    wallet: owner ? { owner: owner.toBase58(), sol: read.balances.cook.toString(), gasCOOK: read.balances.native.toString(),
      aSOL: shares.toString(), suppliedSOL: (read.supplyPosition?.suppliedLiquidity ?? 0n).toString(), redeemableSOL: claim.toString() } : null };
}
