import { PublicKey } from '@solana/web3.js';

import { AERA_PROGRAM_ID, SEED } from './constants.js';

/**
 * PDA derivation.
 *
 * Everything here works in `Uint8Array`, never `Buffer`: `Buffer` is a Node
 * global and the SDK has to run in a browser unchanged. `PublicKey.toBytes()`
 * is used rather than `.toBuffer()` for the same reason.
 */

const derive = (seeds: Uint8Array[], programId = AERA_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync(seeds, programId)[0];

/** A u64 as 8 little-endian bytes, matching Rust's `to_le_bytes()`. */
const u64le = (value: number | bigint): Uint8Array => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
  return bytes;
};

/** `["global"]` — one per deployment. */
export const globalPda = (programId?: PublicKey) => derive([SEED.global], programId);

/** `["market", market_id]` — a market is keyed by its id, not by any individual. */
export const marketPda = (marketId: number | bigint, programId?: PublicKey) =>
  derive([SEED.market, u64le(marketId)], programId);

/** `["reserve", market, liquidity_mint]` */
export const reservePda = (market: PublicKey, liquidityMint: PublicKey, programId?: PublicKey) =>
  derive([SEED.reserve, market.toBytes(), liquidityMint.toBytes()], programId);

/** `["liquidity_vault", reserve]` — the reserve PDA is its authority. */
export const liquidityVaultPda = (reserve: PublicKey, programId?: PublicKey) =>
  derive([SEED.liquidityVault, reserve.toBytes()], programId);

/** `["share_mint", reserve]` — aCOOK for the COOK reserve. */
export const shareMintPda = (reserve: PublicKey, programId?: PublicKey) =>
  derive([SEED.shareMint, reserve.toBytes()], programId);

/** `["obligation", market, owner]` */
export const obligationPda = (market: PublicKey, owner: PublicKey, programId?: PublicKey) =>
  derive([SEED.obligation, market.toBytes(), owner.toBytes()], programId);

/** `["obligation_share_vault", reserve, obligation]` */
export const obligationShareVaultPda = (
  reserve: PublicKey,
  obligation: PublicKey,
  programId?: PublicKey,
) => derive([SEED.obligationShareVault, reserve.toBytes(), obligation.toBytes()], programId);


/** `["supply_position", reserve, owner]` — per-wallet cap accounting. */
/**
 * The `OracleState` for one mint in one market.
 *
 * Seeded `["oracle", market, mint]`, replacing v0.1's `["price_feed", ...]`.
 * The seed changed with the account type, so a v0.1 feed and a v0.2 oracle for
 * the same mint live at different addresses and neither can be mistaken for the
 * other.
 */
export const oraclePda = (market: PublicKey, mint: PublicKey, programId?: PublicKey) =>
  derive([SEED.oracle, market.toBytes(), mint.toBytes()], programId);

/**
 * The observation history for a Tier 3 market-priced oracle.
 *
 * Seeded on the `OracleState` address, not the mint: `OracleState` is one shape
 * for all three source kinds, and the pools and thresholds a market oracle
 * needs hang off it separately. That is what lets a Tier 3 asset be added
 * without touching any Core account.
 */
export const marketOraclePda = (oracle: PublicKey, programId?: PublicKey) =>
  derive([SEED.marketOracle, oracle.toBytes()], programId);

/**
 * A reserve's post-v0.2 risk limits: the per-wallet borrow cap and Aera's share
 * of that reserve's liquidation bonus.
 *
 * Seeded `["risk_config", reserve]`. The account is optional -- a reserve with
 * no limits simply has none created, and both `borrow` and `liquidate` read the
 * uncreated address as "no limit, no share". The address is still always passed,
 * so a caller cannot evade either by omitting it.
 */
export const riskConfigPda = (reserve: PublicKey, programId?: PublicKey) =>
  derive([SEED.riskConfig, reserve.toBytes()], programId);

export const supplyPositionPda = (reserve: PublicKey, owner: PublicKey, programId?: PublicKey) =>
  derive([SEED.supplyPosition, reserve.toBytes(), owner.toBytes()], programId);
