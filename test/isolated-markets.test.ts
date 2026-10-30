import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import {
  ISOLATED_DISCRIMINATOR,
  ISOLATED_MARKET_ID_BASE,
  ISOLATED_TIERS,
  bondCap,
  bondForFullDepth,
  createIsolatedMarketIx,
  decodeIsolatedConfig,
  decodeIsolatedMarket,
  decodeIsolatedOracle,
  isolatedBorrowCap,
  isolatedInterestSplit,
  isolatedMarketAddresses,
  refreshIsolatedOracleFromAccount,
  withdrawableBond,
} from '../src/isolatedMarkets.js';

/** Written by `protocol/programs/aera/tests/test_isolated_create.rs::sdk_00_fixture_for_the_sdk`. */
const f = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'isolated-markets.json'), 'utf8')) as Record<
  string,
  string | string[] | number
>;
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));
const key = (name: string) => new PublicKey(f[name] as string);
const SOL = 1_000_000_000n;
const program = key('program');

test('discriminators are Anchor’s', () => {
  const disc = (s: string) => [...createHash('sha256').update(s).digest().subarray(0, 8)];
  const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  for (const [name, value] of Object.entries(ISOLATED_DISCRIMINATOR)) {
    const expected = /^[A-Z]/.test(name) ? disc(`account:${name}`) : disc(`global:${snake(name)}`);
    assert.deepEqual([...value], expected, name);
  }
});

test('the create instruction matches the program’s, byte for byte and key for key', () => {
  const pool = {
    pool: key('pool'),
    collateralVault: key('poolCollateralVault'),
    quoteVault: key('poolQuoteVault'),
    ammProgramData: key('poolProgramData'),
    ammIndex: 0,
  };
  const ix = createIsolatedMarketIx({
    programId: program,
    global: key('global'),
    creator: key('creator'),
    nextMarketId: BigInt(f.nextMarketId as string),
    tokenMint: key('tokenMint'),
    quoteMint: key('quoteMint'),
    creatorQuote: key('creatorQuote'),
    feeDestinationQuote: key('feeDestinationQuote'),
    tier: 0,
    bond: 2n * SOL,
    pools: [pool, pool],
  });
  assert.deepEqual(
    ix.keys.map((k) => k.pubkey.toBase58()),
    f.createKeys as string[],
  );
  assert.equal(Buffer.from(ix.data).toString('hex'), f.createData);
});

test('decodes the program’s own accounts', () => {
  const config = decodeIsolatedConfig(bytes(f.config as string));
  assert.equal(config.quoteMint.toBase58(), f.quoteMint);
  assert.equal(config.nextMarketId, ISOLATED_MARKET_ID_BASE + 1n);
  assert.equal(config.marketsCreated, 1n);
  assert.equal(config.amms[0].enabled, true);
  assert.equal(config.pendingAmmsEta, 0n);

  const market = decodeIsolatedMarket(bytes(f.market as string));
  assert.equal(market.marketId, ISOLATED_MARKET_ID_BASE);
  assert.equal(market.market.toBase58(), f.marketAddress);
  assert.equal(market.creator.toBase58(), f.creator);
  assert.equal(market.tokenMint.toBase58(), f.tokenMint);
  assert.equal(market.bondVault.toBase58(), f.bondVault);
  assert.equal(market.isolatedOracle.toBase58(), f.isolatedOracle);
  assert.equal(market.bondAmount, BigInt(f.bond as string));
  assert.equal(market.depthBorrowCap, BigInt(f.depthBorrowCap as string));
  assert.equal(market.stage, 1);
  assert.equal(market.singlePool, true);
  assert.equal(market.frozen, false);
  assert.equal(isolatedBorrowCap(market), SOL);

  const oracle = decodeIsolatedOracle(bytes(f.oracle as string));
  assert.equal(oracle.observations.length, f.observations);
  assert.equal(oracle.collateralMint.toBase58(), f.tokenMint);
  assert.equal(oracle.config.minPoolQuoteDepth, ISOLATED_TIERS[0]!.minPoolQuoteDepth);
  assert.equal(oracle.maxStepBps, ISOLATED_TIERS[0]!.maxStepBps);
  assert.ok(oracle.observations.every((o) => o.quoteDepth === 10n * SOL));

  assert.throws(() => decodeIsolatedMarket(bytes(f.config as string)), /not an Aera IsolatedMarket/);
});

test('addresses derive as the program derives them', () => {
  const a = isolatedMarketAddresses(ISOLATED_MARKET_ID_BASE, key('tokenMint'), key('quoteMint'), program);
  assert.equal(a.market.toBase58(), f.marketAddress);
  assert.equal(a.isolatedMarket.toBase58(), f.isolatedMarket);
  assert.equal(a.bondVault.toBase58(), f.bondVault);
  assert.equal(a.isolatedOracle.toBase58(), f.isolatedOracle);
  const oracle = decodeIsolatedOracle(bytes(f.oracle as string));
  const refresh = refreshIsolatedOracleFromAccount(oracle, program);
  assert.equal(refresh.keys[1]!.pubkey.toBase58(), f.isolatedOracle);
  assert.equal(refresh.keys.length, 11);
});

test('bond arithmetic', () => {
  assert.equal(bondCap(2n * SOL), 16n * SOL / 10n);
  assert.equal(bondForFullDepth(SOL), 1_250_000_000n);
  assert.equal(isolatedBorrowCap({ depthBorrowCap: SOL, bondAmount: SOL }), 8n * SOL / 10n);
  // 0.18 SOL owed needs 0.225 SOL of bond.
  assert.equal(withdrawableBond(2n * SOL, 180_000_000n), 2n * SOL - 225_000_000n);
  assert.equal(withdrawableBond(SOL / 10n, SOL), 0n);
});

test('interest splits 20 / 10 / 70', () => {
  const split = isolatedInterestSplit(1_000_000n);
  assert.equal(split.aera, 200_000n);
  assert.equal(split.creator, 100_000n);
  assert.equal(split.lenders, 700_000n);
});
