import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import {
  COOK_MINT,
  COOK_POOL_PARAMS,
  COOK_POOL_PINS,
  MARKETS_DISC,
  PERPS_PROGRAM_ID,
  POOL_ORACLE_SPACE_V3,
  configAccount,
  cookFeedAccount,
  createPoolOracleIx,
  decodePoolOracle,
  encodePoolParams,
  encodePoolPin,
  isPoolFeed,
  linearExecuteIx,
  linearLiquidateIx,
  poolBand,
  poolFillPrice,
  poolOracleAccount,
  postPoolPriceIx,
  usdPerToken,
  type PoolQuote,
} from '../src/index.js';

const disc = (s: string) => [...createHash('sha256').update(s).digest().subarray(0, 8)];
const someone = new PublicKey('GqdCnvFd8ErGTSdz7VdYmMNNh4nvMMmuw7GAA5SQ6gRG');

test('pool discriminators are the program’s', () => {
  assert.deepEqual(MARKETS_DISC.post_pool_price, disc('global:post_pool_price'));
  assert.deepEqual(MARKETS_DISC.create_pool_oracle, disc('global:create_pool_oracle'));
  assert.deepEqual(MARKETS_DISC.set_pool_params, disc('global:set_pool_params'));
  assert.deepEqual(MARKETS_DISC.set_pool_pins, disc('global:set_pool_pins'));
  assert.deepEqual(MARKETS_DISC.PoolOracle, disc('account:PoolOracle'));
});

test('only MCOOK is a pool feed, and only its fills carry the oracle', () => {
  assert.ok(isPoolFeed('MCOOK'));
  assert.ok(!isPoolFeed('BTC') && !isPoolFeed('SOL'));
  const order = PublicKey.unique();
  const cook = linearExecuteIx('MCOOK', order, someone);
  const btc = linearExecuteIx('BTC', order, someone);
  assert.equal(cook.keys.length, btc.keys.length + 1);
  assert.ok(cook.keys.at(-1)!.pubkey.equals(poolOracleAccount('MCOOK')));
  assert.equal(cook.keys.at(-1)!.isWritable, false);
  const liq = linearLiquidateIx('MCOOK', someone, 3n, someone);
  assert.ok(liq.keys.at(-1)!.pubkey.equals(poolOracleAccount('MCOOK')));
  assert.equal(linearLiquidateIx('ETH', someone, 3n, someone).keys.length, liq.keys.length - 1);
});

test('the post names the pinned pools in the program’s account order', () => {
  const ix = postPoolPriceIx('MCOOK', someone, COOK_POOL_PINS);
  assert.equal(ix.keys.length, 16); // + the config account after SOL/USD (v4), + the cook feed last (0.5.0)
  assert.ok(ix.keys[15]!.pubkey.equals(cookFeedAccount()));
  assert.ok(ix.keys[0]!.isSigner && ix.keys[0]!.isWritable);
  assert.ok(ix.keys[1]!.pubkey.equals(poolOracleAccount('MCOOK')));
  assert.ok(ix.keys[4]!.pubkey.equals(configAccount()));
  assert.ok(ix.keys[5]!.pubkey.equals(COOK_POOL_PINS[0].pool));
  assert.ok(ix.keys[8]!.pubkey.equals(COOK_POOL_PINS[0].ammProgramData));
  assert.ok(ix.keys[9]!.pubkey.equals(COOK_POOL_PINS[1].pool));
  assert.equal(ix.keys[13]!.pubkey.toBase58(), 'Sysvar1nstructions1111111111111111111111111');
  assert.deepEqual([...ix.data], MARKETS_DISC.post_pool_price);
  assert.ok(ix.programId.equals(PERPS_PROGRAM_ID));
});

test('a PoolOracle decodes field by field, samples oldest first', () => {
  const ix = createPoolOracleIx(someone, 'MCOOK', COOK_MINT, COOK_POOL_PINS, COOK_POOL_PARAMS);
  // The create instruction carries the same pins and params the account will hold.
  const pins = new Uint8Array([...encodePoolPin(COOK_POOL_PINS[0]), ...encodePoolPin(COOK_POOL_PINS[1])]);
  const params = encodePoolParams(COOK_POOL_PARAMS);
  assert.equal(ix.data.length, 8 + 4 + 5 + 32 + pins.length + params.length);
  // An account as the program writes it: quote, mint, pins, params, a 32-slot
  // ring with two samples written (head 2), head, count, bump.
  // The bCOOK program's quote ends in previous_published_at (+8 bytes).
  const quote = new Uint8Array(32 + 8 + 32 + 8);
  quote.set(new TextEncoder().encode('MCOOK'));
  const dv = new DataView(quote.buffer);
  dv.setBigInt64(32, 1_800_000_000n, true);
  dv.setBigUint64(40, 50_000_000n, true);
  dv.setBigUint64(48, 49_000_000n, true);
  dv.setBigUint64(56, 75_000_000n, true);
  dv.setBigUint64(64, 13_000_000n, true);
  dv.setBigInt64(72, 1_799_999_990n, true);
  const ring = new Uint8Array(4 + 32 * 32);
  new DataView(ring.buffer).setUint32(0, 32, true);
  const sample = (i: number, price: bigint, at: bigint) => {
    const v = new DataView(ring.buffer, 4 + i * 32, 32);
    v.setBigUint64(0, price, true);
    v.setBigInt64(16, at, true);
    v.setBigUint64(24, 500_000_000n, true);
  };
  sample(0, 500_000_000_000n, 100n);
  sample(1, 505_000_000_000n, 220n);
  const data = new Uint8Array([...MARKETS_DISC.PoolOracle, ...quote, ...COOK_MINT.toBytes(), ...pins, ...params, ...ring, 2, 2, 254]);
  const o = decodePoolOracle(data);
  assert.equal(o.quote.feed, 'MCOOK');
  assert.equal(o.quote.publishedAt, 1_800_000_000);
  assert.equal(o.quote.spotHiUsdMicros, 75_000_000n);
  assert.equal(o.quote.previousPublishedAt, 1_799_999_990);
  assert.equal(data.length, POOL_ORACLE_SPACE_V3); // a deployed (v3) account: no cumulative yet
  assert.equal(o.cum, null);
  assert.ok(o.tokenMint.equals(COOK_MINT));
  assert.ok(o.pins[1].pool.equals(COOK_POOL_PINS[1].pool));
  assert.equal(o.pins[0].deploySlot, COOK_POOL_PINS[0].deploySlot);
  assert.deepEqual(o.params, COOK_POOL_PARAMS);
  assert.deepEqual(o.samples.map((s) => s.at), [100, 220]);
  assert.throws(() => decodePoolOracle(data.subarray(1)), /PoolOracle/);
});

test('fills take the worse end of the band for whoever acts', () => {
  const q: PoolQuote = { feed: 'MCOOK', publishedAt: 1, twapUsdMicros: 50_000_000n, spotLoUsdMicros: 49_500_000n, spotHiUsdMicros: 75_000_000n, oiCapUsdMicros: 0n };
  assert.deepEqual(poolBand(q), [49_500_000n, 75_000_000n]);
  assert.equal(poolFillPrice(q, true), 75_000_000n, 'buying pays the pushed pool');
  assert.equal(poolFillPrice(q, false), 49_500_000n, 'selling gets the lower of average and pools');
  // An average above both pools is the top of the band itself.
  assert.deepEqual(poolBand({ ...q, spotLoUsdMicros: 40_000_000n, spotHiUsdMicros: 45_000_000n }), [40_000_000n, 50_000_000n]);
  assert.ok(Math.abs(usdPerToken(50_000_000n) - 0.00005) < 1e-12);
});
