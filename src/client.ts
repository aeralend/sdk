/**
 * The Aera client.
 *
 * Method names are Aave-shaped (`supply`, `withdraw`, `depositCollateral`,
 * `borrow`, `repay`, `liquidate`) even though the on-chain instructions are
 * snake_case, so anyone who has integrated a money market before can read this
 * without a translation table.
 *
 * Every method that touches value returns a **transaction**, not a signature:
 * signing belongs to the wallet, and the app previews before it submits.
 *
 * The protocol requires `accrue` for each reserve involved, then
 * `refresh_obligation`, then the action — all in one transaction. The builders
 * here assemble that automatically, including the `remaining_accounts` pairs,
 * so a caller cannot forget and hit `ReserveStale`.
 */

/*
 * `BN` comes from bn.js rather than from anchor's re-export of it, and is
 * unwrapped defensively.
 *
 * `@coral-xyz/anchor` is CommonJS and Node's cjs-module-lexer cannot find `BN`
 * among its exports -- it is re-exported from bn.js rather than assigned
 * directly -- so `import { BN } from '@coral-xyz/anchor'` throws on Node 20 and
 * 22 while working on 24 and under webpack. The default-import interop path
 * fails in the mirror image: webpack rejects it, because anchor has no default
 * export. No form of the anchor import works everywhere.
 *
 * bn.js is where the constructor actually lives, and it is the same one:
 * `anchor.BN === (bn.js default)` is true and the lockfile resolves a single
 * copy, so nothing anchor builds can fail an instanceof check on it.
 *
 * The `.default` dance is not superstition. bn.js sets `module.exports = BN`,
 * and Node 24 hands that straight back -- but Node 22 wrapped it one level
 * deeper and the smoke suite failed with "BN is not a constructor" on seven
 * instructions while passing here. Accepting both shapes is two tokens and
 * removes the runtime from the question entirely.
 */
import BNModule from 'bn.js';
const BN = ((BNModule as unknown as { default?: typeof BNModule }).default ??
  BNModule) as typeof BNModule;

const U64_MAX = (1n << 64n) - 1n;

/**
 * An amount as the program's `u64` argument, refusing anything that is not one.
 *
 * `new BN(x.toString())` accepts a negative string and Anchor encodes its
 * magnitude, so `-5n` went on the wire as 5; anything at or above 2^64 was
 * truncated by the encoder instead. Both meant the bytes signed were not the
 * number the caller passed. Every amount builder goes through this.
 */
export function assertU64(value: bigint, name = 'amount'): InstanceType<typeof BNModule> {
  if (typeof value !== 'bigint') throw new TypeError(`${name} must be a bigint`);
  if (value < 0n || value > U64_MAX) throw new RangeError(`${name} is outside the u64 range: ${value}`);
  return new BN(value.toString());
}
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  unpackMint,
} from '@solana/spl-token';
import {
  Connection,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js';

import idlJson from '../idl/aera.json' with { type: 'json' };
import {
  decodeMarketOracle,
  decodeOracleState,
  haircutRate,
  OracleHealth,
  OracleSourceKind,
  readsSourceAccount,
  type MarketOracleAccount,
  type OracleStateAccount,
} from './oracle.js';
import { programDataAddress } from './oracleConfig.js';
import { AERA_PROGRAM_ID, COOKIE_RPC_URL, COOKIE_WS_URL } from './constants.js';
import {
  decodeGlobal,
  decodeMarket,
  decodeObligation,
  decodeReserve,
  decodeRiskConfig,
  decodeSupplyPosition,
} from './decode.js';
import { bonusSplit, previewLiquidation, type LiquidationPreview } from './liquidation.js';
import {
  borrowRateBps,
  capHeadroom,
  currentBorrowed,
  supplyRateBps,
  totalLiquidity,
  utilizationBps,
} from './math.js';
import {
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
import type {
  RiskConfigAccount,
  GlobalAccount,
  MarketAccount,
  ObligationAccount,
  ReserveAccount,
  ReserveView,
  SupplyPositionAccount,
} from './types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * A position as it will be when a transaction runs, not as it is on chain now.
 *
 * `refresh_obligation` needs a `[reserve, oracle]` pair for every reserve the
 * obligation holds, and the high-level builders learn those by reading the
 * obligation. A sequence signed in one approval (a loop: lock, borrow, lock,
 * borrow) is built before its first transaction lands, so that read would miss
 * the collateral the first one adds and the second would be refused. The
 * caller states what the position will hold instead. Reserves are listed in the
 * obligation's own order, deposits and borrows separately.
 */
export interface ProjectedPosition {
  owner: PublicKey;
  deposits: Array<{ reserve: PublicKey; mint: PublicKey }>;
  borrows: Array<{ reserve: PublicKey; mint: PublicKey }>;
}

/**
 * The associated token address for a **share** token.
 *
 * Share mints (aCOOK) are Token-2022; liquidity mints (wCOOK, bCOOK) are legacy
 * SPL. The token program is part of the ATA seeds, so the same owner and mint
 * resolve to different addresses under each program — deriving a share ATA with
 * the legacy default silently produces an account the program will reject, and
 * nothing about the failure points at the cause.
 */
export const shareAta = (shareMint: PublicKey, owner: PublicKey): PublicKey =>
  getAssociatedTokenAddressSync(shareMint, owner, true, TOKEN_2022_PROGRAM_ID);

/**
 * Which Anchor account type each slot of a batched read decodes as.
 *
 * The keys are the read's own labels; the values are the IDL's account names.
 * Kept beside the read so adding a slot forces a decision about how it decodes.
 */
const ACCOUNT_KIND: Record<string, string> = {
  global: 'Global',
  market: 'Market',
  cookReserve: 'Reserve',
  bcookReserve: 'Reserve',
  cookOracle: 'OracleState',
  bcookOracle: 'OracleState',
  obligation: 'Obligation',
  supplyPosition: 'SupplyPosition',
  bcookRiskConfig: 'RiskConfig',
};

/**
 * Anchor's accounts coder is keyed by the IDL's account name, and which casing
 * that is has changed across Anchor versions - PascalCase in the IDL, camelCase
 * in the `program.account.*` namespace. Rather than pin a guess that breaks
 * silently on an upgrade, try the IDL name and fall back to the camelCase form.
 */
export const decodeAccountByName = (coder: any, name: string, data: Buffer): any => {
  const camel = name.charAt(0).toLowerCase() + name.slice(1);
  try {
    return coder.accounts.decode(name, data);
  } catch (first) {
    if (camel === name) throw first;
    return coder.accounts.decode(camel, data);
  }
};

/** One `getMultipleAccounts` read: every account, all at `slot`. */
export interface BatchedRead {
  /** The context slot every account below was read at. */
  slot: number;
  programExecutable: boolean;
  global: GlobalAccount | null;
  market: MarketAccount | null;
  cookReserve: ReserveAccount | null;
  bcookReserve: ReserveAccount | null;
  cookOracle: OracleStateAccount | null;
  bcookOracle: OracleStateAccount | null;
  obligation: ObligationAccount | null;
  supplyPosition: SupplyPositionAccount | null;
  /**
   * The collateral reserve's risk limits: the per-wallet borrow cap and Aera's
   * share of its liquidation bonus.
   *
   * `null` when no `RiskConfig` exists, which is Core's state and means no cap
   * and no protocol share. Read in the same batch as everything else so the
   * split shown beside a bonus is the split that was configured at that slot.
   */
  bcookRiskConfig: RiskConfigAccount | null;
  /**
   * The owner's holdings at `slot`. All zero when no owner was given.
   *
   * `native` is the wallet's own lamports, which on Cookie Chain is its COOK:
   * COOK is the native token and the wCOOK token account in `cook` is usually
   * empty. It is read from the owner's account in this same batch, so it cannot
   * belong to a different block than the position beside it, and there is no
   * second request whose failure could be mistaken for a zero balance. A
   * wallet with no account on chain holds no lamports, so absent reads as 0
   * truthfully.
   */
  balances: { native: bigint; cook: bigint; bcook: bigint; acook: bigint };
}

export interface AeraClientOptions {
  connection?: Connection;
  provider?: AnchorProvider;
  programId?: PublicKey;
  marketId?: number;
  /** Defaults to `COOKIE_RPC_URL`. Only used when no `connection` is supplied. */
  endpoint?: string;
  /**
   * Defaults to `COOKIE_WS_URL`. Passed explicitly rather than left to web3.js,
   * which derives the socket URL from the HTTP one by string surgery — correct
   * here today, but not something to depend on when the endpoint is
   * configurable.
   */
  wsEndpoint?: string;
}

export class AeraClient {
  /** Decode authenticated raw account bytes using the same camel-cased IDL
   * as the transaction builders. Caller must validate account ownership/PDA. */
  decodeAccountData(name: 'Global' | 'Reserve' | 'Obligation' | 'OracleState', data: Buffer): unknown {
    return decodeAccountByName(this.program.coder, name, data);
  }
  readonly connection: Connection;
  readonly programId: PublicKey;
  readonly marketId: number;
  readonly market: PublicKey;
  readonly global: PublicKey;
  private readonly program: Program;

  /**
   * Anchor's `program.account.*` and `program.methods.*` are typed from a
   * compile-time IDL literal. The IDL here is loaded as JSON at runtime so it
   * always matches the deployed program rather than a checked-in copy of its
   * shape, which means those namespaces are untyped from TypeScript's point of
   * view. These two accessors are the only place that gap is bridged; every
   * account that comes back through them is validated and converted by
   * `decode.ts` before it reaches a caller.
   */
  private get accounts(): any {
    return this.program.account;
  }

  private get methods(): any {
    return this.program.methods;
  }

  constructor(options: AeraClientOptions = {}) {
    this.connection =
      options.provider?.connection ??
      options.connection ??
      new Connection(options.endpoint ?? COOKIE_RPC_URL, {
        commitment: 'confirmed',
        wsEndpoint: options.wsEndpoint ?? COOKIE_WS_URL,
      });
    this.programId = options.programId ?? AERA_PROGRAM_ID;
    this.marketId = options.marketId ?? 0;
    this.market = marketPda(this.marketId, this.programId);
    this.global = globalPda(this.programId);

    const idl = { ...(idlJson as any), address: this.programId.toBase58() };
    // A read-only client needs no wallet; write paths return unsigned
    // transactions, so the provider is only ever used for decoding here.
    const provider =
      options.provider ??
      new AnchorProvider(this.connection, {} as any, { commitment: 'confirmed' });
    this.program = new Program(idl, provider);
  }

  // -----------------------------------------------------------------------
  // Reads
  // -----------------------------------------------------------------------

  async getGlobal(): Promise<GlobalAccount | null> {
    const raw = await this.accounts.global.fetchNullable(this.global);
    return raw ? decodeGlobal(this.global, raw) : null;
  }

  async getMarket(): Promise<MarketAccount | null> {
    const raw = await this.accounts.market.fetchNullable(this.market);
    return raw ? decodeMarket(this.market, raw) : null;
  }

  reserveAddress(liquidityMint: PublicKey): PublicKey {
    return reservePda(this.market, liquidityMint, this.programId);
  }

  /** Resolve the mint's token program before deriving ATAs or building CPIs.
   * Cookie's bridged SOL is Token-2022; COOK/bCOOK use legacy SPL Token.
   * Never fall back on RPC failure or an unsupported account owner.
   */
  async liquidityTokenProgram(mint: PublicKey): Promise<PublicKey> {
    const account = await this.connection.getAccountInfo(mint);
    if (!account) throw new Error(`liquidity mint ${mint.toBase58()} does not exist`);
    const owner = account.owner;
    if (!owner.equals(TOKEN_PROGRAM_ID) && !owner.equals(TOKEN_2022_PROGRAM_ID)) {
      throw new Error(`unsupported token program ${owner.toBase58()} for ${mint.toBase58()}`);
    }
    const decoded = unpackMint(mint, account, owner);
    if (!decoded.isInitialized) throw new Error(`liquidity mint ${mint.toBase58()} is not initialized`);
    return owner;
  }

  async getReserve(liquidityMint: PublicKey): Promise<ReserveAccount | null> {
    const address = this.reserveAddress(liquidityMint);
    const raw = await this.accounts.reserve.fetchNullable(address);
    return raw ? decodeReserve(address, raw) : null;
  }

  /** Every reserve in this market. */
  async getReserves(): Promise<ReserveAccount[]> {
    const all = await this.accounts.reserve.all();
    return all
      .filter((entry: any) => entry.account.market.equals(this.market))
      .map((entry: any) => decodeReserve(entry.publicKey, entry.account));
  }

  /**
   * The `OracleState` for one mint.
   *
   * Replaces v0.1's `getPriceFeed`. The account holds no price anyone supplied:
   * it holds the last observation the breaker accepted from the configured
   * source, the bounds that observation had to satisfy, and what the protocol
   * will currently permit.
   */
  async getOracleState(mint: PublicKey): Promise<OracleStateAccount | null> {
    const address = oraclePda(this.market, mint, this.programId);
    const raw = await this.accounts.oracleState.fetchNullable(address);
    return raw ? decodeOracleState(address, raw) : null;
  }

  async getObligation(owner: PublicKey): Promise<ObligationAccount | null> {
    const address = obligationPda(this.market, owner, this.programId);
    const raw = await this.accounts.obligation.fetchNullable(address);
    return raw ? decodeObligation(address, raw) : null;
  }

  /** Aave-shaped alias. */
  getUserAccount(owner: PublicKey): Promise<ObligationAccount | null> {
    return this.getObligation(owner);
  }

  /**
   * Every obligation in this market — what the liquidator scans.
   *
   * Anchor's `.all()` filters on the account discriminator, which matters here:
   * `Reserve`, `OracleState` and `Market` all carry a 32-byte key at offset 8
   * too, so a hand-rolled `memcmp` at that offset would also match them.
   */
  /**
   * One obligation by its own address.
   *
   * `getObligation` takes an owner and derives the PDA, which is what a wallet
   * wants. A liquidator has already enumerated the book and holds addresses,
   * not owners, so deriving backwards would mean a second lookup per position.
   */
  async getObligationByAddress(address: PublicKey): Promise<ObligationAccount | null> {
    const raw = await this.accounts.obligation.fetchNullable(address);
    return raw ? decodeObligation(address, raw) : null;
  }

  async getObligations(): Promise<ObligationAccount[]> {
    const all = await this.accounts.obligation.all();
    return all
      .filter((entry: any) => entry.account.market.equals(this.market))
      .map((entry: any) => decodeObligation(entry.publicKey, entry.account));
  }

  async getSupplyPosition(
    reserve: PublicKey,
    owner: PublicKey,
  ): Promise<SupplyPositionAccount | null> {
    const address = supplyPositionPda(reserve, owner, this.programId);
    const raw = await this.accounts.supplyPosition.fetchNullable(address);
    return raw ? decodeSupplyPosition(address, raw) : null;
  }

  /**
   * A reserve with rates, caps and oracle state resolved — everything the
   * Markets and Reserve screens render.
   */
  /**
   * Every account the app needs, decoded from one `getMultipleAccounts` call.
   *
   * A snapshot assembled from several round trips can straddle a block: a
   * reserve read before it and an obligation read after it combine into a health
   * factor that was never true at any slot. One batched call returns one context
   * slot for all of them, and that slot is reported so the caller can prove it.
   *
   * Decoding goes through Anchor's coder, built from the IDL loaded at runtime,
   * so the layout is always the deployed program's. A hand-written offset would
   * be a second source of truth that silently rots after a program upgrade.
   */
  async readAtSlot(input: {
    cookMint?: PublicKey | null;
    bcookMint?: PublicKey | null;
    owner?: PublicKey | null;
  }): Promise<BatchedRead> {
    const { cookMint = null, bcookMint = null, owner = null } = input;
    const [cookProgram, bcookProgram] = await Promise.all([
      owner && cookMint ? this.liquidityTokenProgram(cookMint) : null,
      owner && bcookMint ? this.liquidityTokenProgram(bcookMint) : null,
    ]);

    const cookReserve = cookMint ? reservePda(this.market, cookMint, this.programId) : null;
    const bcookReserve = bcookMint ? reservePda(this.market, bcookMint, this.programId) : null;

    // Every key is derivable, so nothing here needs a prior read to be built.
    const plan: Array<[string, PublicKey | null]> = [
      ['program', this.programId],
      ['global', this.global],
      ['market', this.market],
      ['owner', owner],
      ['cookReserve', cookReserve],
      ['bcookReserve', bcookReserve],
      ['cookOracle', cookMint ? oraclePda(this.market, cookMint, this.programId) : null],
      ['bcookOracle', bcookMint ? oraclePda(this.market, bcookMint, this.programId) : null],
      ['obligation', owner ? obligationPda(this.market, owner, this.programId) : null],
      [
        'cookToken',
        owner && cookMint ? getAssociatedTokenAddressSync(cookMint, owner, true, cookProgram!) : null,
      ],
      [
        'bcookToken',
        owner && bcookMint ? getAssociatedTokenAddressSync(bcookMint, owner, true, bcookProgram!) : null,
      ],
      [
        'acookToken',
        owner && cookReserve
          ? shareAta(shareMintPda(cookReserve, this.programId), owner)
          : null,
      ],
      /*
       * Per-wallet supply accounting. This tracks liquidity supplied *through
       * Aera*, which is not the aCOOK balance - aCOOK received by transfer does
       * not consume anyone's cap - so it is the only figure the per-wallet cap
       * can be measured against.
       */
      [
        'supplyPosition',
        owner && cookReserve ? supplyPositionPda(cookReserve, owner, this.programId) : null,
      ],
      /*
       * On the COLLATERAL reserve, because that is where both limits live:
       * `liquidation_bonus_bps` is a property of what is seized, and Aera's
       * share is carved out of it. Reading the borrowed reserve's config here
       * would return the wrong account with a plausible shape.
       */
      ['bcookRiskConfig', bcookReserve ? riskConfigPda(bcookReserve, this.programId) : null],
    ];

    const present = plan.filter((entry): entry is [string, PublicKey] => entry[1] !== null);
    const { context, value } = await this.connection.getMultipleAccountsInfoAndContext(
      present.map(([, key]) => key),
    );

    const at = (name: string) => {
      const index = present.findIndex(([label]) => label === name);
      return index === -1 ? null : (value[index] ?? null);
    };

    /**
     * Decode one slot of the batch, or null if the account is absent.
     *
     * `program.coder` is built from the IDL loaded at runtime, so the layout is
     * always the deployed program's. When the IDL and the chain disagree this
     * throws and the field comes back null - which surfaces as "not resolved"
     * rather than as a plausible wrong number.
     */
    const decode = <T>(name: string, build: (raw: any) => T): T | null => {
      const account = at(name);
      if (!account) return null;
      try {
        const raw = decodeAccountByName(
          (this.program as any).coder,
          ACCOUNT_KIND[name] as string,
          account.data,
        );
        return build(raw);
      } catch {
        return null;
      }
    };

    /**
     * Token balances are read positionally rather than through `unpackAccount`.
     * SPL Token and Token-2022 share the same first 72 bytes, and `amount` is a
     * little-endian u64 at offset 64 in both, so one path covers aCOOK
     * (Token-2022) and COOK/bCOOK without branching on the owning program.
     */
    const balance = (name: string): bigint => {
      const account = at(name);
      if (!account || account.data.length < 72) return 0n;
      return account.data.readBigUInt64LE(64);
    };

    return {
      slot: context.slot,
      programExecutable: at('program')?.executable === true,
      global: decode('global', (raw) => decodeGlobal(this.global, raw)),
      market: decode('market', (raw) => decodeMarket(this.market, raw)),
      cookReserve: decode('cookReserve', (raw) => decodeReserve(cookReserve!, raw)),
      bcookReserve: decode('bcookReserve', (raw) => decodeReserve(bcookReserve!, raw)),
      cookOracle: decode('cookOracle', (raw) =>
        decodeOracleState(oraclePda(this.market, cookMint!, this.programId), raw),
      ),
      bcookOracle: decode('bcookOracle', (raw) =>
        decodeOracleState(oraclePda(this.market, bcookMint!, this.programId), raw),
      ),
      obligation: decode('obligation', (raw) =>
        decodeObligation(obligationPda(this.market, owner!, this.programId), raw),
      ),
      supplyPosition: decode('supplyPosition', (raw) =>
        decodeSupplyPosition(supplyPositionPda(cookReserve!, owner!, this.programId), raw),
      ),
      bcookRiskConfig: decode('bcookRiskConfig', (raw) =>
        decodeRiskConfig(riskConfigPda(bcookReserve!, this.programId), raw),
      ),
      balances: {
        native: BigInt(at('owner')?.lamports ?? 0),
        cook: balance('cookToken'),
        bcook: balance('bcookToken'),
        acook: balance('acookToken'),
      },
    };
  }

  async getReserveView(liquidityMint: PublicKey, symbol: string): Promise<ReserveView | null> {
    const reserve = await this.getReserve(liquidityMint);
    if (!reserve) return null;
    const oracle = await this.getOracleState(liquidityMint);

    const borrowed = currentBorrowed(reserve);
    return {
      reserve,
      symbol,
      utilizationBps: utilizationBps(reserve),
      borrowRateBps: borrowRateBps(reserve),
      supplyRateBps: supplyRateBps(reserve),
      totalLiquidity: totalLiquidity(reserve),
      borrowed,
      available: reserve.availableLiquidity,
      supplyCapHeadroom: capHeadroom(
        reserve.config.supplyCap,
        reserve.availableLiquidity + borrowed,
      ),
      borrowCapHeadroom: capHeadroom(reserve.config.borrowCap, borrowed),
      /*
       * The collateral rate, not the gross one.
       *
       * `effectiveRate` already has BakeYourStake's redemption fee taken out,
       * and the haircut on top is Aera's own margin. Showing a gross rate here
       * would quote a value nobody can actually realise -- which is the number
       * a borrower would then be surprised by at liquidation.
       */
      priceScaled: oracle
        ? haircutRate(oracle.reference.effectiveRate, reserve.config.collateralHaircutBps)
        : 0n,
      grossRateScaled: oracle?.reference.grossRate ?? 0n,
      effectiveRateScaled: oracle?.reference.effectiveRate ?? 0n,
      withdrawalFeeBps: oracle?.reference.withdrawalFeeBps ?? 0,
      oracleHealth: oracle?.health ?? null,
      /** Slots since the last accepted observation, not seconds since a signature. */
      oracleAgeSlots: oracle ? oracle.lastRefreshSlot : null,
      sourceEpoch: oracle?.reference.sourceEpoch ?? null,
      breakerTripped: oracle
        ? oracle.health !== OracleHealth.Healthy && oracle.health !== OracleHealth.RateWarning
        : false,
    };
  }

  /**
   * Watch a set of accounts over the Cookie WebSocket and call `onChange` when
   * any of them moves.
   *
   * This replaces polling for the screens that show live rates and health.
   * Returns a disposer; call it on unmount or the subscriptions outlive the
   * component and the socket accumulates listeners.
   *
   * `onChange` is deliberately not handed the account data: several of these
   * accounts change together in one transaction, and re-reading once is both
   * simpler and more consistent than stitching partial updates.
   */
  watchAccounts(accounts: PublicKey[], onChange: () => void): () => void {
    const ids = accounts.map((account) =>
      this.connection.onAccountChange(account, () => onChange(), 'confirmed'),
    );

    return () => {
      for (const id of ids) {
        void this.connection.removeAccountChangeListener(id).catch(() => {
          // The socket may already be gone; nothing useful to do about it.
        });
      }
    };
  }

  // -----------------------------------------------------------------------
  // Instruction helpers
  // -----------------------------------------------------------------------

  /** Advance a reserve's borrow index. Cheap, permissionless, and required. */
  async accrueIx(reserve: PublicKey): Promise<TransactionInstruction> {
    return this.methods.accrue().accounts({ reserve }).instruction();
  }

  /**
   * `refresh_obligation`, with the `[reserve, price_feed]` pairs it needs —
   * deposits first, then borrows, in the obligation's own order.
   */
  async refreshObligationIx(obligation: ObligationAccount): Promise<TransactionInstruction> {
    const remaining = [] as Array<{ pubkey: PublicKey; isSigner: false; isWritable: false }>;
    const reserves = new Map<string, ReserveAccount>();

    for (const entry of [...obligation.deposits, ...obligation.borrows]) {
      const key = entry.reserve.toBase58();
      if (!reserves.has(key)) {
        const raw = await this.accounts.reserve.fetch(entry.reserve);
        reserves.set(key, decodeReserve(entry.reserve, raw));
      }
      const reserve = reserves.get(key)!;
      remaining.push({ pubkey: entry.reserve, isSigner: false, isWritable: false });
      remaining.push({ pubkey: reserve.oracle, isSigner: false, isWritable: false });
    }

    return this.methods
      .refreshObligation()
      .accounts({ obligation: obligation.address })
      .remainingAccounts(remaining)
      .instruction();
  }

  /**
   * `refresh_oracle` for one mint.
   *
   * Permissionless and argument-free: the caller supplies nothing and cannot
   * influence the result. This replaces v0.1's `publishPriceIx`, which took a
   * price and a guardian signature — the entire difference between an oracle
   * somebody operates and one anybody can crank.
   *
   * The source account and its `ProgramData` ride in `remainingAccounts`, and
   * only when the configured source actually reads one. Both are derived here
   * rather than taken as arguments, so a caller cannot point the refresh at
   * something else; the program derives and checks them again regardless.
   */
  async refreshOracleIx(mint: PublicKey): Promise<TransactionInstruction> {
    const oracle = oraclePda(this.market, mint, this.programId);
    const state = await this.getOracleState(mint);

    /*
     * A Tier 3 oracle takes a different instruction entirely.
     *
     * `refresh_oracle` rejects a `MarketTwap` source with `UnknownOracleSource`,
     * which is an unhelpful way to discover a reserve is market-priced. Callers
     * should not have to know which kind they are holding, so this dispatches.
     */
    if (state?.sourceKind === OracleSourceKind.MarketTwap) {
      return this.refreshMarketOracleIx(mint);
    }

    const remaining =
      state && readsSourceAccount(state.sourceKind)
        ? [
            { pubkey: state.sourceAccount, isSigner: false, isWritable: false },
            {
              pubkey: programDataAddress(state.sourceProgram),
              isSigner: false,
              isWritable: false,
            },
          ]
        : [];

    return this.methods
      .refreshOracle()
      .accounts({ oracle })
      .remainingAccounts(remaining)
      .instruction();
  }

  /**
   * A reserve's risk limits, or null when it has none.
   *
   * Null is not an error: a reserve with no `RiskConfig` is unconstrained, which
   * is Core's state. Use {@link protocolLiquidationShareBps} when you want the
   * number rather than the account.
   */
  async getRiskConfig(reserve: PublicKey): Promise<RiskConfigAccount | null> {
    const address = riskConfigPda(reserve, this.programId);
    const raw = await this.accounts.riskConfig.fetchNullable(address);
    return raw ? decodeRiskConfig(address, raw) : null;
  }

  /** Aera's share of a collateral reserve's liquidation bonus, in bps. */
  async protocolLiquidationShareBps(collateralMint: PublicKey): Promise<number> {
    const config = await this.getRiskConfig(this.reserveAddress(collateralMint));
    return config?.protocolLiquidationShareBps ?? 0;
  }

  /**
   * How a collateral's liquidation bonus is divided, read from chain.
   *
   * The `liquidatorBonusBps` this returns is the number a liquidator should
   * size its profit against. The reserve's own `liquidationBonusBps` is what
   * the *borrower* pays, and using it as the liquidator's margin overstates
   * every opportunity by exactly the protocol's share.
   */
  async liquidationBonusSplit(collateralMint: PublicKey) {
    const reserve = await this.getReserve(collateralMint);
    if (!reserve) throw new Error(`no reserve for ${collateralMint.toBase58()}`);
    return bonusSplit(
      reserve.config.liquidationBonusBps,
      await this.protocolLiquidationShareBps(collateralMint),
    );
  }

  /**
   * What a liquidation would move, given the seizure the protocol computes.
   *
   * `seizedShares` comes from a simulation rather than from a second
   * implementation of the valuation chain here -- that chain runs through both
   * oracles, the collateral exchange rate and the reserve's decimals, and a
   * mirror of it is exactly the kind that agrees with a bug. Simulation stays
   * authoritative; this attributes the result.
   */
  async previewLiquidation(
    collateralMint: PublicKey,
    repay: bigint,
    seizedShares: bigint,
  ): Promise<LiquidationPreview> {
    const split = await this.liquidationBonusSplit(collateralMint);
    return previewLiquidation({
      repay,
      seizedShares,
      totalBonusBps: split.totalBonusBps,
      protocolShareBps: split.protocolShareBps,
      protocolDestination: await this.protocolCollateralDestination(collateralMint),
    });
  }

  /**
   * Where Aera's share of a collateral's liquidations goes.
   *
   * The associated token account of `global.fee_destination` for that
   * collateral's share mint. `fee_destination` is an *owner*, not a token
   * account, which is what lets one destination hold a separate account per
   * collateral asset with no further configuration -- and why Gap D introduced
   * no second mutable destination to secure.
   *
   * The account must exist before a share above zero is enabled. A liquidation
   * that owes Aera nothing never touches it.
   */
  async protocolCollateralDestination(collateralMint: PublicKey): Promise<PublicKey> {
    const collateralReserve = this.reserveAddress(collateralMint);
    const shareMint = shareMintPda(collateralReserve, this.programId);
    const global = await this.getGlobal();
    if (!global) throw new Error('no Global account');
    return shareAta(shareMint, global.feeDestination);
  }

  /**
   * Fetch the observation history behind a market-priced oracle.
   *
   * Null for a mint whose oracle is Tier 1 or the unit of account — those keep
   * no history, because a stake pool publishes its own rate and one COOK is
   * always one COOK.
   */
  async getMarketOracle(mint: PublicKey): Promise<MarketOracleAccount | null> {
    const oracle = oraclePda(this.market, mint, this.programId);
    const address = marketOraclePda(oracle, this.programId);
    const raw = await this.accounts.marketOracle.fetchNullable(address);
    return raw ? decodeMarketOracle(address, raw) : null;
  }

  /**
   * Take a market-price observation, or restate freshness if one is not due.
   *
   * Permissionless and unsigned: the caller hands over pool accounts and the
   * program reads the reserves itself, so there is no number to supply and no
   * authority to hold. The pools and vaults come from the `MarketOracle`
   * account rather than from the caller, and the program checks them again
   * regardless.
   *
   * Calling this more often than `config.minSpacingSeconds` is not an error —
   * it re-prices and restates freshness without appending, which is exactly
   * what a borrow or a liquidation needs in the same transaction. It is simply
   * wasted fees if nothing follows it.
   */
  async refreshMarketOracleIx(mint: PublicKey): Promise<TransactionInstruction> {
    const oracle = oraclePda(this.market, mint, this.programId);
    const market = await this.getMarketOracle(mint);
    if (!market) {
      throw new Error(
        `no MarketOracle for ${mint.toBase58()}; this mint is not market-priced, ` +
          'use refreshOracleIx',
      );
    }
    const [a, b] = market.pools;
    if (!a || !b) {
      throw new Error(`MarketOracle for ${mint.toBase58()} does not name two pools`);
    }

    return this.methods
      .refreshMarketOracle()
      .accounts({
        oracle,
        marketOracle: market.address,
        poolA: a.pool,
        poolACollateralVault: a.collateralVault,
        poolAQuoteVault: a.quoteVault,
        poolB: b.pool,
        poolBCollateralVault: b.collateralVault,
        poolBQuoteVault: b.quoteVault,
        // Each pool's own AMM deployment. The same account twice when both
        // pools are on one AMM.
        poolAAmmProgramData: a.ammProgramData,
        poolBAmmProgramData: b.ammProgramData,
      })
      // The instructions sysvar: from the 2026-10-12 security upgrade a refresh
      // records an observation only when it stands alone in its transaction,
      // which the program checks here. Bundled refreshes still restate
      // freshness. Programs before that upgrade ignore the extra account.
      .remainingAccounts([{ pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }])
      .instruction();
  }

  /**
   * Recognise debt that no collateral stands behind.
   *
   * Permissionless. Only callable on an obligation that holds debt and no
   * collateral anywhere, which the program verifies from the accounts. See
   * `instructions::absorb_bad_debt` for who absorbs the loss: the suppliers,
   * pro rata, through the share rate falling.
   */
  async absorbBadDebtIx(
    obligation: PublicKey,
    reserve: PublicKey,
  ): Promise<TransactionInstruction> {
    return this.methods
      .absorbBadDebt()
      .accounts({ market: this.market, obligation, reserve })
      .instruction();
  }

  /** Accrue every reserve an obligation touches, then refresh it. */
  /**
   * Accrue interest, refresh the oracles, then refresh the obligation.
   *
   * The oracle refreshes are not a convenience. `refresh_obligation` — and
   * `borrow`, `withdraw_collateral` and `liquidate` after it — call
   * `OracleState::require_fresh`, which demands `last_refresh_slot` equal the
   * *current* slot. A price written a slot ago is a price someone had a slot to
   * arrange around, so the program will not value collateral against it.
   *
   * That means every such transaction has to carry its own refresh. Relying on
   * the crank instead makes success depend on landing in the same slot as a
   * keeper, which is to say on luck: the failure is `OracleStale`, it is
   * intermittent, and it looks like an RPC problem rather than a missing
   * instruction.
   *
   * `extraReserves` covers a reserve the action touches for the first time. A
   * borrow of an asset the obligation has never borrowed still needs that
   * asset's oracle fresh and its reserve accrued, and the obligation's own
   * entries do not mention it yet.
   */
  private async preludeIxs(
    obligation: ObligationAccount,
    extraReserves: PublicKey[] = [],
  ): Promise<TransactionInstruction[]> {
    const involved = [
      ...obligation.deposits.map((entry) => entry.reserve),
      ...obligation.borrows.map((entry) => entry.reserve),
      ...extraReserves,
    ];

    const seen = new Set<string>();
    const accrues: TransactionInstruction[] = [];
    const refreshes: TransactionInstruction[] = [];

    for (const reserve of involved) {
      const key = reserve.toBase58();
      if (seen.has(key)) continue;
      seen.add(key);
      const raw = await this.accounts.reserve.fetch(reserve);
      accrues.push(await this.accrueIx(reserve));
      refreshes.push(await this.refreshOracleIx(decodeReserve(reserve, raw).liquidityMint));
    }

    return [...accrues, ...refreshes, await this.refreshObligationIx(obligation)];
  }

  /**
   * The same prelude for a {@link ProjectedPosition}: accrue every reserve
   * involved, refresh their oracles, then refresh the obligation with the
   * entries it will have. Nothing about the obligation is read, so it works for
   * a transaction whose predecessors have not landed yet.
   */
  async projectedPreludeIxs(
    position: ProjectedPosition,
    extra: Array<{ reserve: PublicKey; mint: PublicKey }> = [],
  ): Promise<TransactionInstruction[]> {
    const seen = new Set<string>();
    const accrues: TransactionInstruction[] = [];
    const refreshes: TransactionInstruction[] = [];
    for (const entry of [...position.deposits, ...position.borrows, ...extra]) {
      const key = entry.reserve.toBase58();
      if (seen.has(key)) continue;
      seen.add(key);
      accrues.push(await this.accrueIx(entry.reserve));
      refreshes.push(await this.refreshOracleIx(entry.mint));
    }
    const projected = {
      address: obligationPda(this.market, position.owner, this.programId),
      deposits: position.deposits.map((entry) => ({ reserve: entry.reserve })),
      borrows: position.borrows.map((entry) => ({ reserve: entry.reserve })),
    } as unknown as ObligationAccount;
    return [...accrues, ...refreshes, await this.refreshObligationIx(projected)];
  }

  // -----------------------------------------------------------------------
  // Single instructions; token programs are resolved from the liquidity mint.
  //
  // What the builders below wrap in a transaction, alone. A caller composing
  // several steps (a loop, an unwind) adds its own prelude with
  // `projectedPreludeIxs`, because `withdraw_collateral` and `borrow` need the
  // obligation refreshed in the same transaction.
  // -----------------------------------------------------------------------

  async supplyIx(owner: PublicKey, liquidityMint: PublicKey, amount: bigint): Promise<TransactionInstruction> {
    const liquidityTokenProgram = await this.liquidityTokenProgram(liquidityMint);
    const reserve = this.reserveAddress(liquidityMint);
    const shareMint = shareMintPda(reserve, this.programId);
    return this.methods
      .supply(assertU64(amount))
      .accounts({
        global: this.global,
        reserve,
        liquidityMint,
        liquidityVault: liquidityVaultPda(reserve, this.programId),
        shareMint,
        userLiquidity: getAssociatedTokenAddressSync(liquidityMint, owner, false, liquidityTokenProgram),
        userShare: shareAta(shareMint, owner),
        supplyPosition: supplyPositionPda(reserve, owner, this.programId),
        owner,
        liquidityTokenProgram,
        shareTokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  async withdrawIx(owner: PublicKey, liquidityMint: PublicKey, shares: bigint): Promise<TransactionInstruction> {
    const liquidityTokenProgram = await this.liquidityTokenProgram(liquidityMint);
    const reserve = this.reserveAddress(liquidityMint);
    const shareMint = shareMintPda(reserve, this.programId);
    return this.methods
      .withdraw(assertU64(shares, 'shares'))
      .accounts({
        global: this.global,
        reserve,
        liquidityMint,
        liquidityVault: liquidityVaultPda(reserve, this.programId),
        shareMint,
        userLiquidity: getAssociatedTokenAddressSync(liquidityMint, owner, false, liquidityTokenProgram),
        userShare: shareAta(shareMint, owner),
        supplyPosition: supplyPositionPda(reserve, owner, this.programId),
        owner,
        liquidityTokenProgram,
        shareTokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  async initObligationIx(owner: PublicKey): Promise<TransactionInstruction> {
    return this.methods
      .initObligation()
      .accounts({
        market: this.market,
        obligation: obligationPda(this.market, owner, this.programId),
        owner,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  async depositCollateralIx(owner: PublicKey, collateralMint: PublicKey, shares: bigint): Promise<TransactionInstruction> {
    const reserve = this.reserveAddress(collateralMint);
    const shareMint = shareMintPda(reserve, this.programId);
    const obligation = obligationPda(this.market, owner, this.programId);
    return this.methods
      .depositCollateral(assertU64(shares, 'shares'))
      .accounts({
        global: this.global,
        obligation,
        owner,
        reserve,
        shareMint,
        obligationShareVault: obligationShareVaultPda(reserve, obligation, this.programId),
        userShare: shareAta(shareMint, owner),
        shareTokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  async withdrawCollateralIx(owner: PublicKey, collateralMint: PublicKey, shares: bigint): Promise<TransactionInstruction> {
    const reserve = this.reserveAddress(collateralMint);
    const shareMint = shareMintPda(reserve, this.programId);
    const obligation = obligationPda(this.market, owner, this.programId);
    return this.methods
      .withdrawCollateral(assertU64(shares, 'shares'))
      .accounts({
        global: this.global,
        obligation,
        owner,
        reserve,
        oracle: oraclePda(this.market, collateralMint, this.programId),
        shareMint,
        obligationShareVault: obligationShareVaultPda(reserve, obligation, this.programId),
        userShare: shareAta(shareMint, owner),
        shareTokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .instruction();
  }

  async borrowIx(owner: PublicKey, liquidityMint: PublicKey, amount: bigint): Promise<TransactionInstruction> {
    const liquidityTokenProgram = await this.liquidityTokenProgram(liquidityMint);
    const reserve = this.reserveAddress(liquidityMint);
    return this.methods
      .borrow(assertU64(amount))
      .accounts({
        global: this.global,
        obligation: obligationPda(this.market, owner, this.programId),
        owner,
        reserve,
        oracle: oraclePda(this.market, liquidityMint, this.programId),
        liquidityMint,
        liquidityVault: liquidityVaultPda(reserve, this.programId),
        userLiquidity: getAssociatedTokenAddressSync(liquidityMint, owner, false, liquidityTokenProgram),
        liquidityTokenProgram,
        // Required, derived from the BORROW reserve: see `borrow` below.
        riskConfig: riskConfigPda(reserve, this.programId),
      })
      .instruction();
  }

  async repayIx(repayer: PublicKey, liquidityMint: PublicKey, amount: bigint, onBehalfOf?: PublicKey): Promise<TransactionInstruction> {
    const liquidityTokenProgram = await this.liquidityTokenProgram(liquidityMint);
    const owner = onBehalfOf ?? repayer;
    const reserve = this.reserveAddress(liquidityMint);
    return this.methods
      .repay(assertU64(amount))
      .accounts({
        obligation: obligationPda(this.market, owner, this.programId),
        reserve,
        liquidityMint,
        liquidityVault: liquidityVaultPda(reserve, this.programId),
        userLiquidity: getAssociatedTokenAddressSync(liquidityMint, repayer, false, liquidityTokenProgram),
        repayer,
        liquidityTokenProgram,
      })
      .instruction();
  }

  // -----------------------------------------------------------------------
  // Writes — every one returns an unsigned transaction
  // -----------------------------------------------------------------------

  /** Supply liquidity and receive share tokens. */
  async supply(owner: PublicKey, liquidityMint: PublicKey, amount: bigint): Promise<Transaction> {
    const reserve = this.reserveAddress(liquidityMint);
    return this.tx(owner, [await this.accrueIx(reserve), await this.supplyIx(owner, liquidityMint, amount)]);
  }

  /** Burn share tokens and take the underlying back. */
  async withdraw(owner: PublicKey, liquidityMint: PublicKey, shares: bigint): Promise<Transaction> {
    const reserve = this.reserveAddress(liquidityMint);
    return this.tx(owner, [await this.accrueIx(reserve), await this.withdrawIx(owner, liquidityMint, shares)]);
  }

  /** Create the borrower's position account. Required once, before collateral. */
  async initObligation(owner: PublicKey): Promise<Transaction> {
    return this.tx(owner, [await this.initObligationIx(owner)]);
  }

  /** Lock share tokens as collateral. */
  async depositCollateral(
    owner: PublicKey,
    collateralMint: PublicKey,
    shares: bigint,
  ): Promise<Transaction> {
    return this.tx(owner, [await this.depositCollateralIx(owner, collateralMint, shares)]);
  }

  /** Unlock collateral, if the position stays inside its borrow limit. */
  async withdrawCollateral(
    owner: PublicKey,
    collateralMint: PublicKey,
    shares: bigint,
  ): Promise<Transaction> {
    const obligation = await this.requireObligation(owner);
    const reserve = this.reserveAddress(collateralMint);
    return this.tx(owner, [
      ...(await this.preludeIxs(obligation, [reserve])),
      await this.withdrawCollateralIx(owner, collateralMint, shares),
    ]);
  }

  /** Draw liquidity against posted collateral. */
  async borrow(owner: PublicKey, liquidityMint: PublicKey, amount: bigint): Promise<Transaction> {
    const obligation = await this.requireObligation(owner);
    const reserve = this.reserveAddress(liquidityMint);

    /*
     * `borrowIx` passes the risk config, which is required, not optional, and
     * the program says so in as many words: an `Option` account is omittable
     * by the caller, and the caller is the party the per-wallet borrow cap
     * exists to constrain. It is derived from the BORROW reserve --
     * `["risk_config", reserve]` -- and the handler checks the key it was
     * handed against that.
     *
     * Omitting it did not build a transaction that skipped the cap; it built
     * no transaction at all. Anchor refused with "Account `riskConfig` not
     * provided", which is why `borrow` had never worked through this client.
     */
    const ix = await this.borrowIx(owner, liquidityMint, amount);

    // A borrow needs the *borrow* reserve accrued and its oracle fresh too,
    // even when the position does not touch that reserve yet.
    return this.tx(owner, [...(await this.preludeIxs(obligation, [reserve])), ix]);
  }

  /** Repay debt. Anyone may repay on behalf of a position. */
  async repay(
    repayer: PublicKey,
    liquidityMint: PublicKey,
    amount: bigint,
    onBehalfOf?: PublicKey,
  ): Promise<Transaction> {
    const reserve = this.reserveAddress(liquidityMint);
    return this.tx(repayer, [await this.accrueIx(reserve), await this.repayIx(repayer, liquidityMint, amount, onBehalfOf)]);
  }

  /** Close part of an unhealthy position and seize collateral plus the bonus. */
  /**
   * `liquidate` on its own, without the accrue/refresh prelude.
   *
   * The full `liquidate` below bundles the prelude and returns a transaction,
   * which is what a wallet wants. A keeper builds its own bundle -- it has to
   * refresh both oracles as well, and it wants control over the compute budget
   * and priority fee -- so it needs the instruction alone.
   *
   * Takes the obligation's address rather than the borrower's, because a
   * liquidator enumerates the book and holds addresses.
   */
  async liquidateIx(
    liquidator: PublicKey,
    repayMint: PublicKey,
    collateralMint: PublicKey,
    obligationAddress: PublicKey,
    amount: bigint,
  ): Promise<TransactionInstruction> {
    const liquidityTokenProgram = await this.liquidityTokenProgram(repayMint);
    const repayReserve = this.reserveAddress(repayMint);
    const collateralReserve = this.reserveAddress(collateralMint);
    const collateralShareMint = shareMintPda(collateralReserve, this.programId);
    const global = await this.getGlobal();
    if (!global) throw new Error('no Global account');
    const protocolDest = shareAta(collateralShareMint, global.feeDestination);

    return this.methods
      .liquidate(assertU64(amount))
      .accounts({
        global: globalPda(this.programId),
        obligation: obligationAddress,
        liquidator,
        repayReserve,
        collateralReserve,
        repayOracle: oraclePda(this.market, repayMint, this.programId),
        collateralOracle: oraclePda(this.market, collateralMint, this.programId),
        repayLiquidityMint: repayMint,
        collateralShareMint,
        repayLiquidityVault: liquidityVaultPda(repayReserve, this.programId),
        obligationCollateralVault: obligationShareVaultPda(
          collateralReserve,
          obligationAddress,
          this.programId,
        ),
        liquidatorRepaySource: getAssociatedTokenAddressSync(repayMint, liquidator, false, liquidityTokenProgram),
        liquidatorCollateralDest: shareAta(collateralShareMint, liquidator),
        collateralRiskConfig: riskConfigPda(collateralReserve, this.programId),
        protocolCollateralDest: protocolDest,
        liquidityTokenProgram,
        shareTokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .instruction();
  }

  async liquidate(
    liquidator: PublicKey,
    borrower: PublicKey,
    repayMint: PublicKey,
    collateralMint: PublicKey,
    amount: bigint,
  ): Promise<Transaction> {
    const liquidityTokenProgram = await this.liquidityTokenProgram(repayMint);
    const obligation = await this.requireObligation(borrower);
    const repayReserve = this.reserveAddress(repayMint);
    const collateralReserve = this.reserveAddress(collateralMint);
    const collateralShareMint = shareMintPda(collateralReserve, this.programId);
    const global = await this.getGlobal();
    if (!global) throw new Error('no Global account');
    const protocolDest = shareAta(collateralShareMint, global.feeDestination);

    const ix = await this.methods
      .liquidate(assertU64(amount))
      .accounts({
        global: globalPda(this.programId),
        obligation: obligation.address,
        liquidator,
        repayReserve,
        collateralReserve,
        repayOracle: oraclePda(this.market, repayMint, this.programId),
        collateralOracle: oraclePda(this.market, collateralMint, this.programId),
        repayLiquidityMint: repayMint,
        collateralShareMint,
        repayLiquidityVault: liquidityVaultPda(repayReserve, this.programId),
        obligationCollateralVault: obligationShareVaultPda(
          collateralReserve,
          obligation.address,
          this.programId,
        ),
        liquidatorRepaySource: getAssociatedTokenAddressSync(repayMint, liquidator, false, liquidityTokenProgram),
        liquidatorCollateralDest: shareAta(collateralShareMint, liquidator),
        collateralRiskConfig: riskConfigPda(collateralReserve, this.programId),
        protocolCollateralDest: protocolDest,
        liquidityTokenProgram,
        shareTokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .instruction();

    return this.tx(liquidator, [
      ...(await this.preludeIxs(obligation, [repayReserve, collateralReserve])),
      ix,
    ]);
  }

  // -----------------------------------------------------------------------

  private async requireObligation(owner: PublicKey): Promise<ObligationAccount> {
    const obligation = await this.getObligation(owner);
    if (!obligation) {
      throw new Error(
        `no obligation for ${owner.toBase58()} in market ${this.marketId}; call initObligation first`,
      );
    }
    return obligation;
  }

  private async tx(payer: PublicKey, instructions: TransactionInstruction[]): Promise<Transaction> {
    const transaction = new Transaction().add(...instructions);
    transaction.feePayer = payer;
    const { blockhash } = await this.connection.getLatestBlockhash();
    transaction.recentBlockhash = blockhash;
    return transaction;
  }
}

export { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID };
