import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import {
  ASOL_STAKE_PROGRAM_ID,
  STREAM_PRECISION,
  asolStakePool,
  asolStakePosition,
  claimAsolRewardsIx,
  decodeAsolStakePool,
  decodeAsolStakePosition,
  exitAsolStakingIxs,
  fundAsolStakingIx,
  pendingRewards,
  rewardApr,
  stakeAsolIx,
  streamAt,
  streamRemaining,
  type AsolStakePool,
} from '../src/asolStaking.js';

/** Account bytes written by the program itself (`fixture_for_the_sdk`). */
const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'protocol', 'stake-accounts.json'), 'utf8'),
) as { owner: string; pool: string; position: string; now: number; pending: number; remaining: number };
const SOL = 1_000_000_000n;
const DAY = 86_400n;

test('decodes the program’s own accounts', () => {
  const pool = decodeAsolStakePool(Buffer.from(fixture.pool, 'base64'));
  const position = decodeAsolStakePosition(Buffer.from(fixture.position, 'base64'));
  assert.equal(pool.funded, 7n * SOL);
  assert.equal(pool.claimed, 0n);
  assert.equal(pool.stakers, 1);
  assert.equal(pool.paused, false);
  assert.equal(pool.stream.totalStaked, 3n * SOL);
  assert.equal(position.owner.toBase58(), fixture.owner);
  assert.equal(position.amount, 3n * SOL);
  assert.throws(() => decodeAsolStakePool(Buffer.from(fixture.position, 'base64')), /not an aSOL staking Pool/);
});

test('pending rewards and remaining budget match the program’s arithmetic', () => {
  const pool = decodeAsolStakePool(Buffer.from(fixture.pool, 'base64'));
  const position = decodeAsolStakePosition(Buffer.from(fixture.position, 'base64'));
  const now = BigInt(fixture.now);
  assert.equal(pendingRewards(pool, position, now), BigInt(fixture.pending));
  assert.equal(streamRemaining(pool, now), BigInt(fixture.remaining));
  // 7 SOL over 30 days from the first stake on day 3; six days later 7/5 of a SOL
  // has streamed, and all of it to the only staker.
  assert.ok(BigInt(fixture.pending) + BigInt(fixture.remaining) <= 7n * SOL);
  assert.ok(7n * SOL - BigInt(fixture.pending) - BigInt(fixture.remaining) <= 2n);
});

test('discriminators are Anchor’s', () => {
  const disc = (s: string) => createHash('sha256').update(s).digest().subarray(0, 8);
  const owner = new PublicKey('GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB');
  assert.deepEqual(stakeAsolIx(owner, 1n).data.subarray(0, 8), disc('global:stake'));
  assert.deepEqual(claimAsolRewardsIx(owner).data.subarray(0, 8), disc('global:claim'));
  assert.deepEqual(fundAsolStakingIx(SOL, DAY).data.subarray(0, 8), disc('global:fund'));
  assert.deepEqual(Buffer.from(fixture.pool, 'base64').subarray(0, 8), disc('account:Pool'));
  assert.deepEqual(Buffer.from(fixture.position, 'base64').subarray(0, 8), disc('account:Position'));
});

test('addresses and instruction shapes', () => {
  const owner = new PublicKey(fixture.owner);
  const stake = stakeAsolIx(owner, 5n);
  assert.ok(stake.programId.equals(ASOL_STAKE_PROGRAM_ID));
  assert.ok(stake.keys[0]!.isSigner && stake.keys[0]!.pubkey.equals(owner));
  assert.ok(stake.keys[1]!.pubkey.equals(asolStakePosition(owner)));
  assert.ok(stake.keys[3]!.pubkey.equals(asolStakePool()));
  assert.equal(stake.data.readBigUInt64LE(8), 5n);
  const fund = fundAsolStakingIx(2n * SOL, 30n * DAY);
  assert.equal(fund.data.readBigUInt64LE(8), 2n * SOL);
  assert.equal(fund.data.readBigInt64LE(16), 30n * DAY);
  assert.throws(() => fundAsolStakingIx(SOL, DAY - 1n), /1 to 365 days/);
  assert.throws(() => stakeAsolIx(owner, 0n), /positive/);
  // Exit: unstake (with its account), claim (with its account), close.
  const exit = exitAsolStakingIxs(owner, { owner, amount: 3n, rewardPerTokenPaid: 0n, owed: 0n });
  assert.equal(exit.length, 5);
});

const pool = (totalStaked: bigint, budget: bigint, seconds: bigint, start = 0n): AsolStakePool => ({
  stream: {
    totalStaked,
    rewardRate: (budget * STREAM_PRECISION) / seconds,
    periodFinish: start + seconds,
    lastUpdate: start,
    rewardPerToken: 0n,
  },
  funded: budget,
  claimed: 0n,
  stakers: totalStaked > 0n ? 1 : 0,
  paused: false,
});

test('APR is the budget’s yearly pace over what is staked', () => {
  // 0.5 SOL over 30 days on 2 SOL staked: 0.5 * 365/30 / 2 = 304%.
  const apr = rewardApr(pool(2n * SOL, SOL / 2n, 30n * DAY), 0n);
  assert.ok(apr !== null && Math.abs(apr - 3.0416) < 0.001, `apr ${apr}`);
  // It falls as stake joins.
  const at10 = rewardApr(pool(2n * SOL, SOL / 2n, 30n * DAY), 0n, 1_000_000_000n, 8n * SOL);
  assert.ok(at10 !== null && Math.abs(at10 - 0.6083) < 0.001, `apr ${at10}`);
  // aSOL worth more SOL means a lower APR on the same budget.
  const premium = rewardApr(pool(2n * SOL, SOL / 2n, 30n * DAY), 0n, 1_100_000_000n);
  assert.ok(premium !== null && premium < apr!);
  // No budget left, or nobody staked: no number to show.
  assert.equal(rewardApr(pool(2n * SOL, SOL / 2n, 30n * DAY), 31n * DAY), null);
  assert.equal(rewardApr(pool(0n, SOL / 2n, 30n * DAY), 0n), null);
});

test('the off-chain clock stops while nobody is staked', () => {
  const empty = pool(0n, SOL, 10n * DAY);
  const later = streamAt(empty.stream, 5n * DAY);
  assert.equal(later.periodFinish, 15n * DAY);
  // Five idle days later, nothing has been spent.
  assert.equal(streamRemaining(empty, 5n * DAY), streamRemaining(empty, 0n));
  assert.ok(SOL - streamRemaining(empty, 0n) <= 1n);
});
