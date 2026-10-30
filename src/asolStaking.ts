/**
 * aSOL staking: stake aSOL, earn SOL every second (`protocol/stake-program`).
 *
 * The pool streams a SOL budget funded by Aera to stakers, pro rata to stake
 * and time. Staked aSOL keeps earning Aera's lending yield in its exchange
 * rate; the stream is paid on top. When nobody is staked the stream's clock
 * stops, so the whole budget reaches stakers.
 *
 * Everything here mirrors the program byte for byte: account order, borsh
 * layouts and the reward arithmetic (`stream.rs`). The discriminators are
 * fixed constants so this module runs in the browser without a hasher.
 */
import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

export const ASOL_STAKE_PROGRAM_ID = new PublicKey('BJ3ntXXQGe1u4PLfMBNQWubU9T5C4Qsd2SwWZPkR1uvB');
/** aSOL: Aera market 1's SOL receipt. The staked token. */
export const ASOL_MINT = new PublicKey('FHv5bDrikq9sA4ckNNTsvqZHGoWYSnPMFJC8xHszKwbq');
/** Bridged SOL on Cookie. The reward token. */
export const COOKIE_SOL_MINT = new PublicKey('6tL24Fn75uCMrBSZAvohAq57LSv6KrY6ceEq1wonvucb');
export const ASOL_STAKE_ADMIN = new PublicKey('GqdCnvFd8ErGTSdz7VdYmMNNh4nvMMmuw7GAA5SQ6gRG');

/** Fixed-point scale of `rewardRate` and `rewardPerToken`. */
export const STREAM_PRECISION = 1_000_000_000_000_000_000n;
export const STREAM_MIN_DURATION = 86_400;
export const STREAM_MAX_DURATION = 365 * 86_400;
const SECONDS_PER_YEAR = 365n * 86_400n;

const DISCRIMINATOR = {
  initialize: [175, 175, 109, 31, 13, 152, 155, 237],
  fund: [218, 188, 111, 221, 152, 113, 174, 7],
  stake: [206, 176, 202, 18, 200, 209, 179, 108],
  unstake: [90, 95, 107, 42, 205, 124, 50, 225],
  claim: [62, 198, 214, 193, 213, 159, 108, 210],
  closePosition: [123, 134, 81, 0, 49, 68, 98, 98],
  setPaused: [91, 60, 125, 192, 176, 225, 166, 218],
  Pool: [241, 154, 109, 4, 17, 177, 109, 188],
  Position: [170, 188, 143, 228, 122, 64, 247, 208],
} as const;

// --- addresses ---------------------------------------------------------------

const pda = (...seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, ASOL_STAKE_PROGRAM_ID)[0];
const utf8 = (s: string) => new TextEncoder().encode(s);
export const asolStakePool = (): PublicKey => pda(utf8('pool'));
export const asolStakeVault = (): PublicKey => pda(utf8('stake_vault'));
export const asolRewardVault = (): PublicKey => pda(utf8('reward_vault'));
export const asolStakePosition = (owner: PublicKey): PublicKey => pda(utf8('position'), owner.toBytes());
const ata = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
export const asolAccount = (owner: PublicKey): PublicKey => ata(ASOL_MINT, owner);
export const cookieSolAccount = (owner: PublicKey): PublicKey => ata(COOKIE_SOL_MINT, owner);

// --- accounts ----------------------------------------------------------------

export interface Stream {
  totalStaked: bigint;
  /** Reward base units per second, scaled by `STREAM_PRECISION`. */
  rewardRate: bigint;
  periodFinish: bigint;
  lastUpdate: bigint;
  rewardPerToken: bigint;
}
export interface AsolStakePool {
  stream: Stream;
  funded: bigint;
  claimed: bigint;
  stakers: number;
  paused: boolean;
}
export interface AsolStakePosition {
  owner: PublicKey;
  amount: bigint;
  rewardPerTokenPaid: bigint;
  owed: bigint;
}

const u128 = (d: Uint8Array, at: number) => {
  const v = new DataView(d.buffer, d.byteOffset + at, 16);
  return v.getBigUint64(0, true) | (v.getBigUint64(8, true) << 64n);
};
const u64 = (d: Uint8Array, at: number) => new DataView(d.buffer, d.byteOffset + at, 8).getBigUint64(0, true);
const i64 = (d: Uint8Array, at: number) => new DataView(d.buffer, d.byteOffset + at, 8).getBigInt64(0, true);
function expect(d: Uint8Array, name: 'Pool' | 'Position', length: number) {
  if (d.length < length || !DISCRIMINATOR[name].every((b, i) => d[i] === b)) {
    throw new Error(`not an aSOL staking ${name} account`);
  }
}

export function decodeAsolStakePool(d: Uint8Array): AsolStakePool {
  expect(d, 'Pool', 86);
  return {
    stream: {
      totalStaked: u64(d, 8),
      rewardRate: u128(d, 16),
      periodFinish: i64(d, 32),
      lastUpdate: i64(d, 40),
      rewardPerToken: u128(d, 48),
    },
    funded: u64(d, 64),
    claimed: u64(d, 72),
    stakers: new DataView(d.buffer, d.byteOffset + 80, 4).getUint32(0, true),
    paused: d[84] === 1,
  };
}

export function decodeAsolStakePosition(d: Uint8Array): AsolStakePosition {
  expect(d, 'Position', 73);
  return {
    owner: new PublicKey(d.subarray(8, 40)),
    amount: u64(d, 40),
    rewardPerTokenPaid: u128(d, 48),
    owed: u64(d, 64),
  };
}

// --- the stream, off chain ---------------------------------------------------

/** `Stream::update`: the accumulator brought up to `now` (unix seconds). */
export function streamAt(s: Stream, now: bigint): Stream {
  const next = { ...s };
  if (s.totalStaked === 0n) {
    if (s.periodFinish > s.lastUpdate) next.periodFinish = now + (s.periodFinish - s.lastUpdate);
    next.lastUpdate = now > s.lastUpdate ? now : s.lastUpdate;
    return next;
  }
  const end = now < s.periodFinish ? now : s.periodFinish;
  if (end > s.lastUpdate) {
    next.rewardPerToken = s.rewardPerToken + (s.rewardRate * (end - s.lastUpdate)) / s.totalStaked;
    next.lastUpdate = end;
  }
  return next;
}

/** SOL base units a position could claim at `now`. */
export function pendingRewards(pool: AsolStakePool, position: AsolStakePosition | null, now: bigint): bigint {
  if (!position) return 0n;
  const s = streamAt(pool.stream, now);
  return position.owed + (position.amount * (s.rewardPerToken - position.rewardPerTokenPaid)) / STREAM_PRECISION;
}

/**
 * `Stream::fund`, after `update(now)`: `amount` joins everything still unpaid,
 * all of it streamed over `durationSeconds` from `now`.
 */
export function streamAfterFund(s: Stream, amount: bigint, durationSeconds: bigint, now: bigint): Stream {
  if (amount <= 0n || durationSeconds < BigInt(STREAM_MIN_DURATION) || durationSeconds > BigInt(STREAM_MAX_DURATION)) {
    throw new Error('a budget is a positive amount streamed over 1 to 365 days');
  }
  const next = streamAt(s, now);
  const start = now > next.lastUpdate ? now : next.lastUpdate;
  const leftover = next.periodFinish > start ? next.rewardRate * (next.periodFinish - start) : 0n;
  return { ...next, rewardRate: (amount * STREAM_PRECISION + leftover) / durationSeconds, lastUpdate: start, periodFinish: start + durationSeconds };
}

/**
 * Seconds the current budget still has to run, counted the way `fund` counts
 * them: from `now`, or from where the clock stopped while nobody is staked.
 */
export function streamSecondsLeft(s: Stream, now: bigint): bigint {
  const next = streamAt(s, now);
  const start = now > next.lastUpdate ? now : next.lastUpdate;
  return next.periodFinish > start ? next.periodFinish - start : 0n;
}

/** SOL base units still to be streamed after `now`. */
export function streamRemaining(pool: AsolStakePool, now: bigint): bigint {
  const s = pool.stream;
  const from = s.totalStaked === 0n ? s.lastUpdate : now > s.lastUpdate ? now : s.lastUpdate;
  const left = s.periodFinish > from ? s.periodFinish - from : 0n;
  return (s.rewardRate * left) / STREAM_PRECISION;
}

/** True while there is budget left to stream (with the clock running or stopped). */
export function streamActive(pool: AsolStakePool, now: bigint): boolean {
  return streamRemaining(pool, now) > 0n;
}

/**
 * The stream's reward APR, as a fraction (0.25 = 25%), for a pool holding
 * `totalStaked` aSOL plus `extraStake` more. `asolPerSolE9` is aSOL's value in
 * SOL scaled by 1e9 (Aera's share rate; 1e9 at par). Null when there is no
 * budget left, or no stake to divide it by.
 *
 * This is the rate at today's stake and budget, not a promise: it falls as
 * stake joins and ends when the budget does.
 */
export function rewardApr(pool: AsolStakePool, now: bigint, asolPerSolE9 = 1_000_000_000n, extraStake = 0n): number | null {
  if (!streamActive(pool, now)) return null;
  const staked = pool.stream.totalStaked + extraStake;
  if (staked === 0n) return null;
  const stakedSol = (staked * asolPerSolE9) / 1_000_000_000n;
  if (stakedSol === 0n) return null;
  const perYear = (pool.stream.rewardRate * SECONDS_PER_YEAR) / STREAM_PRECISION;
  // Four decimal places of a fraction is plenty for display.
  return Number((perYear * 1_000_000n) / stakedSol) / 1_000_000;
}

/** A wallet's share of the stream right now: `amount / totalStaked`. */
export function stakeShare(pool: AsolStakePool, position: AsolStakePosition | null): number {
  if (!position || pool.stream.totalStaked === 0n) return 0;
  return Number((position.amount * 1_000_000n) / pool.stream.totalStaked) / 1_000_000;
}

// --- reading -----------------------------------------------------------------

export interface AsolStakingState {
  pool: AsolStakePool | null;
  position: AsolStakePosition | null;
}

/** The pool, and the owner's position if any, in one RPC round trip. */
export async function fetchAsolStaking(connection: Connection, owner?: PublicKey): Promise<AsolStakingState> {
  const keys = [asolStakePool(), ...(owner ? [asolStakePosition(owner)] : [])];
  const [pool, position] = await connection.getMultipleAccountsInfo(keys, 'confirmed');
  return {
    pool: pool && pool.owner.equals(ASOL_STAKE_PROGRAM_ID) ? decodeAsolStakePool(pool.data) : null,
    position: position && position.owner.equals(ASOL_STAKE_PROGRAM_ID) ? decodeAsolStakePosition(position.data) : null,
  };
}

// --- instructions --------------------------------------------------------------

const w = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
const s = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: true, isWritable: false });
function data(name: keyof typeof DISCRIMINATOR, ...args: Array<['u64' | 'i64', bigint] | ['bool', boolean]>): Buffer {
  const parts = [Buffer.from(DISCRIMINATOR[name])];
  for (const [kind, value] of args) {
    const b = Buffer.alloc(kind === 'bool' ? 1 : 8);
    if (kind === 'u64') b.writeBigUInt64LE(value as bigint);
    else if (kind === 'i64') b.writeBigInt64LE(value as bigint);
    else b[0] = value ? 1 : 0;
    parts.push(b);
  }
  return Buffer.concat(parts);
}
const ix = (keys: AccountMeta[], body: Buffer) => new TransactionInstruction({ programId: ASOL_STAKE_PROGRAM_ID, keys, data: body });

export function initializeAsolStakingIx(admin = ASOL_STAKE_ADMIN): TransactionInstruction {
  return ix(
    [w(admin, true), w(asolStakePool()), w(asolStakeVault()), w(asolRewardVault()), r(ASOL_MINT), r(COOKIE_SOL_MINT), r(TOKEN_2022_PROGRAM_ID), r(SystemProgram.programId)],
    data('initialize'),
  );
}

/** Add `amount` SOL base units, streamed with everything unpaid over `durationSeconds`. */
export function fundAsolStakingIx(amount: bigint, durationSeconds: bigint, admin = ASOL_STAKE_ADMIN): TransactionInstruction {
  if (amount <= 0n) throw new Error('fund a positive amount');
  if (durationSeconds < BigInt(STREAM_MIN_DURATION) || durationSeconds > BigInt(STREAM_MAX_DURATION)) {
    throw new Error('a budget streams over 1 to 365 days');
  }
  return ix(
    [s(admin), w(cookieSolAccount(admin)), w(asolStakePool()), w(asolRewardVault()), r(COOKIE_SOL_MINT), r(TOKEN_2022_PROGRAM_ID)],
    data('fund', ['u64', amount], ['i64', durationSeconds]),
  );
}

/** The arguments of a `fund` instruction's data, or null for any other instruction. */
export function decodeFundAsolStakingData(d: Uint8Array): { amount: bigint; durationSeconds: bigint } | null {
  if (d.length !== 24 || !DISCRIMINATOR.fund.every((b, i) => d[i] === b)) return null;
  return { amount: u64(d, 8), durationSeconds: i64(d, 16) };
}

export function stakeAsolIx(owner: PublicKey, amount: bigint): TransactionInstruction {
  if (amount <= 0n) throw new Error('stake a positive amount');
  return ix(
    [w(owner, true), w(asolStakePosition(owner)), w(asolAccount(owner)), w(asolStakePool()), w(asolStakeVault()), r(ASOL_MINT), r(TOKEN_2022_PROGRAM_ID), r(SystemProgram.programId)],
    data('stake', ['u64', amount]),
  );
}

export function unstakeAsolIx(owner: PublicKey, amount: bigint): TransactionInstruction {
  if (amount <= 0n) throw new Error('unstake a positive amount');
  return ix(
    [s(owner), w(asolStakePosition(owner)), w(asolAccount(owner)), w(asolStakePool()), w(asolStakeVault()), r(ASOL_MINT), r(TOKEN_2022_PROGRAM_ID)],
    data('unstake', ['u64', amount]),
  );
}

export function claimAsolRewardsIx(owner: PublicKey): TransactionInstruction {
  return ix(
    [s(owner), w(asolStakePosition(owner)), w(cookieSolAccount(owner)), w(asolStakePool()), w(asolRewardVault()), r(COOKIE_SOL_MINT), r(TOKEN_2022_PROGRAM_ID)],
    data('claim'),
  );
}

export function closeAsolPositionIx(owner: PublicKey): TransactionInstruction {
  return ix([w(owner, true), w(asolStakePosition(owner)), w(asolStakePool())], data('closePosition'));
}

export function setAsolStakingPausedIx(paused: boolean, admin = ASOL_STAKE_ADMIN): TransactionInstruction {
  return ix([s(admin), w(asolStakePool())], data('setPaused', ['bool', paused]));
}

// --- what a wallet sends ---------------------------------------------------------

/** Stake. The wallet already holds aSOL, so its aSOL account exists. */
export function stakeAsolIxs(owner: PublicKey, amount: bigint): TransactionInstruction[] {
  return [stakeAsolIx(owner, amount)];
}

/** Unstake, creating the wallet's aSOL account if it closed it meanwhile. */
export function unstakeAsolIxs(owner: PublicKey, amount: bigint): TransactionInstruction[] {
  return [
    createAssociatedTokenAccountIdempotentInstruction(owner, asolAccount(owner), owner, ASOL_MINT, TOKEN_2022_PROGRAM_ID),
    unstakeAsolIx(owner, amount),
  ];
}

/** Claim SOL rewards, creating the wallet's SOL account if it has none. */
export function claimAsolRewardsIxs(owner: PublicKey): TransactionInstruction[] {
  return [
    createAssociatedTokenAccountIdempotentInstruction(owner, cookieSolAccount(owner), owner, COOKIE_SOL_MINT, TOKEN_2022_PROGRAM_ID),
    claimAsolRewardsIx(owner),
  ];
}

/** Unstake everything and claim in one transaction, then return the position's rent. */
export function exitAsolStakingIxs(owner: PublicKey, position: AsolStakePosition): TransactionInstruction[] {
  return [
    ...(position.amount > 0n ? unstakeAsolIxs(owner, position.amount) : []),
    ...claimAsolRewardsIxs(owner),
    closeAsolPositionIx(owner),
  ];
}
