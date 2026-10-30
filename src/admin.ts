/**
 * Admin instructions.
 *
 * Kept out of `AeraClient` on purpose: nothing a normal user does needs these,
 * and mixing "create the protocol" into the same surface as "supply COOK"
 * invites a front end to render a button for it.
 *
 * Every method returns an unsigned instruction; the caller assembles and signs.
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
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';

import { AeraClient } from './client.js';
import { OracleSourceKind, readsSourceAccount } from './oracle.js';
import { programDataAddress, toOracleConfig, type OracleConfigArgs } from './oracleConfig.js';
import {
  globalPda,
  liquidityVaultPda,
  marketPda,
  oraclePda,
  reservePda,
  riskConfigPda,
  shareMintPda,
} from './pda.js';
import type { ReserveConfig, ShareMetadata } from './types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** `ReserveConfig` as Anchor wants it: BN for the u64 fields. */
const encodeConfig = (config: ReserveConfig) => ({
  loanToValueBps: config.loanToValueBps,
  liquidationThresholdBps: config.liquidationThresholdBps,
  liquidationBonusBps: config.liquidationBonusBps,
  closeFactorBps: config.closeFactorBps,
  collateralHaircutBps: config.collateralHaircutBps,
  optimalUtilizationBps: config.optimalUtilizationBps,
  minBorrowRateBps: config.minBorrowRateBps,
  optimalBorrowRateBps: config.optimalBorrowRateBps,
  maxBorrowRateBps: config.maxBorrowRateBps,
  reserveFactorBps: config.reserveFactorBps,
  originationFeeBps: config.originationFeeBps,
  supplyCap: new BN(config.supplyCap.toString()),
  borrowCap: new BN(config.borrowCap.toString()),
  perWalletSupplyCap: new BN(config.perWalletSupplyCap.toString()),
  borrowEnabled: config.borrowEnabled,
  collateralEnabled: config.collateralEnabled,
  isolated: config.isolated,
  slotsPerYear: new BN(config.slotsPerYear.toString()),
});

export class AeraAdmin {
  constructor(private readonly client: AeraClient) {}

  private get methods(): any {
    return (this.client as unknown as { methods: any }).methods;
  }

  private get programId(): PublicKey {
    return this.client.programId;
  }

  /** Create the protocol instance. Runs once per deployment. */
  async initGlobal(
    admin: PublicKey,
    feeDestination: PublicKey,
  ): Promise<TransactionInstruction> {
    return this.methods
      .initGlobal(feeDestination)
      .accounts({
        global: globalPda(this.programId),
        admin,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  /** Create a risk-isolated market. Aera Core is market 0. */
  async initMarket(
    admin: PublicKey,
    marketId: number,
    name: string,
    quoteCurrencyMint: PublicKey,
  ): Promise<TransactionInstruction> {
    return this.methods
      .initMarket(new BN(marketId), name)
      .accounts({
        global: globalPda(this.programId),
        admin,
        market: marketPda(marketId, this.programId),
        quoteCurrencyMint,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  /**
   * Move one reserve off its v0.1 guardian feed and onto the derived oracle.
   *
   * Send one per reserve **in a single transaction**, then `migrateGlobal`.
   * That is a recommendation about downtime rather than safety: the partial
   * states are safe by construction and `test_half_migrated.rs` holds seventeen
   * of them to it. But liquidation is among the things blocked while a market
   * is half migrated, and a market that cannot close bad positions accumulates
   * them.
   *
   * The v0.1 `PriceFeed` is closed and its rent returned to the admin. Its
   * contents -- five guardians' last agreed median -- are discarded unread:
   * carrying that number into v0.2 would give the new oracle an anchor the new
   * oracle never validated. The reference is bootstrapped from the stake pool
   * through the same path every later refresh uses.
   *
   * The instruction asserts on chain that no economic field moved, and reverts
   * if one did.
   */
  async migrateReserve(
    admin: PublicKey,
    mint: PublicKey,
    config: OracleConfigArgs,
  ): Promise<TransactionInstruction> {
    const market = this.client.market;
    const remaining =
      config.sourceKind === OracleSourceKind.NativeExchangeRate
        ? [
            { pubkey: config.sourceAccount, isSigner: false, isWritable: false },
            {
              pubkey: programDataAddress(config.sourceProgram),
              isSigner: false,
              isWritable: false,
            },
          ]
        : [];

    return this.methods
      .migrateReserveToV2(toOracleConfig(config))
      .accounts({
        global: globalPda(this.programId),
        market,
        reserve: reservePda(market, mint, this.programId),
        // v0.1's feed, seeded differently from the v0.2 oracle so the two can
        // never be confused for one another.
        legacyPriceFeed: PublicKey.findProgramAddressSync(
          [Buffer.from('price_feed'), market.toBytes(), mint.toBytes()],
          this.programId,
        )[0],
        liquidityMint: mint,
        oracle: oraclePda(market, mint, this.programId),
        admin,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(remaining)
      .instruction();
  }

  /**
   * Stamp the protocol version. Last, after every reserve has migrated.
   *
   * Grows `Global` by the single `version` byte. Until this lands, every v0.2
   * instruction that takes `Global` refuses -- which is the gate that stops
   * v0.2 logic running against v0.1 state, not a fault.
   */
  async migrateGlobal(admin: PublicKey): Promise<TransactionInstruction> {
    return this.methods
      .migrateGlobalToV2()
      .accounts({
        global: globalPda(this.programId),
        admin,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  /**
   * Configure where one mint's rate is derived from, and the bounds it must
   * stay inside.
   *
   * Never the rate itself. There is no instruction in the program that accepts
   * one, which is the whole difference between this and v0.1's `setOracle` --
   * that one registered five keys whose word the protocol then took.
   *
   * Must run before `initReserve` for that mint: the reserve binds to the
   * oracle by seed and the account has to exist.
   *
   * Reconfiguring a live oracle drops it back to `Bootstrapping` whenever the
   * source or the deployment pin changes, so it cannot inherit trust earned by
   * the source it replaced. Budget an epoch of no new borrowing for that.
   */
  async setOracle(
    admin: PublicKey,
    mint: PublicKey,
    config: OracleConfigArgs,
  ): Promise<TransactionInstruction> {
    return this.methods
      .setOracle(toOracleConfig(config))
      .accounts({
        global: globalPda(this.programId),
        admin,
        market: this.client.market,
        oracle: oraclePda(this.client.market, mint, this.programId),
        mint,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  /**
   * Clear a breaker freeze by re-anchoring to whatever the source currently
   * reports.
   *
   * The admin chooses *when*, never *what*: the instruction reads the live
   * source through the same validation path a refresh uses, so there is no
   * value for an operator to supply and none for them to get wrong. It cannot
   * be used to wave through a redeployed source program -- the deployment pin
   * still applies, and clearing that needs a deliberate `setOracle`.
   */
  async resetOracleBreaker(admin: PublicKey, mint: PublicKey): Promise<TransactionInstruction> {
    const oracle = oraclePda(this.client.market, mint, this.programId);
    const state = await this.client.getOracleState(mint);
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
      .resetOracleBreaker()
      .accounts({
        global: globalPda(this.programId),
        oracle,
        market: this.client.market,
        admin,
      })
      .remainingAccounts(remaining)
      .instruction();
  }

  /**
   * Create a reserve, its vault, and its share mint.
   *
   * The share mint is Token-2022 carrying MetadataPointer + TokenMetadata, so
   * `metadata` is what aCOOK will call itself. Both the mint authority and the
   * metadata update authority are the reserve PDA; there is no premint and no
   * freeze authority.
   */
  async initReserve(
    admin: PublicKey,
    liquidityMint: PublicKey,
    config: ReserveConfig,
    metadata: ShareMetadata,
  ): Promise<TransactionInstruction> {
    const liquidityTokenProgram = await this.client.liquidityTokenProgram(liquidityMint);
    const market = this.client.market;
    const reserve = reservePda(market, liquidityMint, this.programId);

    return this.methods
      .initReserve(encodeConfig(config), metadata)
      .accounts({
        global: globalPda(this.programId),
        admin,
        market,
        reserve,
        liquidityMint,
        liquidityVault: liquidityVaultPda(reserve, this.programId),
        shareMint: shareMintPda(reserve, this.programId),
        oracle: oraclePda(market, liquidityMint, this.programId),
        // Two programs: the liquidity mint is whatever it already is, the share
        // mint is always Token-2022.
        liquidityTokenProgram,
        shareTokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  /**
   * Change a reserve's parameters.
   *
   * Tightening applies immediately; loosening queues behind the timelock. The
   * program decides which, by comparing to the live config.
   */
  async setParams(
    admin: PublicKey,
    liquidityMint: PublicKey,
    config: ReserveConfig,
  ): Promise<TransactionInstruction> {
    return this.methods
      .setParams(encodeConfig(config))
      .accounts({
        global: globalPda(this.programId),
        admin,
        reserve: reservePda(this.client.market, liquidityMint, this.programId),
        market: this.client.market,
      })
      .instruction();
  }

  /** Drop a queued change without applying it. Admin only. */
  async cancelPendingParams(admin: PublicKey, liquidityMint: PublicKey): Promise<TransactionInstruction> {
    return this.methods
      .cancelPendingParams()
      .accounts({
        global: globalPda(this.programId),
        admin,
        reserve: reservePda(this.client.market, liquidityMint, this.programId),
        market: this.client.market,
      })
      .instruction();
  }

  /** Apply a queued change once its timelock has elapsed. Permissionless. */
  async applyPendingParams(liquidityMint: PublicKey): Promise<TransactionInstruction> {
    return this.methods
      .applyPendingParams()
      .accounts({
        reserve: reservePda(this.client.market, liquidityMint, this.programId),
      })
      .instruction();
  }

  /**
   * Set a reserve's per-wallet borrow cap and Aera's share of its liquidation bonus.
   *
   * Creates the reserve's `RiskConfig` on first use, paid by the admin. A change
   * that tightens both values lands at once; anything that raises either one is
   * queued behind the global timelock and needs {@link applyPendingRiskConfig}.
   * The share belongs on the COLLATERAL reserve, beside the bonus it divides.
   */
  async setRiskConfig(
    admin: PublicKey,
    liquidityMint: PublicKey,
    limits: { perWalletBorrowCap: bigint; protocolLiquidationShareBps: number },
  ): Promise<TransactionInstruction> {
    const reserve = reservePda(this.client.market, liquidityMint, this.programId);
    return this.methods
      .setRiskConfig(new BN(limits.perWalletBorrowCap.toString()), limits.protocolLiquidationShareBps)
      .accounts({
        global: globalPda(this.programId),
        admin,
        reserve,
        riskConfig: riskConfigPda(reserve, this.programId),
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  /** Promote a queued risk-limit change once its timelock has elapsed. Permissionless. */
  async applyPendingRiskConfig(liquidityMint: PublicKey): Promise<TransactionInstruction> {
    const reserve = reservePda(this.client.market, liquidityMint, this.programId);
    return this.methods
      .applyPendingRiskConfig()
      .accounts({
        global: globalPda(this.programId),
        reserve,
        riskConfig: riskConfigPda(reserve, this.programId),
      })
      .instruction();
  }

  private pauseControl(admin: PublicKey) {
    return { global: globalPda(this.programId), admin };
  }

  async pauseBorrow(admin: PublicKey): Promise<TransactionInstruction> {
    return this.methods.pauseBorrow().accounts(this.pauseControl(admin)).instruction();
  }

  async pauseAll(admin: PublicKey): Promise<TransactionInstruction> {
    return this.methods.pauseAll().accounts(this.pauseControl(admin)).instruction();
  }

  async unpause(admin: PublicKey): Promise<TransactionInstruction> {
    return this.methods.unpause().accounts(this.pauseControl(admin)).instruction();
  }

  /** Repoint where the protocol's cut of interest is paid. */
  async setFeeDestination(
    admin: PublicKey,
    feeDestination: PublicKey,
  ): Promise<TransactionInstruction> {
    return this.methods
      .setFeeDestination(feeDestination)
      .accounts(this.pauseControl(admin))
      .instruction();
  }

  /** Move the admin key. */
  async setAdmin(admin: PublicKey, newAdmin: PublicKey): Promise<TransactionInstruction> {
    return this.methods.setAdmin(newAdmin).accounts(this.pauseControl(admin)).instruction();
  }

  /** Clear a latched circuit breaker. Deliberately explicit. */
  async resetCircuitBreaker(admin: PublicKey, mint: PublicKey): Promise<TransactionInstruction> {
    return this.methods
      .resetCircuitBreaker()
      .accounts({
        global: globalPda(this.programId),
        admin,
        oracle: oraclePda(this.client.market, mint, this.programId),
      })
      .instruction();
  }
}
