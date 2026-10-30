/**
 * BakeYourStake's pool, as the loop reads and drives it.
 *
 * The account is built here byte by byte in the SPL layout, the way
 * `oracle/native_bcook.rs` builds its own test pool, so these pin the walk
 * through the variable-width tail as well as the arithmetic. The figures that
 * matter most are the rounding ones: spl-stake-pool floors conversions and
 * rounds fees up, and a loop that plans a lock one base unit larger than the
 * deposit minted is refused on chain.
 *
 * `scripts/loop-check.ts` holds the same arithmetic against the live pool by
 * simulation; this holds it without a chain.
 */

import { PublicKey, StakeProgram, SystemProgram, SYSVAR_CLOCK_PUBKEY, SYSVAR_STAKE_HISTORY_PUBKEY } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  STAKE_POOL_ACCOUNT_LEN,
  applyStakePoolFee,
  decodeStakePool,
  depositSolIx,
  feeBps,
  lamportsForWithdrawal,
  poolTokensForDeposit,
  poolTokensForLamports,
  withdrawSolIx,
  withdrawableLamports,
  type StakePoolFee,
} from '../src/index.js';

const POOL = new PublicKey('GxbNKNYdtNXQkhDkpHdLDAMX64GxaECgANqdfp6cUGH4');
const PROGRAM = new PublicKey('GZgs5uREPp6BvDt8eysmhavQPAHBAtjePgV4zfhgd9pH');
const RESERVE = new PublicKey('GAw1vRQ8R3ohDsSgGZV58dc32W7jYhHtc8DzuiVdvm8F');
const MINT = new PublicKey('EkPafx58mgwkEnGwo62jXhXDAdJ37Z8G8MFBRPsr9uhz');
const MANAGER_FEE = new PublicKey('6Fzdzi3LHJnqSfCLo3XuRcnZGoxAePyQHg3P8NsXPFZ1');
const OWNER = new PublicKey('GqdCnvFd8ErGTSdz7VdYmMNNh4nvMMmuw7GAA5SQ6gRG');
const AUTHORITY = new PublicKey('22v7PjUXNu8t9JJhZYFhsS1TFgkqqTxJtq3ZQdy85CyR');

interface PoolBytes {
  totalLamports?: bigint;
  poolTokenSupply?: bigint;
  solDepositFee?: StakePoolFee;
  solWithdrawalFee?: StakePoolFee;
  solReferralFeePercent?: number;
  solDepositAuthority?: PublicKey | null;
  solWithdrawAuthority?: PublicKey | null;
  nextSolWithdrawalFee?: StakePoolFee | null;
  preferredDeposit?: PublicKey | null;
  length?: number;
  accountType?: number;
  nextEpochFeeTag?: number;
}

const bps = (value: number): StakePoolFee => ({ denominator: 10_000n, numerator: BigInt(value) });

/** A StakePool account in the SPL layout, with the live pool's figures by default. */
function poolAccount(options: PoolBytes = {}): Buffer {
  const data = Buffer.alloc(options.length ?? STAKE_POOL_ACCOUNT_LEN);
  data[0] = options.accountType ?? 1;
  RESERVE.toBuffer().copy(data, 130);
  MINT.toBuffer().copy(data, 162);
  MANAGER_FEE.toBuffer().copy(data, 194);
  TOKEN_PROGRAM_ID.toBuffer().copy(data, 226);
  data.writeBigUInt64LE(options.totalLamports ?? 125_915_890_119_686_032n, 258);
  data.writeBigUInt64LE(options.poolTokenSupply ?? 93_335_506_152_503_196n, 266);
  data.writeBigUInt64LE(58n, 274);

  let at = 330;
  const fee = (value: StakePoolFee) => {
    data.writeBigUInt64LE(value.denominator, at);
    data.writeBigUInt64LE(value.numerator, at + 8);
    at += 16;
  };
  const optionKey = (key: PublicKey | null | undefined) => {
    if (!key) {
      data[at++] = 0;
      return;
    }
    data[at++] = 1;
    key.toBuffer().copy(data, at);
    at += 32;
  };
  const future = (value: StakePoolFee | null | undefined, tag = value ? 1 : 0) => {
    data[at++] = tag;
    if (value) fee(value);
  };

  fee(bps(1)); // epoch_fee
  future(null, options.nextEpochFeeTag ?? 0); // next_epoch_fee
  optionKey(options.preferredDeposit); // preferred deposit validator
  optionKey(null); // preferred withdraw validator
  fee(bps(50)); // stake_deposit_fee
  fee(bps(200)); // stake_withdrawal_fee
  future(null); // next_stake_withdrawal_fee
  data[at++] = 0; // stake_referral_fee
  optionKey(options.solDepositAuthority);
  fee(options.solDepositFee ?? bps(50));
  data[at++] = options.solReferralFeePercent ?? 0;
  optionKey(options.solWithdrawAuthority);
  fee(options.solWithdrawalFee ?? bps(200));
  future(options.nextSolWithdrawalFee);
  data.writeBigUInt64LE(93_360_854_310_043_739n, at);
  data.writeBigUInt64LE(125_539_090_934_760_937n, at + 8);
  return data;
}

test('the live pool decodes: its mint, reserve and both SOL fees', () => {
  const pool = decodeStakePool(POOL, poolAccount(), PROGRAM);
  assert.equal(pool.poolMint.toBase58(), MINT.toBase58());
  assert.equal(pool.reserveStake.toBase58(), RESERVE.toBase58());
  assert.equal(pool.managerFeeAccount.toBase58(), MANAGER_FEE.toBase58());
  assert.equal(pool.tokenProgram.toBase58(), TOKEN_PROGRAM_ID.toBase58());
  assert.equal(feeBps(pool.solDepositFee), 50);
  assert.equal(feeBps(pool.solWithdrawalFee), 200);
  assert.equal(feeBps(pool.stakeWithdrawalFee), 200);
  assert.equal(pool.solDepositAuthority, null);
  assert.equal(pool.solWithdrawAuthority, null);
  assert.equal(pool.nextSolWithdrawalFee, null);
  assert.equal(pool.lastUpdateEpoch, 58n);
  assert.equal(
    pool.withdrawAuthority.toBase58(),
    PublicKey.findProgramAddressSync([POOL.toBuffer(), Buffer.from('withdraw')], PROGRAM)[0].toBase58(),
  );
});

test('the fees are found by walking the tags, not at a fixed offset', () => {
  // Every Some shifts what follows by 32 bytes; a positional read would land in the middle of a key.
  const pool = decodeStakePool(
    POOL,
    poolAccount({
      preferredDeposit: OWNER,
      solDepositAuthority: AUTHORITY,
      solWithdrawAuthority: AUTHORITY,
      solDepositFee: bps(75),
      solWithdrawalFee: bps(125),
      nextSolWithdrawalFee: bps(300),
    }),
    PROGRAM,
  );
  assert.equal(feeBps(pool.solDepositFee), 75);
  assert.equal(feeBps(pool.solWithdrawalFee), 125);
  assert.equal(pool.solDepositAuthority?.toBase58(), AUTHORITY.toBase58());
  assert.equal(pool.solWithdrawAuthority?.toBase58(), AUTHORITY.toBase58());
  assert.equal(pool.nextSolWithdrawalFee && feeBps(pool.nextSolWithdrawalFee), 300);
});

test('an account that is not exactly a stake pool is refused, as the oracle refuses it', () => {
  assert.throws(() => decodeStakePool(POOL, poolAccount({ length: 610 }), PROGRAM), /611/);
  assert.throws(() => decodeStakePool(POOL, poolAccount({ length: 612 }), PROGRAM), /611/);
  assert.throws(() => decodeStakePool(POOL, poolAccount({ accountType: 2 }), PROGRAM), /not a stake pool/);
  assert.throws(() => decodeStakePool(POOL, poolAccount({ nextEpochFeeTag: 3 }), PROGRAM), /out of range/);
  assert.throws(
    () => decodeStakePool(POOL, poolAccount({ solWithdrawalFee: { denominator: 100n, numerator: 101n } }), PROGRAM),
    /above 100%/,
  );
});

test('a deposit fee rounds up: 1 COOK mints 0.742564882 bCOOK, as measured on BakeYourStake', () => {
  // floor(1e9 x 746_296_364 / 1e9) = 746_296_364 minted; ceil(0.5%) = 3_731_482 of it is the fee.
  const pool = decodeStakePool(POOL, poolAccount({ totalLamports: 1_000_000_000n, poolTokenSupply: 746_296_364n }), PROGRAM);
  assert.equal(applyStakePoolFee(746_296_364n, pool.solDepositFee), 3_731_482n);
  assert.equal(poolTokensForDeposit(1_000_000_000n, pool), 742_564_882n);
});

test('the referral share of a deposit fee comes back to a depositor who is their own referrer', () => {
  const pool = decodeStakePool(
    POOL,
    poolAccount({ totalLamports: 1_000_000_000n, poolTokenSupply: 1_000_000_000n, solReferralFeePercent: 40 }),
    PROGRAM,
  );
  // 5_000_000 fee on 1e9 minted; 40% of it, 2_000_000, is paid to the referral account.
  assert.equal(poolTokensForDeposit(1_000_000_000n, pool), 997_000_000n);
});

test('a withdrawal fee rounds up: 51 bCOOK redeem for no more than 50 do', () => {
  const pool = decodeStakePool(POOL, poolAccount({ totalLamports: 2_000n, poolTokenSupply: 1_000n }), PROGRAM);
  // 2% of 50 is exactly 1; 2% of 51 is 1.02, charged as 2. Both burn 49.
  assert.equal(lamportsForWithdrawal(50n, pool), 98n);
  assert.equal(lamportsForWithdrawal(51n, pool), 98n);
  assert.equal(lamportsForWithdrawal(1n, pool), 0n, 'a single token is all fee');
});

test('the fewest bCOOK that redeem for an amount, exactly', () => {
  const pool = decodeStakePool(POOL, poolAccount(), PROGRAM);
  for (const lamports of [1n, 999n, 1_000_000_000n, 123_456_789_012n, 600_000_000_000_000n]) {
    const tokens = poolTokensForLamports(lamports, pool);
    assert.ok(tokens !== null);
    assert.ok(lamportsForWithdrawal(tokens, pool) >= lamports, `${tokens} pays at least ${lamports}`);
    assert.ok(lamportsForWithdrawal(tokens - 1n, pool) < lamports, `${tokens - 1n} does not`);
  }
  const allFee = decodeStakePool(POOL, poolAccount({ solWithdrawalFee: { denominator: 1n, numerator: 1n } }), PROGRAM);
  assert.equal(poolTokensForLamports(1n, allFee), null, 'a 100% fee pays nothing for any amount');
});

test('the reserve pays out everything above its rent-exempt minimum, and nothing when delegated', () => {
  const stake = Buffer.alloc(200);
  stake.writeUInt32LE(1, 0); // Initialized
  stake.writeBigUInt64LE(2_282_880n, 4); // Meta.rent_exempt_reserve
  assert.equal(withdrawableLamports({ lamports: 124_574_686_091_581_890n, data: stake }), 124_574_686_089_299_009n);
  assert.equal(withdrawableLamports({ lamports: 2_282_881, data: stake }), 0n);
  stake.writeUInt32LE(2, 0); // Stake: the program refuses WithdrawSol from a delegated reserve
  assert.equal(withdrawableLamports({ lamports: 124_574_686_091_581_890n, data: stake }), 0n);
});

test('DepositSol and WithdrawSol carry the SPL account order and their tags', () => {
  const pool = decodeStakePool(POOL, poolAccount(), PROGRAM);
  const ata = getAssociatedTokenAddressSync(MINT, OWNER, true, TOKEN_PROGRAM_ID);

  const deposit = depositSolIx({ pool, depositor: OWNER, lamports: 1_234_567_890n });
  assert.equal(deposit.programId.toBase58(), PROGRAM.toBase58());
  assert.equal(deposit.data[0], 14);
  assert.equal(deposit.data.readBigUInt64LE(1), 1_234_567_890n);
  assert.deepEqual(
    deposit.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
    [
      [POOL.toBase58(), false, true],
      [pool.withdrawAuthority.toBase58(), false, false],
      [RESERVE.toBase58(), false, true],
      [OWNER.toBase58(), true, true],
      [ata.toBase58(), false, true],
      [MANAGER_FEE.toBase58(), false, true],
      [ata.toBase58(), false, true],
      [MINT.toBase58(), false, true],
      [SystemProgram.programId.toBase58(), false, false],
      [TOKEN_PROGRAM_ID.toBase58(), false, false],
    ],
  );

  const withdrawal = withdrawSolIx({ pool, owner: OWNER, poolTokens: 987_654_321n });
  assert.equal(withdrawal.data[0], 16);
  assert.equal(withdrawal.data.readBigUInt64LE(1), 987_654_321n);
  assert.deepEqual(
    withdrawal.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
    [
      [POOL.toBase58(), false, true],
      [pool.withdrawAuthority.toBase58(), false, false],
      [OWNER.toBase58(), true, false],
      [ata.toBase58(), false, true],
      [RESERVE.toBase58(), false, true],
      [OWNER.toBase58(), false, true],
      [MANAGER_FEE.toBase58(), false, true],
      [MINT.toBase58(), false, true],
      [SYSVAR_CLOCK_PUBKEY.toBase58(), false, false],
      [SYSVAR_STAKE_HISTORY_PUBKEY.toBase58(), false, false],
      [StakeProgram.programId.toBase58(), false, false],
      [TOKEN_PROGRAM_ID.toBase58(), false, false],
    ],
  );
});

test('a pool that needs its own signature to deposit or redeem is never built against', () => {
  const pool = decodeStakePool(POOL, poolAccount({ solDepositAuthority: AUTHORITY, solWithdrawAuthority: AUTHORITY }), PROGRAM);
  assert.throws(() => depositSolIx({ pool, depositor: OWNER, lamports: 1n }), /deposit authority/);
  assert.throws(() => withdrawSolIx({ pool, owner: OWNER, poolTokens: 1n }), /withdraw authority/);
});
