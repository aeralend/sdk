/**
 * The signed COOK price's SDK surface (src/cookFeed.ts), pinned to the `cook`
 * section of the program's golden file
 * (`protocol/perps-v2/perps-program/tests/fixtures/perps-bcook-golden.json`,
 * written by `tests/golden.rs`). The program is the authority.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import {
  COOK_BOUNDS, COOK_DISC, COOK_FEED_ID, COOK_FEED_SPACE, PERPS_PROGRAM_ID, applyCookFeedIx, cancelCookFeedIx, cookCapacity, cookFeedAccount, cookSettingsApplyAtOnce,
  cookSettingsProblems, cookValue, decodeCookFeed, effectiveCookSettings, encodeCookPackage, encodeCookSettings, initCookFeedIx, lamportsPerMillionCook,
  postPoolPriceIx, postSignedCookIx, setCookFeedIx, splitCookValue,
  type CookPackage, type CookSettings, type PoolPin,
} from '../src/index.js';

const FIXTURES = new URL('./fixtures/protocol/', import.meta.url);
const golden = JSON.parse(readFileSync(new URL('perps-bcook-golden.json', FIXTURES), 'utf8'));
const cook = golden.cook;
const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');
type Ix = { keys: [string, boolean, boolean][]; data: string };
function same(actual: TransactionInstruction, expected: Ix, name: string) {
  assert.ok(actual.programId.equals(PERPS_PROGRAM_ID), `${name}: program`);
  assert.deepEqual(actual.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), expected.keys, `${name}: accounts`);
  assert.equal(toHex(actual.data), expected.data, `${name}: data`);
}
const ADMIN = new PublicKey(golden.constants.admin);
const keeper = new PublicKey(Uint8Array.from({ length: 32 }, () => 0x33));
const signed: CookSettings = { source: 1, shareBps: 300, fenceBps: 2_500, spreadBps: 150, leashBps: 500, ceilingUsdMicros: 1_500_000_000n, minDepth: 50_000_000_000n };
const back: CookSettings = { ...signed, source: 0 };
const pkg = (i: number): CookPackage => ({ price: 1_000_000_000n + BigInt(i), depth: 140_000_000_000n, timestampMs: 1_800_000_000_000, signature: new Uint8Array(65).fill(i) });
// The golden pins (the same sample pins the postPoolPrice vector uses).
function pinsFromGolden(): [PoolPin, PoolPin] {
  const keys = cook.ix.postSignedCook.keys as [string, boolean, boolean][];
  const k = (i: number) => new PublicKey(keys[i]![0]);
  const pin = (kind: number, at: number): PoolPin => ({ kind, pool: k(at), tokenVault: k(at + 1), solVault: k(at + 2), ammProgram: PublicKey.default, ammProgramData: k(at + 3), deploySlot: 0n });
  return [pin(0, 6), pin(1, 10)];
}

test('the cook feed: discriminators, address, size and bounds match the program', () => {
  for (const [name, h] of Object.entries(cook.instructions as Record<string, string>)) {
    assert.equal(toHex(Uint8Array.from((COOK_DISC as Record<string, readonly number[]>)[name]!)), h, name);
  }
  assert.equal(toHex(Uint8Array.from(COOK_DISC.CookFeed)), cook.accountDiscriminator);
  assert.equal(cookFeedAccount().toBase58(), cook.address);
  assert.equal(COOK_FEED_SPACE, cook.space);
  assert.equal(toHex(Buffer.from(COOK_FEED_ID.padEnd(32, '\0'))), cook.feedId);
  const b = cook.bounds;
  assert.deepEqual([...COOK_BOUNDS.shareBps], b.shareBps);
  assert.deepEqual([...COOK_BOUNDS.fenceBps], b.fenceBps);
  assert.deepEqual([...COOK_BOUNDS.spreadBps], b.spreadBps);
  assert.deepEqual([...COOK_BOUNDS.leashBps], b.leashBps);
  assert.equal(COOK_BOUNDS.ceilingUsdMicrosMax.toString(), b.ceilingUsdMicrosMax);
  assert.deepEqual(COOK_BOUNDS.minDepth.map(String), b.minDepth);
});

test('settings and packages encode as the program serializes them; the account decodes', () => {
  assert.equal(toHex(encodeCookSettings(signed)), cook.settings);
  assert.equal(toHex(encodeCookPackage(pkg(1))), cook.package);
  for (const raw of [cook.account, cook.accountBare]) {
    const f = decodeCookFeed(Uint8Array.from(Buffer.from(raw, 'hex')));
    assert.equal(f.bump, raw === cook.account ? 254 : 254);
    if (raw === cook.account) {
      assert.deepEqual(f.active, signed);
      assert.deepEqual(f.pending, { settings: back, effectiveAt: 1_800_172_800 });
      assert.equal(f.lastTs, 1_800_000_000);
      assert.deepEqual([f.lastPrice, f.lastDepth, f.lastSigners], [1_000_000_000n, 140_000_000_000n, 4]);
      assert.deepEqual(effectiveCookSettings(f, 1_800_172_799), signed);
      assert.deepEqual(effectiveCookSettings(f, 1_800_172_800), back, 'a due proposal counts with no apply call');
    } else {
      assert.deepEqual(f.active, back);
      assert.equal(f.pending, null);
    }
  }
  assert.throws(() => decodeCookFeed(new Uint8Array(93)));
});

test('instructions: accounts, order and data are the golden ones', () => {
  same(postSignedCookIx(keeper, pinsFromGolden(), [1, 2, 3, 4].map(pkg)), cook.ix.postSignedCook, 'post_signed_cook');
  same(initCookFeedIx(ADMIN, back), cook.ix.initCookFeed, 'init_cook_feed');
  same(setCookFeedIx(ADMIN, signed), cook.ix.setCookFeed, 'set_cook_feed');
  same(applyCookFeedIx(), cook.ix.applyCookFeed, 'apply_cook_feed');
  same(cancelCookFeedIx(ADMIN), cook.ix.cancelCookFeed, 'cancel_cook_feed');
});

test('post_pool_price carries the cook feed last (a program that predates it ignores a trailing account)', () => {
  const ix = postPoolPriceIx('MCOOK', keeper, pinsFromGolden());
  const last = ix.keys[ix.keys.length - 1]!;
  assert.equal(last.pubkey.toBase58(), cook.address);
  assert.deepEqual([last.isSigner, last.isWritable], [false, false]);
  // The golden vector for the same instruction (written by the program test) agrees.
  const g = golden.ix.postPoolPriceMcook.keys as [string, boolean, boolean][];
  assert.deepEqual(g[g.length - 1], [cook.address, false, false]);
});

test('the signed value packs the price over the depth in one 128-bit word', () => {
  const v = cookValue(993_747_000n, 140_127_073_166n);
  assert.deepEqual(splitCookValue(v), { price: 993_747_000n, depth: 140_127_073_166n });
  // Bytes 48..56 of the 32-byte BE value are the price, 56..64 the depth (the program's message layout).
  const b = Buffer.alloc(32);
  b.writeBigUInt64BE(v >> 64n, 16);
  b.writeBigUInt64BE(v & ((1n << 64n) - 1n), 24);
  assert.equal(b.readBigUInt64BE(16), 993_747_000n);
  assert.equal(b.readBigUInt64BE(24), 140_127_073_166n);
  // The live Solana pool, 2026-10-27: 141,008.757837875 COOK and 140.127073166 SOL.
  assert.equal(lamportsPerMillionCook(141_008_757_837_875n, 140_127_073_166n), 993_747_305n);
});

test('settings problems, the apply-at-once rule and the capacity formula', () => {
  assert.deepEqual(cookSettingsProblems(signed), []);
  assert.deepEqual(cookSettingsProblems({ ...signed, ceilingUsdMicros: 0n }), []);
  for (const bad of [
    { ...signed, shareBps: 0 }, { ...signed, shareBps: 1_001 }, { ...signed, fenceBps: 499 }, { ...signed, fenceBps: 5_001 }, { ...signed, spreadBps: 19 },
    { ...signed, spreadBps: 501 }, { ...signed, leashBps: 49 }, { ...signed, leashBps: 1_001 }, { ...signed, ceilingUsdMicros: 50_000_000_001n },
    { ...signed, minDepth: 9_999_999_999n }, { ...signed, source: 2 as 0 },
  ]) assert.notDeepEqual(cookSettingsProblems(bad), [], JSON.stringify(bad, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  // Tightening applies at once; the signed source and every loosening wait.
  assert.equal(cookSettingsApplyAtOnce(back, signed), true);
  assert.equal(cookSettingsApplyAtOnce(signed, back), false);
  assert.equal(cookSettingsApplyAtOnce({ ...back, shareBps: 200, ceilingUsdMicros: 1n }, back), true);
  for (const loose of [{ shareBps: 301 }, { fenceBps: 2_501 }, { spreadBps: 151 }, { leashBps: 501 }, { ceilingUsdMicros: 1_500_000_001n }, { minDepth: 49_999_999_999n }]) {
    assert.equal(cookSettingsApplyAtOnce({ ...back, ...loose }, back), false, JSON.stringify(loose, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  }
  // 3% of 140 SOL at $100 = $420, under the $1,500 ceiling; a $300 ceiling wins.
  assert.equal(cookCapacity(signed, 140_000_000_000n, 100_000_000n), 420_000_000n);
  assert.equal(cookCapacity({ ...signed, ceilingUsdMicros: 300_000_000n }, 140_000_000_000n, 100_000_000n), 300_000_000n);
});
