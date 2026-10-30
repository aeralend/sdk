/**
 * Permissionless creator markets, from an app's or a keeper's point of view.
 *
 * `isolatedMarkets.ts` is the byte-level layer: layouts, PDAs, one builder per
 * instruction, no network. This module sits on top of it and on top of
 * `AeraClient`, and answers the questions a frontend and a keeper ask:
 *
 * - which creator markets exist, and what can each lend right now
 *   ({@link listIsolatedMarkets}, {@link isolatedMarketView});
 * - how a creator opens one ({@link buildCreateIsolatedMarket});
 * - how a lender supplies, a borrower borrows, and a creator is paid
 *   ({@link IsolatedMarketClient});
 * - which loans the bond should cover, and how to cover them so the creator
 *   cannot block it ({@link classifyCover}, {@link IsolatedMarketClient.coverIxs}).
 *
 * Every write returns unsigned instructions or an unsigned `Transaction`; the
 * caller signs. Nothing here holds a key.
 *
 * Two rules from the program that every caller must respect, restated where
 * they bite:
 *
 * 1. A creator market's token oracle is refreshed by `refresh_isolated_oracle`,
 *    never `refresh_market_oracle`. Bundled with other instructions (as in
 *    {@link IsolatedMarketClient.preludeIxs}) it keeps the oracle fresh but
 *    records nothing; only a transaction holding nothing but ComputeBudget and
 *    isolated refreshes records a sample ({@link IsolatedMarketClient.standaloneRefreshIxs}).
 * 2. Bridged SOL on Cookie Chain is a Token-2022 mint. Token programs are read
 *    from each mint's owner, never assumed.
 */
import {
  ACCOUNT_SIZE,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeAccount3Instruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type Connection,
  type TransactionInstruction,
} from '@solana/web3.js';

import { AeraClient } from './client.js';
import { AERA_PROGRAM_ID } from './constants.js';
import { decodeObligation } from './decode.js';
import {
  ISOLATED_DISCRIMINATOR,
  ISOLATED_ORACLE_DEAD_SECONDS,
  ISOLATED_TIERS,
  STAGE_ACTIVE,
  bondCap,
  computeUnitLimitIx,
  coverIsolatedDebtIx,
  createIsolatedMarketIx,
  decodeIsolatedConfig,
  decodeIsolatedMarket,
  decodeIsolatedOracle,
  harvestCreatorFeesIx,
  initIsolatedCollateralReserveIx,
  initIsolatedQuoteReserveIx,
  isolatedBorrowCap,
  isolatedConfigPda,
  isolatedMarketAddresses,
  isolatedMarketPda,
  refreshIsolatedOracleFromAccount,
  retireIsolatedMarketIx,
  syncIsolatedAmmPinsIx,
  syncIsolatedCapsIx,
  topUpBondIx,
  withdrawBondIx,
  withdrawableBond,
  type IsolatedConfigAccount,
  type IsolatedMarketAccount,
  type IsolatedObservation,
  type IsolatedOracleAccount,
  type IsolatedTier,
} from './isolatedMarkets.js';
import { marketPda, obligationPda, obligationShareVaultPda, reservePda, shareMintPda } from './pda.js';
import { currentBorrowedAmount, liquidityToSharesDown, sharesToLiquidityDown, marketValueOf } from './projection.js';
import type { ObligationAccount, ReserveAccount } from './types.js';

// --- discovery -----------------------------------------------------------------

/** `8 + IsolatedMarket::INIT_SPACE`. Pinned by `test/isolated-markets.test.ts`. */
export const ISOLATED_MARKET_ACCOUNT_SIZE = 424;
/** Byte offsets of the fields a listing filters on (discriminator included). */
export const ISOLATED_MARKET_OFFSETS = { creator: 48, tokenMint: 80 } as const;

/** `sha256("account:Obligation")[..8]`; an obligation's market follows it. */
export const OBLIGATION_DISCRIMINATOR = [168, 206, 141, 106, 88, 76, 172, 167] as const;

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Base58, for `memcmp` filters on bytes that are not a public key. */
export function base58Encode(bytes: Uint8Array | readonly number[]): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

export interface IsolatedMarketListing extends IsolatedMarketAccount {
  /** The `IsolatedMarket` account itself (not the `Market`). */
  address: PublicKey;
}

export async function fetchIsolatedConfig(
  connection: Connection,
  programId: PublicKey = AERA_PROGRAM_ID,
): Promise<(IsolatedConfigAccount & { address: PublicKey }) | null> {
  const address = isolatedConfigPda(programId);
  const info = await connection.getAccountInfo(address, 'confirmed');
  if (!info || !info.owner.equals(programId)) return null;
  return { address, ...decodeIsolatedConfig(info.data) };
}

/**
 * Every creator market, oldest first. Filter by creator or token to show "my
 * markets" or "markets for this token" -- any number of markets may exist per
 * token, and the app must show who created each one.
 */
export async function listIsolatedMarkets(
  connection: Connection,
  filter: { creator?: PublicKey; tokenMint?: PublicKey; programId?: PublicKey } = {},
): Promise<IsolatedMarketListing[]> {
  const programId = filter.programId ?? AERA_PROGRAM_ID;
  const filters: Array<{ dataSize: number } | { memcmp: { offset: number; bytes: string } }> = [
    { dataSize: ISOLATED_MARKET_ACCOUNT_SIZE },
    { memcmp: { offset: 0, bytes: base58Encode(ISOLATED_DISCRIMINATOR.IsolatedMarket) } },
  ];
  if (filter.creator) filters.push({ memcmp: { offset: ISOLATED_MARKET_OFFSETS.creator, bytes: filter.creator.toBase58() } });
  if (filter.tokenMint) filters.push({ memcmp: { offset: ISOLATED_MARKET_OFFSETS.tokenMint, bytes: filter.tokenMint.toBase58() } });
  const raw = await connection.getProgramAccounts(programId, { commitment: 'confirmed', filters });
  const out: IsolatedMarketListing[] = [];
  for (const { pubkey, account } of raw) {
    try {
      const decoded = decodeIsolatedMarket(account.data);
      // Only the canonical PDA counts: a decodable account elsewhere is not a market.
      if (!isolatedMarketPda(decoded.market, programId).equals(pubkey)) continue;
      out.push({ address: pubkey, ...decoded });
    } catch {
      // Not an IsolatedMarket after all.
    }
  }
  return out.sort((a, b) => (a.marketId < b.marketId ? -1 : a.marketId > b.marketId ? 1 : 0));
}

/** One creator market by its `Market` address or its market id. */
export async function fetchIsolatedMarket(
  connection: Connection,
  market: PublicKey | bigint,
  programId: PublicKey = AERA_PROGRAM_ID,
): Promise<IsolatedMarketListing | null> {
  const marketAddress = typeof market === 'bigint' ? marketPda(market, programId) : market;
  const address = isolatedMarketPda(marketAddress, programId);
  const info = await connection.getAccountInfo(address, 'confirmed');
  if (!info || !info.owner.equals(programId)) return null;
  return { address, ...decodeIsolatedMarket(info.data) };
}

export async function fetchIsolatedOracle(
  connection: Connection,
  address: PublicKey,
  programId: PublicKey = AERA_PROGRAM_ID,
): Promise<IsolatedOracleAccount | null> {
  const info = await connection.getAccountInfo(address, 'confirmed');
  if (!info || !info.owner.equals(programId)) return null;
  return decodeIsolatedOracle(info.data);
}

// --- what a market can do right now ----------------------------------------------

export interface IsolatedMarketView {
  tier: IsolatedTier;
  /** What may be outstanding: `min(depth cap, 80% of bond)`. */
  borrowCap: bigint;
  /** Per wallet: `min(depth wallet cap, borrowCap)`. */
  walletCap: bigint;
  /** 80% of the bond. */
  bondCap: bigint;
  /** Mirrors `IsolatedMarket::borrowing_open`. The oracle must also be healthy. */
  borrowingOpen: boolean;
  /** Enough spaced, recorded observations for the oracle to price at all. */
  oracleBootstrapped: boolean;
  lastObservation: IsolatedObservation | null;
  /** When `cover_isolated_debt`'s dead-oracle case opens, unix seconds. */
  oracleDeadAt: bigint | null;
}

export function latestObservation(oracle: IsolatedOracleAccount): IsolatedObservation | null {
  let latest: IsolatedObservation | null = null;
  for (const o of oracle.observations) if (!latest || o.unixTimestamp > latest.unixTimestamp) latest = o;
  return latest;
}

export function isolatedMarketView(market: IsolatedMarketAccount, oracle: IsolatedOracleAccount): IsolatedMarketView {
  const tier = ISOLATED_TIERS[market.tier];
  if (!tier) throw new Error(`unknown tier ${market.tier}`);
  const borrowCap = isolatedBorrowCap(market);
  const walletCap = market.depthWalletCap < borrowCap ? market.depthWalletCap : borrowCap;
  const latest = latestObservation(oracle);
  const times = oracle.observations.map((o) => o.unixTimestamp);
  const span = times.length ? times.reduce((a, b) => (a > b ? a : b)) - times.reduce((a, b) => (a < b ? a : b)) : 0n;
  return {
    tier,
    borrowCap,
    walletCap,
    bondCap: bondCap(market.bondAmount),
    borrowingOpen: market.stage === STAGE_ACTIVE && !market.frozen && !market.retired && borrowCap > 0n,
    oracleBootstrapped:
      oracle.observations.length >= oracle.config.minObservations && span >= BigInt(oracle.config.minSpanSeconds),
    lastObservation: latest,
    oracleDeadAt: latest ? latest.unixTimestamp + ISOLATED_ORACLE_DEAD_SECONDS : null,
  };
}

// --- listing checks the app can run before asking for a signature -----------------

export type ListingMintCheck = { ok: true; decimals: number } | { ok: false; reason: string };

/**
 * The program's `validate_listing_mint`, restated so the app can refuse a
 * token before the creator pays for a failed transaction. The program remains
 * the authority; this is a preview.
 */
export function checkListingMint(owner: PublicKey, data: Uint8Array): ListingMintCheck {
  const legacy = owner.equals(TOKEN_PROGRAM_ID);
  if (!legacy && !owner.equals(TOKEN_2022_PROGRAM_ID)) return { ok: false, reason: 'not owned by a token program' };
  if (data.length < 82) return { ok: false, reason: 'not a mint' };
  const u32 = (at: number) => data[at]! | (data[at + 1]! << 8) | (data[at + 2]! << 16) | (data[at + 3]! << 24);
  if (u32(0) !== 0) return { ok: false, reason: 'the mint authority is live: supply can be printed' };
  if (data[45] !== 1) return { ok: false, reason: 'the mint is not initialised' };
  if (u32(46) !== 0) return { ok: false, reason: 'the mint has a freeze authority' };
  const decimals = data[44]!;
  if (decimals > 12) return { ok: false, reason: 'more than 12 decimals' };
  if (legacy) return data.length === 82 ? { ok: true, decimals } : { ok: false, reason: 'malformed legacy mint' };
  if (data.length === 82) return { ok: true, decimals };
  if (data.length < 166 || data[165] !== 1) return { ok: false, reason: 'malformed Token-2022 mint' };
  let at = 166;
  while (at < data.length) {
    if (data.subarray(at).every((b) => b === 0)) break;
    if (at + 4 > data.length) return { ok: false, reason: 'malformed extension list' };
    const kind = data[at]! | (data[at + 1]! << 8);
    const len = data[at + 2]! | (data[at + 3]! << 8);
    if (!(kind === 18 || kind === 19) || at + 4 + len > data.length) {
      return { ok: false, reason: `Token-2022 extension ${kind} is not allowed (only metadata is)` };
    }
    at += 4 + len;
  }
  return { ok: true, decimals };
}

// --- creating a market ---------------------------------------------------------------

export interface CreatorPool {
  pool: PublicKey;
  collateralVault: PublicKey;
  quoteVault: PublicKey;
  /** Index into `IsolatedConfig.amms`: which allowed AMM this pool is on. */
  ammIndex: number;
}

export interface CreateIsolatedMarketPlan {
  marketId: bigint;
  market: PublicKey;
  addresses: ReturnType<typeof isolatedMarketAddresses>;
  creationFee: bigint;
  /**
   * Send in order, each confirmed before the next: create (market, oracles,
   * bond), the token reserve, the SOL reserve. Three because together they
   * need more accounts than one transaction holds.
   */
  transactions: [Transaction, Transaction, Transaction];
}

/**
 * The creator flow. For a single-pool (Seed) market pass the same pool twice.
 *
 * The market id comes from the config's counter at build time; if another
 * market is created first, the create transaction fails cleanly
 * (address already in use / seeds mismatch) and should be rebuilt.
 */
export async function buildCreateIsolatedMarket(
  connection: Connection,
  p: {
    creator: PublicKey;
    tokenMint: PublicKey;
    tier: number;
    bond: bigint;
    pools: [CreatorPool, CreatorPool];
    programId?: PublicKey;
  },
): Promise<CreateIsolatedMarketPlan> {
  const programId = p.programId ?? AERA_PROGRAM_ID;
  const config = await fetchIsolatedConfig(connection, programId);
  if (!config) throw new Error('creator markets are not initialised on this deployment');
  if (!config.creationEnabled) throw new Error('creator-market creation is switched off');
  const tier = ISOLATED_TIERS[p.tier];
  if (!tier) throw new Error(`unknown tier ${p.tier}`);
  if (tier.requiresTwoPools && p.pools[0].pool.equals(p.pools[1].pool)) {
    throw new Error(`${tier.name} needs two distinct pools`);
  }
  const [tokenInfo, quoteInfo] = await connection.getMultipleAccountsInfo([p.tokenMint, config.quoteMint], 'confirmed');
  if (!tokenInfo || !quoteInfo) throw new Error('token or quote mint not found');
  const check = checkListingMint(tokenInfo.owner, tokenInfo.data);
  if (!check.ok) throw new Error(`this token cannot be listed: ${check.reason}`);

  const client = new AeraClient({ connection, programId });
  const global = await client.getGlobal();
  if (!global) throw new Error('no Global account');
  if (global.paused) throw new Error('the protocol is paused');
  const quoteProgram = quoteInfo.owner;
  const tokenProgram = tokenInfo.owner;

  const pins = config.amms;
  const pools = p.pools.map((choice) => {
    const pin = pins[choice.ammIndex];
    if (!pin || !pin.enabled) throw new Error(`AMM index ${choice.ammIndex} is not allowed`);
    return { ...choice, ammProgramData: pin.ammProgramData };
  }) as [CreatorPool & { ammProgramData: PublicKey }, CreatorPool & { ammProgramData: PublicKey }];

  const marketId = config.nextMarketId;
  const addresses = isolatedMarketAddresses(marketId, p.tokenMint, config.quoteMint, programId);
  const create = createIsolatedMarketIx({
    programId,
    global: global.address,
    creator: p.creator,
    nextMarketId: marketId,
    tokenMint: p.tokenMint,
    quoteMint: config.quoteMint,
    creatorQuote: getAssociatedTokenAddressSync(config.quoteMint, p.creator, true, quoteProgram),
    feeDestinationQuote: getAssociatedTokenAddressSync(config.quoteMint, global.feeDestination, true, quoteProgram),
    tier: p.tier,
    bond: p.bond,
    pools,
    quoteTokenProgram: quoteProgram,
  });
  const collateral = initIsolatedCollateralReserveIx({
    programId,
    creator: p.creator,
    market: addresses.market,
    tokenMint: p.tokenMint,
    tokenProgram,
  });
  const quote = initIsolatedQuoteReserveIx({
    programId,
    creator: p.creator,
    market: addresses.market,
    quoteMint: config.quoteMint,
    tokenProgram: quoteProgram,
  });
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const tx = (...ixs: TransactionInstruction[]) => {
    const t = new Transaction().add(computeUnitLimitIx(400_000), ...ixs);
    t.feePayer = p.creator;
    t.recentBlockhash = blockhash;
    return t;
  };
  return {
    marketId,
    market: addresses.market,
    addresses,
    creationFee: config.creationFee,
    transactions: [tx(create), tx(collateral), tx(quote)],
  };
}

// --- covering bad debt ---------------------------------------------------------------

export type CoverCase = 'noCollateral' | 'underwater' | 'oracleDead';

/**
 * Which `cover_isolated_debt` case a loan would qualify for, judged off chain
 * from the program's own rules. `underwater` is an estimate at the oracle's
 * current reference: send it with the prelude and simulate first, because the
 * program re-values the position in the same transaction and has the last
 * word. `null` means the loan is not the bond's to pay.
 */
export function classifyCover(p: {
  obligation: ObligationAccount;
  quoteReserve: ReserveAccount;
  tokenReserve: ReserveAccount;
  oracle: IsolatedOracleAccount;
  /** The token oracle's accepted reference, 1e18-scaled quote per whole token. */
  tokenPrice: bigint;
  nowUnix: bigint;
}): CoverCase | null {
  const borrow = p.obligation.borrows.find((b) => b.reserve.equals(p.quoteReserve.address));
  if (!borrow || borrow.borrowedPrincipal === 0n) return null;
  const deposit = p.obligation.deposits.find((d) => d.reserve.equals(p.tokenReserve.address));
  const shares = deposit?.depositedShares ?? 0n;
  if (shares === 0n) return 'noCollateral';
  const debt = (borrow.borrowedPrincipal * p.quoteReserve.borrowIndex + 10n ** 18n - 1n) / 10n ** 18n;
  const collateral = sharesToLiquidityDown(p.tokenReserve, shares);
  const deposited = marketValueOf(collateral, p.tokenReserve.liquidityDecimals, p.tokenPrice, 'down');
  const borrowed = marketValueOf(debt, p.quoteReserve.liquidityDecimals, 10n ** 18n, 'up');
  if (borrowed > 0n && deposited <= borrowed) return 'underwater';
  const latest = latestObservation(p.oracle);
  const last = latest?.unixTimestamp ?? 0n;
  if (p.nowUnix - last >= ISOLATED_ORACLE_DEAD_SECONDS) return 'oracleDead';
  return null;
}

// --- one market ----------------------------------------------------------------------

/**
 * A client for one creator market. Load it with {@link IsolatedMarketClient.load}.
 *
 * Wraps an {@link AeraClient} for the market id, for the instructions creator
 * markets share with every Aera market (supply, borrow, repay, ...), and
 * replaces the parts that differ: the oracle prelude and the creator's own
 * instructions.
 */
export class IsolatedMarketClient {
  private constructor(
    readonly connection: Connection,
    readonly programId: PublicKey,
    readonly account: IsolatedMarketListing,
    readonly oracle: IsolatedOracleAccount,
    /** The quote (SOL) mint's token program: Token-2022 for bridged SOL. */
    readonly quoteTokenProgram: PublicKey,
    /** The listed token's token program. */
    readonly tokenTokenProgram: PublicKey,
    readonly aera: AeraClient,
  ) {}

  static async load(
    connection: Connection,
    market: PublicKey | bigint,
    options: { programId?: PublicKey } = {},
  ): Promise<IsolatedMarketClient> {
    const programId = options.programId ?? AERA_PROGRAM_ID;
    const account = await fetchIsolatedMarket(connection, market, programId);
    if (!account) throw new Error('not a creator market');
    const [oracleInfo, quoteMint, tokenMint] = await connection.getMultipleAccountsInfo(
      [account.isolatedOracle, account.quoteMint, account.tokenMint],
      'confirmed',
    );
    if (!oracleInfo || !quoteMint || !tokenMint) throw new Error('creator market accounts missing');
    if (account.marketId > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('market id out of range');
    return new IsolatedMarketClient(
      connection,
      programId,
      account,
      decodeIsolatedOracle(oracleInfo.data),
      quoteMint.owner,
      tokenMint.owner,
      new AeraClient({ connection, programId, marketId: Number(account.marketId) }),
    );
  }

  /** The same market, re-read. */
  reload(): Promise<IsolatedMarketClient> {
    return IsolatedMarketClient.load(this.connection, this.account.market, { programId: this.programId });
  }

  get market(): PublicKey {
    return this.account.market;
  }

  get addresses() {
    return isolatedMarketAddresses(this.account.marketId, this.account.tokenMint, this.account.quoteMint, this.programId);
  }

  view(): IsolatedMarketView {
    return isolatedMarketView(this.account, this.oracle);
  }

  /** Bond the creator could withdraw now, given live debt. */
  async withdrawableBond(): Promise<bigint> {
    const reserve = await this.aera.getReserve(this.account.quoteMint);
    return withdrawableBond(this.account.bondAmount, reserve ? currentBorrowedAmount(reserve) : 0n);
  }

  // ----- oracle -----

  /** `refresh_isolated_oracle` as an instruction. Records only when sent alone. */
  refreshIx(): TransactionInstruction {
    return refreshIsolatedOracleFromAccount(this.oracle, this.programId);
  }

  /**
   * A transaction body that records a sample: the refresh and nothing else
   * but a compute-unit limit. Keepers send this every `minSpacingSeconds`.
   */
  standaloneRefreshIxs(): TransactionInstruction[] {
    return [computeUnitLimitIx(100_000), this.refreshIx()];
  }

  /**
   * What every value-reading action needs first, in one transaction: the
   * token oracle refreshed (bundled: fresh, records nothing), the SOL oracle
   * refreshed, and both reserves accrued.
   */
  async preludeIxs(): Promise<TransactionInstruction[]> {
    const a = this.addresses;
    return [
      this.refreshIx(),
      await this.aera.refreshOracleIx(this.account.quoteMint),
      await this.aera.accrueIx(a.tokenReserve),
      await this.aera.accrueIx(a.quoteReserve),
    ];
  }

  private quoteAta(owner: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(this.account.quoteMint, owner, true, this.quoteTokenProgram);
  }

  private shareAta(shareMint: PublicKey, owner: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(shareMint, owner, true, TOKEN_2022_PROGRAM_ID);
  }

  private ensureAta(payer: PublicKey, owner: PublicKey, mint: PublicKey, program: PublicKey): TransactionInstruction {
    return createAssociatedTokenAccountIdempotentInstruction(
      payer,
      getAssociatedTokenAddressSync(mint, owner, true, program),
      owner,
      mint,
      program,
    );
  }

  private async tx(payer: PublicKey, ixs: TransactionInstruction[], units = 600_000): Promise<Transaction> {
    const t = new Transaction().add(computeUnitLimitIx(units), ...ixs);
    t.feePayer = payer;
    t.recentBlockhash = (await this.connection.getLatestBlockhash('confirmed')).blockhash;
    return t;
  }

  // ----- lenders -----

  /** Supply SOL; receive the market's iSOL shares. */
  async supplyTx(owner: PublicKey, amount: bigint): Promise<Transaction> {
    const a = this.addresses;
    return this.tx(owner, [
      this.ensureAta(owner, owner, a.quoteShareMint, TOKEN_2022_PROGRAM_ID),
      await this.aera.accrueIx(a.quoteReserve),
      await this.aera.supplyIx(owner, this.account.quoteMint, amount),
    ]);
  }

  /** Burn iSOL shares for SOL. */
  async withdrawTx(owner: PublicKey, shares: bigint): Promise<Transaction> {
    const a = this.addresses;
    return this.tx(owner, [
      this.ensureAta(owner, owner, this.account.quoteMint, this.quoteTokenProgram),
      await this.aera.accrueIx(a.quoteReserve),
      await this.aera.withdrawIx(owner, this.account.quoteMint, shares),
    ]);
  }

  // ----- borrowers -----

  /**
   * Post `tokenAmount` of the listed token as collateral: supply it to the
   * token reserve, open the obligation if needed, and lock the shares. One
   * transaction.
   */
  async openPositionTx(owner: PublicKey, tokenAmount: bigint): Promise<Transaction> {
    const a = this.addresses;
    const reserve = await this.aera.getReserve(this.account.tokenMint);
    if (!reserve) throw new Error('the token reserve does not exist yet');
    const shares = liquidityToSharesDown(reserve, tokenAmount);
    const ixs: TransactionInstruction[] = [
      this.ensureAta(owner, owner, a.tokenShareMint, TOKEN_2022_PROGRAM_ID),
      await this.aera.accrueIx(a.tokenReserve),
      await this.aera.supplyIx(owner, this.account.tokenMint, tokenAmount),
    ];
    const existing = await this.connection.getAccountInfo(obligationPda(this.market, owner, this.programId), 'confirmed');
    if (!existing) ixs.push(await this.aera.initObligationIx(owner));
    ixs.push(await this.aera.depositCollateralIx(owner, this.account.tokenMint, shares));
    return this.tx(owner, ixs);
  }

  private async obligationOf(owner: PublicKey): Promise<ObligationAccount> {
    const obligation = await this.aera.getObligation(owner);
    if (!obligation) throw new Error('no position in this market; open one first');
    return obligation;
  }

  /** Borrow SOL against posted collateral. */
  async borrowTx(owner: PublicKey, amount: bigint): Promise<Transaction> {
    const obligation = await this.obligationOf(owner);
    return this.tx(owner, [
      this.ensureAta(owner, owner, this.account.quoteMint, this.quoteTokenProgram),
      ...(await this.preludeIxs()),
      await this.aera.refreshObligationIx(obligation),
      await this.aera.borrowIx(owner, this.account.quoteMint, amount),
    ]);
  }

  /** Repay SOL. `amount = 2^64 - 1` repays in full. Anyone may repay for a position. */
  async repayTx(repayer: PublicKey, amount: bigint, onBehalfOf?: PublicKey): Promise<Transaction> {
    return this.tx(repayer, [
      await this.aera.accrueIx(this.addresses.quoteReserve),
      await this.aera.repayIx(repayer, this.account.quoteMint, amount, onBehalfOf),
    ]);
  }

  /** Unlock collateral shares (with no debt this needs no price at all). */
  async withdrawCollateralTx(owner: PublicKey, shares: bigint): Promise<Transaction> {
    const obligation = await this.obligationOf(owner);
    return this.tx(owner, [
      this.ensureAta(owner, owner, this.addresses.tokenShareMint, TOKEN_2022_PROGRAM_ID),
      ...(await this.preludeIxs()),
      await this.aera.refreshObligationIx(obligation),
      await this.aera.withdrawCollateralIx(owner, this.account.tokenMint, shares),
    ]);
  }

  // ----- the creator -----

  /**
   * Mint the creator their fee as iSOL shares. Permissionless: anyone can pay
   * for it and it can only pay the creator. Fails with `NothingToHarvest`
   * when there is no new gain.
   */
  async harvestCreatorFeesTx(payer: PublicKey): Promise<Transaction> {
    return this.tx(payer, await this.harvestCreatorFeesIxs(payer));
  }

  async harvestCreatorFeesIxs(payer: PublicKey): Promise<TransactionInstruction[]> {
    const a = this.addresses;
    return [
      this.ensureAta(payer, this.account.creator, a.quoteShareMint, TOKEN_2022_PROGRAM_ID),
      await this.aera.accrueIx(a.quoteReserve),
      harvestCreatorFeesIx({
        programId: this.programId,
        market: this.market,
        quoteMint: this.account.quoteMint,
        creatorShareAccount: this.shareAta(a.quoteShareMint, this.account.creator),
      }),
    ];
  }

  async topUpBondTx(creator: PublicKey, amount: bigint): Promise<Transaction> {
    return this.tx(creator, [
      topUpBondIx({
        programId: this.programId,
        creator,
        market: this.market,
        quoteMint: this.account.quoteMint,
        creatorQuote: this.quoteAta(creator),
        quoteTokenProgram: this.quoteTokenProgram,
        amount,
      }),
    ]);
  }

  /** Refused below 125% of live debt, and while the protocol is paused. */
  async withdrawBondTx(creator: PublicKey, amount: bigint): Promise<Transaction> {
    return this.tx(creator, [
      this.ensureAta(creator, creator, this.account.quoteMint, this.quoteTokenProgram),
      await this.aera.accrueIx(this.addresses.quoteReserve),
      withdrawBondIx({
        programId: this.programId,
        creator,
        market: this.market,
        quoteMint: this.account.quoteMint,
        creatorQuote: this.quoteAta(creator),
        quoteTokenProgram: this.quoteTokenProgram,
        amount,
      }),
    ]);
  }

  /** Stop new borrowing for good. Irreversible. */
  async retireTx(creator: PublicKey): Promise<Transaction> {
    return this.tx(creator, [
      retireIsolatedMarketIx({ programId: this.programId, creator, market: this.market, quoteMint: this.account.quoteMint }),
    ]);
  }

  // ----- keepers -----

  syncCapsIx(): TransactionInstruction {
    return syncIsolatedCapsIx({
      programId: this.programId,
      market: this.market,
      tokenMint: this.account.tokenMint,
      quoteMint: this.account.quoteMint,
    });
  }

  syncPinsIx(): TransactionInstruction {
    return syncIsolatedAmmPinsIx({ programId: this.programId, market: this.market, tokenMint: this.account.tokenMint });
  }

  /**
   * `cover_isolated_debt` for one obligation, with what it needs in front.
   *
   * The bad loan's remaining collateral goes to the creator, into any token
   * account the creator owns for the collateral share mint. A creator who
   * would rather the bond stayed locked can make their own account refuse
   * plain transfers (Token-2022 required memos), so by default this pays into
   * a fresh account owned by the creator, created in the same transaction --
   * nothing the creator does beforehand can block it. Pass
   * `useCreatorAta: true` to pay their associated account instead.
   *
   * `withPrelude` is needed for the underwater case (the program re-values
   * the position in the same transaction); the no-collateral and dead-oracle
   * cases need only the SOL reserve accrued, which is always included.
   */
  async coverIxs(
    payer: PublicKey,
    obligation: PublicKey,
    options: {
      withPrelude?: boolean;
      /** An existing plain account the creator owns for the collateral share mint. */
      destination?: PublicKey;
      useCreatorAta?: boolean;
      rentLamports?: number;
    } = {},
  ): Promise<{ instructions: TransactionInstruction[]; signers: Keypair[]; destination: PublicKey }> {
    const a = this.addresses;
    const ixs: TransactionInstruction[] = [];
    const signers: Keypair[] = [];
    let destination: PublicKey;
    if (options.destination) {
      destination = options.destination;
    } else if (options.useCreatorAta) {
      destination = this.shareAta(a.tokenShareMint, this.account.creator);
      ixs.push(this.ensureAta(payer, this.account.creator, a.tokenShareMint, TOKEN_2022_PROGRAM_ID));
    } else {
      const payout = await this.creatorPayoutAccountIxs(payer, options.rentLamports);
      signers.push(payout.signer);
      destination = payout.address;
      ixs.push(...payout.instructions);
    }
    if (options.withPrelude) {
      const state = await this.aera.getObligationByAddress(obligation);
      if (!state) throw new Error('no such obligation');
      ixs.push(...(await this.preludeIxs()), await this.aera.refreshObligationIx(state));
    } else {
      ixs.push(await this.aera.accrueIx(a.quoteReserve));
    }
    ixs.push(
      coverIsolatedDebtIx({
        programId: this.programId,
        market: this.market,
        obligation,
        tokenMint: this.account.tokenMint,
        quoteMint: this.account.quoteMint,
        creatorCollateralAccount: destination,
        quoteTokenProgram: this.quoteTokenProgram,
      }),
    );
    return { instructions: ixs, signers, destination };
  }

  /**
   * A new, plain token account the creator owns for the collateral share
   * mint, paid for by `payer`. Inline in a cover transaction it cannot be
   * interfered with; the underwater case's full prelude does not leave room
   * for it in one packet when the market has two pools, so a keeper creates
   * it in a transaction of its own first and passes it as `destination`
   * (see {@link isPlainPayoutAccount} to check it is still usable).
   */
  async creatorPayoutAccountIxs(
    payer: PublicKey,
    rentLamports?: number,
  ): Promise<{ instructions: TransactionInstruction[]; signer: Keypair; address: PublicKey }> {
    const signer = Keypair.generate();
    const lamports = rentLamports ?? (await this.connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE));
    return {
      signer,
      address: signer.publicKey,
      instructions: [
        SystemProgram.createAccount({
          fromPubkey: payer,
          newAccountPubkey: signer.publicKey,
          lamports,
          space: ACCOUNT_SIZE,
          programId: TOKEN_2022_PROGRAM_ID,
        }),
        createInitializeAccount3Instruction(signer.publicKey, this.addresses.tokenShareMint, this.account.creator, TOKEN_2022_PROGRAM_ID),
      ],
    };
  }

  /** `liquidate`, with what it needs in front, for anyone who wants to. */
  async liquidateIxs(liquidator: PublicKey, obligation: PublicKey, repayAmount: bigint): Promise<TransactionInstruction[]> {
    const state = await this.aera.getObligationByAddress(obligation);
    if (!state) throw new Error('no such obligation');
    const global = await this.aera.getGlobal();
    if (!global) throw new Error('no Global account');
    const a = this.addresses;
    return [
      this.ensureAta(liquidator, liquidator, a.tokenShareMint, TOKEN_2022_PROGRAM_ID),
      // Aera's share of a creator market's bonus is zero, but the account is
      // part of the instruction and must exist.
      this.ensureAta(liquidator, global.feeDestination, a.tokenShareMint, TOKEN_2022_PROGRAM_ID),
      ...(await this.preludeIxs()),
      await this.aera.refreshObligationIx(state),
      await this.aera.liquidateIx(liquidator, this.account.quoteMint, this.account.tokenMint, obligation, repayAmount),
    ];
  }

  /**
   * Every obligation in this market that still owes SOL. Filtered on chain by
   * discriminator and market, so it does not page through every obligation
   * Aera has.
   */
  async borrowers(): Promise<ObligationAccount[]> {
    const quoteReserve = this.addresses.quoteReserve;
    const raw = await this.connection.getProgramAccounts(this.programId, {
      commitment: 'confirmed',
      filters: [
        { memcmp: { offset: 0, bytes: base58Encode(OBLIGATION_DISCRIMINATOR) } },
        { memcmp: { offset: 8, bytes: this.market.toBase58() } },
      ],
    });
    const out: ObligationAccount[] = [];
    for (const { pubkey, account } of raw) {
      try {
        out.push(decodeObligation(pubkey, this.aera.decodeAccountData('Obligation', account.data)));
      } catch {
        // Not an obligation after all.
      }
    }
    return out.filter((o) => o.borrows.some((b) => b.reserve.equals(quoteReserve) && b.borrowedPrincipal > 0n));
  }
}

/**
 * Is this a token account cover can pay a creator into: Token-2022, owned by
 * `creator`, for `shareMint`, and with no extensions (so no required memo)?
 */
export function isPlainPayoutAccount(
  info: { owner: PublicKey; data: Uint8Array } | null,
  creator: PublicKey,
  shareMint: PublicKey,
): boolean {
  if (!info || !info.owner.equals(TOKEN_2022_PROGRAM_ID) || info.data.length !== ACCOUNT_SIZE) return false;
  const mint = new PublicKey(info.data.subarray(0, 32));
  const owner = new PublicKey(info.data.subarray(32, 64));
  return mint.equals(shareMint) && owner.equals(creator) && info.data[108] === 1;
}

/** `["obligation_share_vault", token_reserve, obligation]`, for callers building cover by hand. */
export const isolatedCollateralVault = (market: PublicKey, tokenMint: PublicKey, obligation: PublicKey, programId?: PublicKey) =>
  obligationShareVaultPda(reservePda(market, tokenMint, programId), obligation, programId);

/** The collateral share mint of a creator market (`aISO`). */
export const isolatedCollateralShareMint = (market: PublicKey, tokenMint: PublicKey, programId?: PublicKey) =>
  shareMintPda(reservePda(market, tokenMint, programId), programId);
