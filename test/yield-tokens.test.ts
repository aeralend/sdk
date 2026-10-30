import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import {
  decodeYieldEpoch,
  decodeYieldReceipt,
  yieldAuctionPrice,
  yieldBuyIx,
  yieldClaimIx,
  yieldClaimIxs,
  yieldCost,
  yieldDepositIx,
  yieldEpoch,
  yieldHarvestIx,
  yieldMatureIx,
  yieldOpenEpochIx,
  yieldOwed,
  yieldPhase,
  yieldTerms,
  type YieldEpoch,
  type YieldReceipt,
} from '../src/index.js';

/** Written by the program's own tests (`protocol/yield-program/tests/program.rs`). */
const golden = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'protocol', 'yield-golden.json'), 'utf8'),
) as Record<string, any>;
const owner = new PublicKey(golden.owner);
const id = BigInt(golden.id);
const epoch = yieldEpoch(id);
const ADMIN = new PublicKey('GqdCnvFd8ErGTSdz7VdYmMNNh4nvMMmuw7GAA5SQ6gRG');

const metas = (ix: TransactionInstruction) => ix.keys.map((k) => `${k.pubkey.toBase58()}|${Number(k.isSigner)}|${Number(k.isWritable)}`);
const hexOf = (b: Uint8Array) => Buffer.from(b).toString('hex');
const same = (ix: TransactionInstruction, name: string) => {
  assert.deepEqual(metas(ix), golden[name].keys, `${name}: accounts`);
  assert.equal(hexOf(ix.data), golden[name].data, `${name}: data`);
};

test('every instruction matches the program byte for byte', () => {
  same(yieldOpenEpochIx(ADMIN, id, { depositStart: 10, auctionStart: 20, auctionEnd: 30, maturity: 40, capValue: 50n, startPriceBps: 600, endPriceBps: 70 }), 'open');
  same(yieldDepositIx(epoch, owner, 123n), 'deposit');
  same(yieldBuyIx(epoch, owner, 456n, 789), 'buy');
  same(yieldHarvestIx(epoch), 'harvest');
  same(yieldMatureIx(epoch), 'mature');
  same(yieldClaimIx(epoch, owner), 'claim');
});

test('accounts decode field by field', () => {
  const e = decodeYieldEpoch(epoch, Buffer.from(golden.epochAccount, 'hex'));
  assert.equal(e.id, 3n);
  assert.deepEqual([e.depositStart, e.auctionStart, e.auctionEnd, e.maturity], [10, 20, 30, 40]);
  assert.deepEqual([e.capValue, e.startPriceBps, e.endPriceBps], [50n, 600, 70]);
  assert.deepEqual([e.totalAsol, e.totalValue, e.soldUnits, e.proceeds], [11n, 12n, 13n, 14n]);
  assert.equal(e.rewardPerUnit, (1n << 70n) + 15n);
  assert.equal(e.harvested, 16n);
  assert.equal(e.matured, true);
  assert.deepEqual([e.maturityRate, e.ptAsol, e.appreciationPerUnit], [17n, 18n, (1n << 65n) + 19n]);
  const r = decodeYieldReceipt(PublicKey.default, Buffer.from(golden.receiptAccount, 'hex'));
  assert.ok(r.epoch.equals(epoch) && r.owner.equals(owner));
  assert.deepEqual([r.value, r.bought, r.units, r.settled], [21n, 22n, 23n, true]);
  assert.equal(r.rewardPaid, (1n << 80n) + 24n);
  assert.deepEqual([r.proceedsClaimed, r.ptClaimed, r.appreciationClaimed], [true, false, true]);
  assert.throws(() => decodeYieldEpoch(epoch, Buffer.from(golden.receiptAccount, 'hex')), /Epoch/);
});

const DAY = 86_400;
const base: YieldEpoch = {
  address: epoch, id: 1n, depositStart: 0, auctionStart: DAY, auctionEnd: 2 * DAY, maturity: 32 * DAY,
  capValue: 100_000_000_000n, startPriceBps: 1_000, endPriceBps: 100, totalAsol: 4_000_000_000n, totalValue: 4_200_000_000n,
  soldUnits: 2_100_000_000n, proceeds: 115_500_000n, rewardPerUnit: 0n, harvested: 0n, matured: false, maturityRate: 0n,
  ptAsol: 0n, appreciationPerUnit: 0n,
};

test('the auction falls in a straight line, and what a price means', () => {
  assert.equal(yieldAuctionPrice(base, DAY), 1_000);
  assert.equal(yieldAuctionPrice(base, DAY + DAY / 2), 550);
  assert.equal(yieldAuctionPrice(base, 99 * DAY), 100);
  assert.equal(yieldCost(2_100_000_000n, 550), 115_500_000n);
  assert.equal(yieldCost(3n, 550), 1n, 'rounded up, as the program does');
  const t = yieldTerms(base, 550);
  assert.ok(Math.abs(t.fixedApr - 0.055 * 365 / 30) < 1e-9, `${t.fixedApr}`);
  assert.ok(Math.abs(t.leverage - 10_000 / 550) < 1e-9);
  assert.equal(yieldPhase(base, DAY / 2), 'deposits');
  assert.equal(yieldPhase(base, DAY + 1), 'auction');
  assert.equal(yieldPhase(base, 10 * DAY), 'running');
  assert.equal(yieldPhase(base, 40 * DAY), 'maturing');
  assert.equal(yieldPhase({ ...base, matured: true }, 40 * DAY), 'matured');
});

test('owed mirrors the program: proceeds, rewards, principal, rise', () => {
  const r: YieldReceipt = {
    address: PublicKey.default, epoch, owner, value: 1_050_000_000n, bought: 0n, units: 0n, settled: false,
    rewardPaid: 0n, proceedsClaimed: false, ptClaimed: false, appreciationClaimed: false,
  };
  const E18 = 1_000_000_000_000_000_000n;
  const e = { ...base, rewardPerUnit: (960_000_000n * E18) / 4_200_000_000n, matured: true, ptAsol: 3_809_523_809n, appreciationPerUnit: (190_476_191n * E18) / 4_200_000_000n };
  const o = yieldOwed(e, r);
  assert.equal(o.units, 525_000_000n, 'a quarter of the unsold half');
  assert.equal(o.proceeds, 115_500_000n / 4n);
  assert.ok(o.rewards >= 119_999_998n && o.rewards <= 120_000_000n, `${o.rewards}`);
  assert.equal(o.principal, 952_380_952n);
  assert.ok(o.appreciation >= 23_809_522n && o.appreciation <= 23_809_524n, `${o.appreciation}`);
});

test('a claim carries the harvest, or the maturing once it is due', () => {
  const running = yieldClaimIxs(base, owner, 10 * DAY);
  assert.equal(running.length, 2);
  assert.equal(hexOf(running[0]!.data), golden.harvest.data);
  const due = yieldClaimIxs(base, owner, 40 * DAY);
  assert.equal(hexOf(due[0]!.data), golden.mature.data);
  assert.equal(yieldClaimIxs({ ...base, matured: true }, owner, 40 * DAY).length, 1);
});
