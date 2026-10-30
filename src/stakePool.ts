/**
 * BakeYourStake, driven directly: staking COOK for bCOOK and redeeming it.
 *
 * bCOOK is an ordinary SPL stake pool token, so both directions are the stake
 * pool program's own instructions, with no website and no backend in the path:
 *
 *   DepositSol (14)   lamports in, bCOOK minted at the pool's rate, less its
 *                     SOL-deposit fee
 *   WithdrawSol (16)  bCOOK burned, lamports paid out of the pool's reserve at
 *                     the pool's rate, less its SOL-withdrawal fee. It fails if
 *                     the reserve would fall below its rent-exempt minimum,
 *                     which is why `withdrawableLamports` reads the reserve
 *                     before anything is planned against it.
 *
 * Both refuse while the pool has not been updated for the current epoch
 * (`StakeListAndPoolOutOfDate`), and both refuse when the pool names its own
 * SOL deposit or withdrawal authority, whose signature nobody else can supply.
 * `solDepositAuthority` and `solWithdrawAuthority` say which.
 *
 * ## Reading the pool
 *
 * The layout is the SPL stake pool's. The fixed prefix is read at its offsets;
 * everything after `epoch_fee` is reached by walking the tags of the
 * variable-width fields, exactly as the program's own oracle does in
 * `oracle/native_bcook.rs`, including its refusal of an account that is not
 * 611 bytes or not a stake pool. A tag outside its range throws rather than
 * being skipped. The fees therefore come from the account, not from a
 * measurement: `scripts/loop-check.ts` simulates both directions against these
 * figures and fails if either disagrees by one base unit.
 *
 * ## The arithmetic
 *
 * Mirrors spl-stake-pool: token and lamport conversions floor, and a `Fee`
 * rounds up (`Fee::apply`), so the depositor and the redeemer each receive the
 * floor of what the rate predicts.
 */

import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  PublicKey,
  StakeProgram,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_STAKE_HISTORY_PUBKEY,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';

import { FIXED_POINT_SCALE } from './constants.js';
import { LAUNCH } from './launch.generated.js';

export const STAKE_POOL_PROGRAM_ID = new PublicKey(LAUNCH.stakePool.program);
export const BCOOK_STAKE_POOL = new PublicKey(LAUNCH.stakePool.pool);

const DEPOSIT_SOL = 14;
const WITHDRAW_SOL = 16;

/** `spl_stake_pool::state::AccountType::StakePool`. */
const ACCOUNT_TYPE_STAKE_POOL = 1;
/** The serialized `StakePool`, checked exactly as `native_bcook.rs` checks it. */
export const STAKE_POOL_ACCOUNT_LEN = 611;

// Fixed prefix, in declaration order.
const OFF_RESERVE_STAKE = 130;
const OFF_POOL_MINT = 162;
const OFF_MANAGER_FEE_ACCOUNT = 194;
const OFF_TOKEN_PROGRAM = 226;
const OFF_TOTAL_LAMPORTS = 258;
const OFF_POOL_TOKEN_SUPPLY = 266;
const OFF_LAST_UPDATE_EPOCH = 274;
const OFF_EPOCH_FEE = 330;
const FEE_LEN = 16;

/** `Fee { denominator, numerator }`. A zero denominator is the pool's "no fee". */
export interface StakePoolFee {
  numerator: bigint;
  denominator: bigint;
}

/** What building and pricing a deposit or withdrawal needs, read from the pool account. */
export interface StakePoolState {
  address: PublicKey;
  programId: PublicKey;
  reserveStake: PublicKey;
  poolMint: PublicKey;
  managerFeeAccount: PublicKey;
  /** The pool token's program. bCOOK is legacy SPL; read, not assumed. */
  tokenProgram: PublicKey;
  withdrawAuthority: PublicKey;
  totalLamports: bigint;
  poolTokenSupply: bigint;
  lastUpdateEpoch: bigint;
  /** `total / supply`, FIXED_POINT_SCALE-scaled and floored: COOK per bCOOK before fees. */
  grossRate: bigint;
  solDepositFee: StakePoolFee;
  /** Percent of the deposit fee paid to the referral account. */
  solReferralFeePercent: number;
  solWithdrawalFee: StakePoolFee;
  stakeWithdrawalFee: StakePoolFee;
  /** A SOL withdrawal fee the pool has scheduled for a coming epoch, or null. */
  nextSolWithdrawalFee: StakePoolFee | null;
  /** When set, DepositSol needs this key's signature and nobody else can deposit. */
  solDepositAuthority: PublicKey | null;
  /** When set, WithdrawSol needs this key's signature and nobody else can redeem. */
  solWithdrawAuthority: PublicKey | null;
}

export function decodeStakePool(address: PublicKey, data: Uint8Array, programId: PublicKey = STAKE_POOL_PROGRAM_ID): StakePoolState {
  if (data.length !== STAKE_POOL_ACCOUNT_LEN) {
    throw new Error(`stake pool account is ${data.length} bytes; a StakePool is ${STAKE_POOL_ACCOUNT_LEN}`);
  }
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (bytes[0] !== ACCOUNT_TYPE_STAKE_POOL) throw new Error(`account type ${bytes[0]} is not a stake pool`);

  const key = (offset: number) => new PublicKey(bytes.subarray(offset, offset + 32));
  const fee = (offset: number): StakePoolFee => {
    const denominator = bytes.readBigUInt64LE(offset);
    const numerator = bytes.readBigUInt64LE(offset + 8);
    if (denominator !== 0n && numerator > denominator) throw new Error('stake pool fee is above 100%');
    return { numerator, denominator };
  };

  // The variable-width tail, walked tag by tag.
  let at = OFF_EPOCH_FEE + FEE_LEN;
  const tag = (widths: number[]): { tag: number; start: number } => {
    const value = bytes[at];
    const width = value === undefined ? undefined : widths[value];
    if (width === undefined) throw new Error(`stake pool tag ${value} at byte ${at} is out of range`);
    const start = at + 1;
    at = start + width;
    return { tag: value!, start };
  };
  const futureFee = () => {
    const { tag: variant, start } = tag([0, FEE_LEN, FEE_LEN]);
    return variant === 0 ? null : fee(start);
  };
  const optionKey = () => {
    const { tag: variant, start } = tag([0, 32]);
    return variant === 0 ? null : key(start);
  };
  const fixedFee = () => {
    const value = fee(at);
    at += FEE_LEN;
    return value;
  };
  const u8 = () => {
    const value = bytes[at];
    if (value === undefined) throw new Error('stake pool account ends early');
    at += 1;
    return value;
  };

  futureFee(); // next_epoch_fee
  optionKey(); // preferred_deposit_validator_vote_address
  optionKey(); // preferred_withdraw_validator_vote_address
  fixedFee(); // stake_deposit_fee
  const stakeWithdrawalFee = fixedFee();
  futureFee(); // next_stake_withdrawal_fee
  u8(); // stake_referral_fee
  const solDepositAuthority = optionKey();
  const solDepositFee = fixedFee();
  const solReferralFeePercent = u8();
  const solWithdrawAuthority = optionKey();
  const solWithdrawalFee = fixedFee();
  const nextSolWithdrawalFee = futureFee();
  if (at + 16 > bytes.length) throw new Error('stake pool account ends before its last-epoch totals');

  const totalLamports = bytes.readBigUInt64LE(OFF_TOTAL_LAMPORTS);
  const poolTokenSupply = bytes.readBigUInt64LE(OFF_POOL_TOKEN_SUPPLY);
  if (poolTokenSupply === 0n || totalLamports === 0n) throw new Error('stake pool holds nothing');
  const [withdrawAuthority] = PublicKey.findProgramAddressSync([address.toBuffer(), Buffer.from('withdraw')], programId);

  return {
    address,
    programId,
    reserveStake: key(OFF_RESERVE_STAKE),
    poolMint: key(OFF_POOL_MINT),
    managerFeeAccount: key(OFF_MANAGER_FEE_ACCOUNT),
    tokenProgram: key(OFF_TOKEN_PROGRAM),
    withdrawAuthority,
    totalLamports,
    poolTokenSupply,
    lastUpdateEpoch: bytes.readBigUInt64LE(OFF_LAST_UPDATE_EPOCH),
    grossRate: (totalLamports * FIXED_POINT_SCALE) / poolTokenSupply,
    solDepositFee,
    solReferralFeePercent,
    solWithdrawalFee,
    stakeWithdrawalFee,
    nextSolWithdrawalFee,
    solDepositAuthority,
    solWithdrawAuthority,
  };
}

/** A fee in basis points, rounded up, for display. */
export const feeBps = (fee: StakePoolFee): number =>
  fee.denominator === 0n ? 0 : Number((fee.numerator * 10_000n + fee.denominator - 1n) / fee.denominator);

/** `Fee::apply`: the fee on `amount`, rounded up. */
export const applyStakePoolFee = (amount: bigint, fee: StakePoolFee): bigint =>
  fee.denominator === 0n ? 0n : (amount * fee.numerator + fee.denominator - 1n) / fee.denominator;

type Pricing = Pick<StakePoolState, 'totalLamports' | 'poolTokenSupply'>;

/**
 * bCOOK a `DepositSol` of `lamports` mints to the depositor.
 *
 * The referral share of the fee is paid to the referral account, which
 * `depositSolIx` makes the depositor's own; it is added back here for the same
 * reason.
 */
export function poolTokensForDeposit(lamports: bigint, pool: Pricing & Pick<StakePoolState, 'solDepositFee' | 'solReferralFeePercent'>): bigint {
  const minted = (lamports * pool.poolTokenSupply) / pool.totalLamports;
  const fee = applyStakePoolFee(minted, pool.solDepositFee);
  const referral = (fee * BigInt(pool.solReferralFeePercent)) / 100n;
  return minted - fee + referral;
}

/** Lamports a `WithdrawSol` of `poolTokens` pays out. */
export function lamportsForWithdrawal(poolTokens: bigint, pool: Pricing & Pick<StakePoolState, 'solWithdrawalFee'>): bigint {
  const burnt = poolTokens - applyStakePoolFee(poolTokens, pool.solWithdrawalFee);
  return (burnt * pool.totalLamports) / pool.poolTokenSupply;
}

/**
 * The fewest bCOOK whose redemption pays at least `lamports`, or null when no
 * amount does (a 100% fee).
 *
 * The fee's rounding leaves no closed-form inverse, but a redemption never pays
 * less for more tokens, so a binary search over `lamportsForWithdrawal` finds
 * the exact answer.
 */
export function poolTokensForLamports(lamports: bigint, pool: Pricing & Pick<StakePoolState, 'solWithdrawalFee'>): bigint | null {
  if (lamports <= 0n) return 0n;
  let high = (lamports * pool.poolTokenSupply) / pool.totalLamports + 1n;
  for (let doubling = 0; lamportsForWithdrawal(high, pool) < lamports; doubling += 1) {
    if (doubling === 64) return null;
    high *= 2n;
  }
  let low = 0n;
  while (high - low > 1n) {
    const middle = (low + high) / 2n;
    if (lamportsForWithdrawal(middle, pool) >= lamports) high = middle;
    else low = middle;
  }
  return high;
}

/**
 * Lamports `WithdrawSol` can take from the pool's reserve now.
 *
 * The program refuses a withdrawal that would leave the reserve below its
 * rent-exempt minimum, and refuses outright when the reserve is not an
 * initialized, undelegated stake account. One lamport is kept back beyond the
 * minimum, for versions of the program that required it.
 */
export function withdrawableLamports(reserve: { lamports: number | bigint; data: Uint8Array }): bigint {
  const bytes = Buffer.from(reserve.data.buffer, reserve.data.byteOffset, reserve.data.byteLength);
  if (bytes.length < 12 || bytes.readUInt32LE(0) !== 1) return 0n;
  const minimum = bytes.readBigUInt64LE(4) + 1n;
  const lamports = BigInt(reserve.lamports);
  return lamports > minimum ? lamports - minimum : 0n;
}

/**
 * `DepositSol`: stake `lamports` of the depositor's native COOK for bCOOK.
 *
 * The bCOOK lands in the depositor's associated account, which must exist; the
 * referral account is that same account, so any referral share of the fee
 * comes back to the depositor.
 */
export function depositSolIx(input: { pool: StakePoolState; depositor: PublicKey; lamports: bigint }): TransactionInstruction {
  const { pool, depositor, lamports } = input;
  if (pool.solDepositAuthority) throw new Error('this stake pool only accepts SOL deposits signed by its own deposit authority');
  const destination = getAssociatedTokenAddressSync(pool.poolMint, depositor, true, pool.tokenProgram);
  const data = Buffer.alloc(9);
  data.writeUInt8(DEPOSIT_SOL, 0);
  data.writeBigUInt64LE(lamports, 1);
  return new TransactionInstruction({
    programId: pool.programId,
    data,
    keys: [
      { pubkey: pool.address, isSigner: false, isWritable: true },
      { pubkey: pool.withdrawAuthority, isSigner: false, isWritable: false },
      { pubkey: pool.reserveStake, isSigner: false, isWritable: true },
      { pubkey: depositor, isSigner: true, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: pool.managerFeeAccount, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: pool.poolMint, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: pool.tokenProgram, isSigner: false, isWritable: false },
    ],
  });
}

/**
 * `WithdrawSol`: burn `poolTokens` of the owner's bCOOK and receive lamports
 * from the pool's reserve, directly to the owner's wallet.
 */
export function withdrawSolIx(input: { pool: StakePoolState; owner: PublicKey; poolTokens: bigint }): TransactionInstruction {
  const { pool, owner, poolTokens } = input;
  if (pool.solWithdrawAuthority) throw new Error('this stake pool only allows SOL withdrawals signed by its own withdraw authority');
  const source = getAssociatedTokenAddressSync(pool.poolMint, owner, true, pool.tokenProgram);
  const data = Buffer.alloc(9);
  data.writeUInt8(WITHDRAW_SOL, 0);
  data.writeBigUInt64LE(poolTokens, 1);
  return new TransactionInstruction({
    programId: pool.programId,
    data,
    keys: [
      { pubkey: pool.address, isSigner: false, isWritable: true },
      { pubkey: pool.withdrawAuthority, isSigner: false, isWritable: false },
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: pool.reserveStake, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: true },
      { pubkey: pool.managerFeeAccount, isSigner: false, isWritable: true },
      { pubkey: pool.poolMint, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_STAKE_HISTORY_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: StakeProgram.programId, isSigner: false, isWritable: false },
      { pubkey: pool.tokenProgram, isSigner: false, isWritable: false },
    ],
  });
}
