/**
 * Building an `OracleConfig` for `set_oracle`.
 *
 * The one thing an operator configures about pricing is *where the number comes
 * from and what bounds it must respect* — never the number. This module makes
 * that shape hard to get wrong, and derives the two values nobody should be
 * typing by hand: the source account's owning program and its `ProgramData`
 * address.
 */

import { PublicKey } from '@solana/web3.js';
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

import { ORACLE_CONFIG, STAKE_POOL } from './params.js';
import { OracleSourceKind } from './oracle.js';

/** `BPFLoaderUpgradeab1e11111111111111111111111`. */
export const BPF_LOADER_UPGRADEABLE = new PublicKey(
  'BPFLoaderUpgradeab1e11111111111111111111111',
);

/**
 * The `ProgramData` address for a program.
 *
 * A PDA of `[program_id]` under the loader — the same derivation the program
 * performs on chain, so a caller cannot point Aera at some other account's
 * header. Verified against Cookie Chain: `GZgs5u…` derives to `6Dsx1c…`.
 */
export function programDataAddress(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([programId.toBytes()], BPF_LOADER_UPGRADEABLE)[0];
}

/** The movement bounds, as the instruction expects them. */
export interface BreakerConfigArgs {
  maxUpBpsPerEpoch: number;
  maxDownBpsPerEpoch: number;
  emergencyDeviationBps: number;
  maxEpochAllowance: bigint;
}

/** What `set_oracle` takes. */
export interface OracleConfigArgs {
  sourceKind: OracleSourceKind;
  sourceProgram: PublicKey;
  sourceAccount: PublicKey;
  maxWithdrawalFeeBps: number;
  rateFloor: bigint;
  rateCeiling: bigint;
  expectedDeploySlot: bigint;
  expectedUpgradeAuthority: PublicKey;
  breaker: BreakerConfigArgs;
}

/** Convert to the Anchor argument shape, with `BN` for every wide integer. */
export function toOracleConfig(config: OracleConfigArgs): any {
  return {
    sourceKind: config.sourceKind,
    sourceProgram: config.sourceProgram,
    sourceAccount: config.sourceAccount,
    maxWithdrawalFeeBps: config.maxWithdrawalFeeBps,
    rateFloor: new BN(config.rateFloor.toString()),
    rateCeiling: new BN(config.rateCeiling.toString()),
    expectedDeploySlot: new BN(config.expectedDeploySlot.toString()),
    expectedUpgradeAuthority: config.expectedUpgradeAuthority,
    breaker: {
      maxUpBpsPerEpoch: config.breaker.maxUpBpsPerEpoch,
      maxDownBpsPerEpoch: config.breaker.maxDownBpsPerEpoch,
      emergencyDeviationBps: config.breaker.emergencyDeviationBps,
      maxEpochAllowance: new BN(config.breaker.maxEpochAllowance.toString()),
    },
  };
}

/** All zeros: the sentinel for "the source program is immutable". */
export const NO_UPGRADE_AUTHORITY = PublicKey.default;

/**
 * The bounds Aera Core launches with, from the generated launch config.
 *
 * Shared by both source kinds so a reconfiguration cannot accidentally widen
 * the breaker while changing something else.
 */
function launchBreaker(): BreakerConfigArgs {
  return {
    maxUpBpsPerEpoch: ORACLE_CONFIG.maxUpBpsPerEpoch,
    maxDownBpsPerEpoch: ORACLE_CONFIG.maxDownBpsPerEpoch,
    emergencyDeviationBps: ORACLE_CONFIG.emergencyDeviationBps,
    // Wide on purpose: the per-epoch allowance is what actually bounds
    // movement, and a cap on accumulated allowance only matters for a source
    // left stale for months.
    maxEpochAllowance: 32n,
  };
}

/**
 * COOK: the unit of account.
 *
 * Reads no program and no account, so there is nothing to pin and nothing that
 * can be substituted. One COOK is one COOK because the debt is denominated in
 * COOK, not because anything reported it.
 */
export function unitOfAccountConfig(): OracleConfigArgs {
  return {
    sourceKind: OracleSourceKind.UnitOfAccount,
    sourceProgram: PublicKey.default,
    sourceAccount: PublicKey.default,
    maxWithdrawalFeeBps: 0,
    rateFloor: 1_000_000_000_000_000_000n,
    rateCeiling: 1_000_000_000_000_000_000n,
    expectedDeploySlot: 0n,
    expectedUpgradeAuthority: PublicKey.default,
    breaker: launchBreaker(),
  };
}

/**
 * bCOOK: derived from BakeYourStake's stake pool.
 *
 * Every identity comes from the generated launch config rather than an
 * argument, because these are facts about Cookie Chain and not choices. The
 * deploy slot in particular is load-bearing: a redeploy of the stake-pool
 * program moves it, every later observation is refused, and borrowing freezes
 * until a human reviews the new code and re-authorises it. See
 * `docs/KNOWN_RISKS.md` — that program's upgrade authority is a single wallet
 * key.
 */
export function nativeBcookConfig(): OracleConfigArgs {
  return {
    sourceKind: OracleSourceKind.NativeExchangeRate,
    sourceProgram: new PublicKey(STAKE_POOL.program),
    sourceAccount: new PublicKey(STAKE_POOL.pool),
    maxWithdrawalFeeBps: ORACLE_CONFIG.maxWithdrawalFeeBps,
    rateFloor: BigInt(ORACLE_CONFIG.rateFloor),
    rateCeiling: BigInt(ORACLE_CONFIG.rateCeiling),
    expectedDeploySlot: BigInt(STAKE_POOL.deploySlot),
    expectedUpgradeAuthority: new PublicKey(STAKE_POOL.upgradeAuthority),
    breaker: launchBreaker(),
  };
}

/**
 * `rate_receiver` on Cookie Chain: the Hyperlane recipient that stores stake
 * pools' books relayed from Solana. Not deployed yet; this is the address of
 * its deploy keypair.
 */
export const RATE_RECEIVER_PROGRAM_ID = new PublicKey(
  '9hJKVNswKR3uJUDGEErJtxwCA1fK4L64gpVLvetgAeag',
);

/** `["relayed_rate", stake_pool]` under the receiver: one feed per origin pool. */
export function relayedRateFeedAddress(
  stakePool: PublicKey,
  receiver: PublicKey = RATE_RECEIVER_PROGRAM_ID,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode('relayed_rate'), stakePool.toBytes()],
    receiver,
  )[0];
}

/** What a relayed oracle needs that the launch config does not already say. */
export interface RelayedRateArgs {
  /** The stake pool on the origin chain, e.g. Jito's on Solana. */
  stakePool: PublicKey;
  /** `rate_receiver`'s deployment, read from its `ProgramData` when configuring. */
  receiverDeploySlot: bigint;
  /** Its upgrade authority then, or `NO_UPGRADE_AUTHORITY` if immutable. */
  receiverUpgradeAuthority: PublicKey;
  receiver?: PublicKey;
}

/**
 * A stake pool's books relayed from another chain — JitoSOL first.
 *
 * Bounded exactly as bCOOK is, from the same launch config: the same fee
 * bound, rate band and breaker, the breaker counting the origin pool's epochs.
 * The deployment pinned is `rate_receiver`'s, because that is the program whose
 * bytes Aera reads.
 */
export function relayedRateConfig(args: RelayedRateArgs): OracleConfigArgs {
  const receiver = args.receiver ?? RATE_RECEIVER_PROGRAM_ID;
  return {
    sourceKind: OracleSourceKind.RelayedRate,
    sourceProgram: receiver,
    sourceAccount: relayedRateFeedAddress(args.stakePool, receiver),
    maxWithdrawalFeeBps: ORACLE_CONFIG.maxWithdrawalFeeBps,
    rateFloor: BigInt(ORACLE_CONFIG.rateFloor),
    rateCeiling: BigInt(ORACLE_CONFIG.rateCeiling),
    expectedDeploySlot: args.receiverDeploySlot,
    expectedUpgradeAuthority: args.receiverUpgradeAuthority,
    breaker: launchBreaker(),
  };
}
