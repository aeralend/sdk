/**
 * The app- and keeper-facing layer for creator markets (`src/isolatedClient.ts`).
 *
 * Account bytes are the program's own, from the fixture
 * `test_isolated_create.rs::sdk_00_fixture_for_the_sdk` writes; instruction
 * account lists are compared against the ones the program's test harness
 * built with Anchor's own `to_account_metas`.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { Keypair, PublicKey, type AccountInfo, type Connection, type TransactionInstruction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';

import { FIXED_POINT_SCALE } from '../src/constants.js';
import {
  ISOLATED_MARKET_ACCOUNT_SIZE,
  ISOLATED_MARKET_OFFSETS,
  OBLIGATION_DISCRIMINATOR,
  base58Encode,
  checkListingMint,
  classifyCover,
  isPlainPayoutAccount,
  isolatedMarketView,
  listIsolatedMarkets,
} from '../src/isolatedClient.js';
import {
  ISOLATED_DISCRIMINATOR,
  ISOLATED_ORACLE_DEAD_SECONDS,
  coverIsolatedDebtIx,
  decodeIsolatedMarket,
  decodeIsolatedOracle,
  freezeIsolatedMarketIx,
  harvestCreatorFeesIx,
  initIsolatedCollateralReserveIx,
  initIsolatedQuoteReserveIx,
  isolatedMarketAddresses,
  isolatedMarketPda,
  refreshIsolatedOracleFromAccount,
  retireIsolatedMarketIx,
  syncIsolatedAmmPinsIx,
  syncIsolatedCapsIx,
  withdrawBondIx,
  topUpBondIx,
} from '../src/isolatedMarkets.js';
import { globalPda } from '../src/pda.js';
import type { ObligationAccount, ReserveAccount } from '../src/types.js';

const f = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'isolated-markets.json'), 'utf8')) as Record<string, unknown>;
const hex = (name: string) => Uint8Array.from(Buffer.from(f[name] as string, 'hex'));
const key = (name: string) => new PublicKey(f[name] as string);
const program = key('program');
const SOL = 1_000_000_000n;
const market = decodeIsolatedMarket(hex('market'));
const oracle = decodeIsolatedOracle(hex('oracle'));

test('base58 matches PublicKey for 32 bytes, and keeps leading zeros', () => {
  for (let i = 0; i < 20; i += 1) {
    const k = Keypair.generate().publicKey;
    assert.equal(base58Encode(k.toBytes()), k.toBase58());
  }
  assert.equal(base58Encode(new Uint8Array(32)), PublicKey.default.toBase58());
  assert.equal(base58Encode([0, 0, 1]), '112');
});

test('the obligation filter uses Anchor’s discriminator', () => {
  const expected = [...createHash('sha256').update('account:Obligation').digest().subarray(0, 8)];
  assert.deepEqual([...OBLIGATION_DISCRIMINATOR], expected);
});

test('listing filters sit where the program writes the fields', () => {
  const bytes = hex('market');
  assert.equal(bytes.length, ISOLATED_MARKET_ACCOUNT_SIZE);
  assert.deepEqual([...bytes.subarray(0, 8)], [...ISOLATED_DISCRIMINATOR.IsolatedMarket]);
  assert.equal(new PublicKey(bytes.subarray(ISOLATED_MARKET_OFFSETS.creator, ISOLATED_MARKET_OFFSETS.creator + 32)).toBase58(), f.creator);
  assert.equal(new PublicKey(bytes.subarray(ISOLATED_MARKET_OFFSETS.tokenMint, ISOLATED_MARKET_OFFSETS.tokenMint + 32)).toBase58(), f.tokenMint);
});

test('listIsolatedMarkets keeps only canonical market PDAs, oldest first', async () => {
  const bytes = Buffer.from(hex('market'));
  const real = isolatedMarketPda(market.market, program);
  const seen: unknown[] = [];
  const connection = {
    getProgramAccounts: async (id: PublicKey, config: { filters: unknown[] }) => {
      assert.ok(id.equals(program));
      seen.push(...config.filters);
      const account = { data: bytes, owner: program, executable: false, lamports: 1 } as AccountInfo<Buffer>;
      // The real one, and the same bytes at an address that is not its PDA.
      return [
        { pubkey: Keypair.generate().publicKey, account },
        { pubkey: real, account },
      ];
    },
  } as unknown as Connection;
  const creator = key('creator');
  const found = await listIsolatedMarkets(connection, { programId: program, creator });
  assert.equal(found.length, 1);
  assert.ok(found[0]!.address.equals(real));
  assert.equal(found[0]!.marketId, market.marketId);
  assert.deepEqual(seen, [
    { dataSize: ISOLATED_MARKET_ACCOUNT_SIZE },
    { memcmp: { offset: 0, bytes: base58Encode(ISOLATED_DISCRIMINATOR.IsolatedMarket) } },
    { memcmp: { offset: ISOLATED_MARKET_OFFSETS.creator, bytes: creator.toBase58() } },
  ]);
});

test('the view says what the market can lend, from the program’s own accounts', () => {
  const view = isolatedMarketView(market, oracle);
  assert.equal(view.tier.name, 'Seed');
  assert.equal(view.borrowCap, SOL); // depth 10 SOL x 10%, under the bond's 1.6
  assert.equal(view.walletCap, SOL / 4n); // 2.5% of depth
  assert.equal(view.bondCap, 16n * SOL / 10n);
  assert.equal(view.borrowingOpen, true);
  assert.equal(view.oracleBootstrapped, true);
  assert.equal(view.oracleDeadAt, view.lastObservation!.unixTimestamp + ISOLATED_ORACLE_DEAD_SECONDS);
  assert.equal(isolatedMarketView({ ...market, frozen: true }, oracle).borrowingOpen, false);
  assert.equal(isolatedMarketView({ ...market, bondAmount: 0n }, oracle).borrowingOpen, false);
  assert.equal(isolatedMarketView(market, { ...oracle, observations: oracle.observations.slice(0, 2) }).oracleBootstrapped, false);
});

/** A mint's bytes, as the program's `validate_listing_mint` reads them. */
function mint(opts: { mintAuthority?: boolean; freezeAuthority?: boolean; decimals?: number; extensions?: Array<[number, number]> } = {}) {
  const d = new Uint8Array(82);
  if (opts.mintAuthority) d[0] = 1;
  d[44] = opts.decimals ?? 9;
  d[45] = 1;
  if (opts.freezeAuthority) d[46] = 1;
  if (!opts.extensions) return d;
  const tlv: number[] = [];
  for (const [kind, len] of opts.extensions) tlv.push(kind & 0xff, kind >> 8, len & 0xff, len >> 8, ...new Array(len).fill(7));
  const out = new Uint8Array(166 + tlv.length);
  out.set(d, 0);
  out[165] = 1;
  out.set(tlv, 166);
  return out;
}

test('checkListingMint refuses what the program refuses', () => {
  assert.deepEqual(checkListingMint(TOKEN_PROGRAM_ID, mint()), { ok: true, decimals: 9 });
  assert.deepEqual(checkListingMint(TOKEN_2022_PROGRAM_ID, mint({ extensions: [[18, 64], [19, 90]] })), { ok: true, decimals: 9 });
  const refused = (owner: PublicKey, data: Uint8Array) => !checkListingMint(owner, data).ok;
  assert.ok(refused(Keypair.generate().publicKey, mint()));
  assert.ok(refused(TOKEN_PROGRAM_ID, mint({ mintAuthority: true })));
  assert.ok(refused(TOKEN_PROGRAM_ID, mint({ freezeAuthority: true })));
  assert.ok(refused(TOKEN_PROGRAM_ID, mint({ decimals: 13 })));
  assert.ok(refused(TOKEN_PROGRAM_ID, mint({ extensions: [[18, 64]] })), 'legacy with extensions');
  for (const kind of [1, 3, 6, 9, 10, 12, 14, 25, 26]) {
    assert.ok(refused(TOKEN_2022_PROGRAM_ID, mint({ extensions: [[18, 64], [kind, 8]] })), `extension ${kind}`);
  }
  const overrun = mint({ extensions: [[19, 16]] });
  overrun[168] = 0xff;
  assert.ok(refused(TOKEN_2022_PROGRAM_ID, overrun), 'length past the end');
});

function reserve(address: PublicKey, over: Partial<ReserveAccount>): ReserveAccount {
  return {
    address,
    market: market.market,
    liquidityMint: PublicKey.default,
    liquidityVault: PublicKey.default,
    shareMint: PublicKey.default,
    oracle: PublicKey.default,
    liquidityDecimals: 9,
    availableLiquidity: 0n,
    shareMintSupply: 0n,
    borrowedPrincipal: 0n,
    borrowIndex: FIXED_POINT_SCALE,
    lastUpdateSlot: 0n,
    accruedFees: 0n,
    config: {} as ReserveAccount['config'],
    pending: {} as ReserveAccount['pending'],
    bump: 0,
    ...over,
  };
}

test('classifyCover follows the program’s three cases, in its order', () => {
  const a = isolatedMarketAddresses(market.marketId, market.tokenMint, market.quoteMint, program);
  const quoteReserve = reserve(a.quoteReserve, { borrowedPrincipal: SOL });
  const tokenReserve = reserve(a.tokenReserve, { availableLiquidity: 100_000n * SOL, shareMintSupply: 100_000n * SOL });
  const position = (shares: bigint, principal: bigint): ObligationAccount => ({
    address: Keypair.generate().publicKey,
    market: market.market,
    owner: Keypair.generate().publicKey,
    lastUpdateSlot: 0n,
    stale: false,
    pricesStressed: false,
    depositedValue: 0n,
    effectiveCollateralValue: 0n,
    borrowedValue: 0n,
    allowedBorrowValue: 0n,
    unhealthyBorrowValue: 0n,
    deposits: shares ? [{ reserve: a.tokenReserve, depositedShares: shares, marketValue: 0n }] : [],
    borrows: principal ? [{ reserve: a.quoteReserve, borrowedPrincipal: principal, marketValue: 0n }] : [],
    bump: 0,
  });
  const latest = oracle.observations.reduce((m, o) => (o.unixTimestamp > m ? o.unixTimestamp : m), 0n);
  const base = { quoteReserve, tokenReserve, oracle, tokenPrice: 10n ** 13n, nowUnix: latest + 60n };
  const tokens = 100_000n * SOL; // worth 1 SOL at 1e-5

  assert.equal(classifyCover({ ...base, obligation: position(tokens, 0n) }), null, 'nothing owed');
  assert.equal(classifyCover({ ...base, obligation: position(0n, SOL / 10n) }), 'noCollateral');
  assert.equal(classifyCover({ ...base, obligation: position(tokens, SOL / 5n) }), null, 'healthy');
  assert.equal(classifyCover({ ...base, obligation: position(tokens, SOL) }), 'underwater', 'debt equal to collateral');
  assert.equal(
    classifyCover({ ...base, obligation: position(tokens, SOL / 5n), nowUnix: latest + ISOLATED_ORACLE_DEAD_SECONDS }),
    'oracleDead',
  );
});

test('bond instructions carry Global first, so a pause can hold the bond', () => {
  const p = {
    programId: program,
    creator: key('creator'),
    market: key('marketAddress'),
    quoteMint: key('quoteMint'),
    creatorQuote: key('creatorQuote'),
    amount: 1n,
  };
  for (const ix of [withdrawBondIx(p), topUpBondIx(p)]) {
    assert.ok(ix.keys[0]!.pubkey.equals(globalPda(program)));
    assert.equal(ix.keys[0]!.isWritable, false);
    assert.ok(ix.keys[1]!.pubkey.equals(p.creator) && ix.keys[1]!.isSigner);
    assert.equal(ix.keys.length, 9);
  }
});

test('every instruction builder matches the program’s accounts, flags and data', () => {
  const ix = f.ix as Record<string, { keys: string[]; data: string }>;
  const marketAddress = key('marketAddress');
  const common = { programId: program, market: marketAddress };
  const built: Record<string, TransactionInstruction> = {
    initIsolatedCollateralReserve: initIsolatedCollateralReserveIx({ ...common, creator: key('creator'), tokenMint: key('tokenMint') }),
    initIsolatedQuoteReserve: initIsolatedQuoteReserveIx({ ...common, creator: key('creator'), quoteMint: key('quoteMint') }),
    refreshIsolatedOracle: refreshIsolatedOracleFromAccount(oracle, program),
    harvestCreatorFees: harvestCreatorFeesIx({ ...common, quoteMint: key('quoteMint'), creatorShareAccount: key('creatorShare') }),
    freezeIsolatedMarket: freezeIsolatedMarketIx({ ...common, global: key('global'), admin: key('admin'), quoteMint: key('quoteMint'), frozen: true }),
    retireIsolatedMarket: retireIsolatedMarketIx({ ...common, creator: key('creator'), quoteMint: key('quoteMint') }),
    topUpBond: topUpBondIx({ ...common, creator: key('creator'), quoteMint: key('quoteMint'), creatorQuote: key('creatorQuote'), amount: 12_345n }),
    withdrawBond: withdrawBondIx({ ...common, creator: key('creator'), quoteMint: key('quoteMint'), creatorQuote: key('creatorQuote'), amount: 12_345n }),
    syncIsolatedCaps: syncIsolatedCapsIx({ ...common, tokenMint: key('tokenMint'), quoteMint: key('quoteMint') }),
    syncIsolatedAmmPins: syncIsolatedAmmPinsIx({ ...common, tokenMint: key('tokenMint') }),
    coverIsolatedDebt: coverIsolatedDebtIx({
      ...common,
      obligation: key('obligation'),
      tokenMint: key('tokenMint'),
      quoteMint: key('quoteMint'),
      creatorCollateralAccount: key('creatorDest'),
    }),
  };
  assert.deepEqual(Object.keys(built).sort(), Object.keys(ix).sort(), 'every recorded instruction is checked');
  for (const [name, instruction] of Object.entries(built)) {
    const keys = instruction.keys.map((k) => `${k.pubkey.toBase58()}|${k.isWritable ? 'w' : '-'}|${k.isSigner ? 's' : '-'}`);
    assert.deepEqual(keys, ix[name]!.keys, `${name}: accounts`);
    assert.equal(Buffer.from(instruction.data).toString('hex'), ix[name]!.data, `${name}: data`);
    assert.ok(instruction.programId.equals(program));
  }
});

test('a payout account must be plain, the creator’s, and for the collateral share mint', () => {
  const creator = Keypair.generate().publicKey;
  const shareMint = Keypair.generate().publicKey;
  const data = new Uint8Array(165);
  data.set(shareMint.toBytes(), 0);
  data.set(creator.toBytes(), 32);
  data[108] = 1;
  assert.ok(isPlainPayoutAccount({ owner: TOKEN_2022_PROGRAM_ID, data }, creator, shareMint));
  assert.ok(!isPlainPayoutAccount({ owner: TOKEN_PROGRAM_ID, data }, creator, shareMint));
  assert.ok(!isPlainPayoutAccount({ owner: TOKEN_2022_PROGRAM_ID, data }, Keypair.generate().publicKey, shareMint));
  const withMemo = new Uint8Array(175);
  withMemo.set(data, 0);
  assert.ok(!isPlainPayoutAccount({ owner: TOKEN_2022_PROGRAM_ID, data: withMemo }, creator, shareMint), 'extensions');
  assert.ok(!isPlainPayoutAccount(null, creator, shareMint));
});
