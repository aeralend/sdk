/**
 * Telling a v0.1 deployment from a v0.2 one, without crashing on either.
 *
 * The migration was designed so that the *length* of an account is its version:
 * `Global.version` was appended last, so a v0.1 `Global` is exactly one byte
 * short of the v0.2 struct and Anchor's decoder refuses it. That refusal is the
 * gate that stops v0.2 logic running against v0.1 state, and
 * `test_half_migrated.rs` depends on it.
 *
 * It also means any tool that reads `Global` with the v0.2 decoder throws a
 * buffer-bounds error against a live pre-migration deployment — which is
 * exactly what happened the first time the monitor was pointed at the real
 * chain:
 *
 * ```text
 *   RangeError: The value of "offset" is out of range. It must be >= 0 and <= 74. Received 75
 * ```
 *
 * That is the correct behaviour hidden behind an incomprehensible message. An
 * operator seeing it during a launch would reasonably conclude the tooling was
 * broken rather than that the protocol had not been migrated yet.
 *
 * So: read the raw account, decide the era from its length, and say so.
 */

import { PublicKey, type Connection } from '@solana/web3.js';

/** Serialized length of a v0.1 `Global`: discriminator + fields, no version. */
export const GLOBAL_V1_LEN = 8 + 32 + 32 + 1 + 1 + 8 + 1;

/** v0.2 appends a single `version` byte. */
export const GLOBAL_V2_LEN = GLOBAL_V1_LEN + 1;

export const GLOBAL_VERSION_V1 = 0;
export const GLOBAL_VERSION_V2 = 2;

export type Era = 'v0.1' | 'v0.2' | 'absent' | 'unknown';

export interface DeploymentEra {
  era: Era;
  /** The account's length, which is what the era is derived from. */
  length: number | null;
  /** The `version` byte, present only in v0.2. */
  version: number | null;
  /** A sentence an operator can act on. */
  explanation: string;
}

/**
 * Which version of Aera is deployed at this `Global`.
 *
 * Reads bytes rather than decoding, so it works in both eras and cannot throw
 * on the one it is trying to identify.
 */
export async function readDeploymentEra(
  connection: Connection,
  global: PublicKey,
): Promise<DeploymentEra> {
  const info = await connection.getAccountInfo(global, 'confirmed');

  if (!info) {
    return {
      era: 'absent',
      length: null,
      version: null,
      explanation:
        'no Global account at this address. Either the protocol has never been ' +
        'initialised here, or the program id is wrong.',
    };
  }

  const length = info.data.length;

  if (length === GLOBAL_V1_LEN) {
    return {
      era: 'v0.1',
      length,
      version: null,
      explanation:
        `Global is ${length} bytes, which is v0.1: it has no version field. This ` +
        'deployment has not been migrated. v0.2 instructions that take Global will ' +
        'refuse until migrate_global_to_v2 runs, which is the intended gate, not a ' +
        'fault. Repay and accrue take no Global and keep working throughout.',
    };
  }

  if (length === GLOBAL_V2_LEN) {
    const version = info.data[GLOBAL_V1_LEN] ?? null;
    return {
      era: 'v0.2',
      length,
      version,
      explanation:
        version === GLOBAL_VERSION_V2
          ? `Global is ${length} bytes and stamped version ${version}: migrated to v0.2.`
          : `Global is v0.2-sized but stamped version ${version}, not ` +
            `${GLOBAL_VERSION_V2}. The realloc landed and the stamp did not — ` +
            'finish migrate_global_to_v2.',
    };
  }

  return {
    era: 'unknown',
    length,
    version: null,
    explanation:
      `Global is ${length} bytes, which matches neither v0.1 (${GLOBAL_V1_LEN}) nor ` +
      `v0.2 (${GLOBAL_V2_LEN}). Do not proceed: this is not an Aera Global, or it is ` +
      'from a version this tooling does not know.',
  };
}

/**
 * Whether every reserve in a market has been repointed to a v0.2 oracle.
 *
 * A market is fully migrated when `Global` deserialises *and* every reserve's
 * `oracle` holds an `OracleState`. There is no flag on chain saying so
 * deliberately -- `instructions::admin::migrate` explains why a flag would be
 * worse than deriving it -- so this derives it.
 */
export interface MigrationStatus {
  global: DeploymentEra;
  reserves: { address: string; oracle: string; migrated: boolean }[];
  complete: boolean;
  explanation: string;
}
