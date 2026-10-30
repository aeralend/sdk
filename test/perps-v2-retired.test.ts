/**
 * The retired aSOL perps program (`GqvG8…`) through the SDK's `'asol-v2'`
 * option, against its own golden file (`fixtures/perps-v2-golden.json`,
 * untouched): what scripts/perps-bcook/retire-v2.mjs needs to pause it,
 * withdraw its LPs and collect its fees, and the legacy `AsolV2Quote`
 * arithmetic still used to read its history.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

import {
  MARKETS_ASOL_MINT,
  MARKETS_FEE_DESTINATION,
  MARKETS_SOL_RESERVE,
  POOL_MEMBER_FEEDS_ASOL_V2,
  RETIRED_ASOL_PERPS_PROGRAM_ID,
  decodeLinearMarket,
  decodePoolOracle,
  feeDestinationAccount,
  linearCollectIx,
  linearExecuteIx,
  linearFee,
  linearMark,
  linearMarket,
  linearOrder,
  linearPriceAccount,
  linearSubmitIx,
  linearVault,
  lpPoolAccount,
  lpPoolVault,
  marketsAsolAccount,
  perpsDeployment,
  poolExecuteIx,
  poolMemberAccounts,
  poolOrder,
  poolSubmitIx,
  setLpPoolPausedIx,
  setMarketPausedIx,
  settleOracleAccount,
  solPriceAccount,
  submitOrderData,
} from '../src/index.js';

const golden = JSON.parse(readFileSync(new URL('./fixtures/protocol/perps-v2-golden.json', import.meta.url), 'utf8'));
const ix = golden.pool.ix;
const bytes = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));
const ADMIN = new PublicKey('GqdCnvFd8ErGTSdz7VdYmMNNh4nvMMmuw7GAA5SQ6gRG');
const owner = new PublicKey(ix.owner);
const V2 = 'asol-v2' as const;
function same(actual: TransactionInstruction, expected: { keys: [string, boolean, boolean][]; data: string }, name: string) {
  assert.ok(actual.programId.equals(RETIRED_ASOL_PERPS_PROGRAM_ID), `${name}: program`);
  assert.deepEqual(actual.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), expected.keys, `${name}: accounts`);
  assert.equal(Buffer.from(actual.data).toString('hex'), expected.data, `${name}: data`);
}

test('the retired program’s deployment and addresses', () => {
  const d = perpsDeployment(V2);
  assert.equal(d.programId.toBase58(), golden.program);
  assert.ok(d.mint.equals(MARKETS_ASOL_MINT) && d.tokenProgram.equals(TOKEN_2022_PROGRAM_ID) && d.rateAccount.equals(MARKETS_SOL_RESERVE));
  for (const feed of ['BTC', 'ETH', 'HYPE']) {
    assert.equal(linearMarket(feed, V2).toBase58(), golden.pdas[feed].market);
    assert.equal(linearVault(feed, V2).toBase58(), golden.pdas[feed].vault);
    assert.equal(linearPriceAccount(feed, V2).toBase58(), golden.pdas[feed].price);
  }
  assert.equal(solPriceAccount(V2).toBase58(), golden.solPrice);
  assert.equal(settleOracleAccount(V2).toBase58(), golden.solPrice, 'the slot the bCOOK program calls `settle` held ["price"]');
  assert.equal(lpPoolAccount(0, V2).toBase58(), 'H2D1fqwQch4eWGA2XDvjYjUdFbdWx2zMxi23vqCMmu37');
  assert.equal(lpPoolVault(lpPoolAccount(0, V2), V2).toBase58(), golden.pool.vault);
  assert.equal(poolOrder(owner, 42n, 0, V2).toBase58(), golden.pool.order.address);
  const o = golden.order;
  assert.equal(linearOrder(new PublicKey(o.market), new PublicKey(o.owner), BigInt(o.nonce), V2).toBase58(), o.address);
  assert.equal(feeDestinationAccount(V2).toBase58(), marketsAsolAccount(MARKETS_FEE_DESTINATION).toBase58());
});

test('the retire instructions are byte-identical to the retired program’s', () => {
  same(setMarketPausedIx(ADMIN, 'HYPE', true, V2), ix.pauseMarketHype, 'set_market_paused');
  same(setLpPoolPausedIx(ADMIN, false, 0, V2), ix.setLpPoolPaused, 'set_lp_pool_paused');
  same(poolSubmitIx(owner, 42n, { kind: 'withdraw', shares: 250_000_000n, minimum: 240_000_000n }, 1_800_000_000, 0, V2), ix.submitPoolWithdraw, 'pool Withdraw order');
  const members = poolMemberAccounts({ members: ix.members.map((f: string) => ({ market: linearMarket(f, V2), reserved: 0n, maxReserveBps: 5_000 })) }, POOL_MEMBER_FEEDS_ASOL_V2, V2);
  same(poolExecuteIx(poolOrder(owner, 42n, 0, V2), owner, members, 0, V2), ix.executePoolOrder, 'execute_pool_order');
  same(linearExecuteIx('BTC', linearOrder(linearMarket('BTC', V2), owner, 42n, V2), owner, lpPoolAccount(0, V2), null, V2), ix.memberExecuteOrderBtc, 'member execute_order');
  // A market Withdraw order (COOK-PERP's own LP): aSOL on Token-2022, data as before.
  const w = linearSubmitIx('MCOOK', ADMIN, 9n, { kind: 'withdraw', shares: 100_000_000n, minimum: 99_000_000n }, 1_800_000_000, 1n, 18_446_744_073_709_551_615n, null, V2);
  assert.ok(w.programId.equals(RETIRED_ASOL_PERPS_PROGRAM_ID));
  assert.deepEqual(w.keys.map((k) => k.pubkey.toBase58()), [ADMIN, linearOrder(linearMarket('MCOOK', V2), ADMIN, 9n, V2), marketsAsolAccount(ADMIN), linearMarket('MCOOK', V2), linearVault('MCOOK', V2), MARKETS_ASOL_MINT, TOKEN_2022_PROGRAM_ID, PublicKey.default].map((k) => k.toBase58()));
  assert.equal(w.data.toString('hex'), Buffer.from(submitOrderData(9n, { kind: 'withdraw', shares: 100_000_000n, minimum: 99_000_000n }, 1_800_000_055, 1n, 18_446_744_073_709_551_615n)).toString('hex'));
  // Fees to the fee destination's aSOL account.
  for (const buckets of [false, true]) {
    const c = linearCollectIx('BTC', buckets, V2);
    assert.deepEqual(c.keys.map((k) => [k.pubkey.toBase58(), k.isWritable]), [
      [marketsAsolAccount(MARKETS_FEE_DESTINATION).toBase58(), true], [linearMarket('BTC', V2).toBase58(), true], [linearVault('BTC', V2).toBase58(), true],
      [MARKETS_ASOL_MINT.toBase58(), false], [TOKEN_2022_PROGRAM_ID.toBase58(), false],
    ]);
  }
});

test('the legacy quote still runs the retired arithmetic', () => {
  const s = golden.samples;
  const m = decodeLinearMarket(bytes(s.market));
  const q = { assetMicros: 90_200_000_000n, solMicros: 108_000_000n, rateE9: 1_050_000_000n };
  const mark = linearMark(m.ledger.positions[0]!, q, 0n);
  assert.deepEqual([mark.pnl, mark.payable, mark.closingFee, mark.maintenance].map(String), [s.markAt90200.pnl, s.markAt90200.payable, s.markAt90200.closingFee, s.markAt90200.maintenance]);
  assert.equal(linearFee(300_000_000n, { ...q, assetMicros: 82_000_000_000n }), 1_000_000_000n - BigInt(s.position.margin));
});

test('the retired oracle layout (1,508 bytes, no previous_published_at) still decodes', () => {
  const quote = new Uint8Array(72);
  quote.set(new TextEncoder().encode('MCOOK'));
  const v = new DataView(quote.buffer);
  v.setBigInt64(32, 1_800_000_000n, true);
  v.setBigUint64(40, 52_665_978n, true);
  v.setBigUint64(48, 52_467_061n, true);
  v.setBigUint64(56, 52_864_896n, true);
  v.setBigUint64(64, 13_579_711n, true);
  const d = new Uint8Array(1_508);
  d.set([0x59, 0xe0, 0xdc, 0x06, 0x8a, 0xb4, 0x2c, 0x6a]);
  d.set(quote, 8);
  const ring = 8 + 72 + 32 + 2 * 169 + 27;
  new DataView(d.buffer).setUint32(ring, 32, true);
  const o = decodePoolOracle(d);
  assert.deepEqual(o.quote, { feed: 'MCOOK', publishedAt: 1_800_000_000, twapUsdMicros: 52_665_978n, spotLoUsdMicros: 52_467_061n, spotHiUsdMicros: 52_864_896n, oiCapUsdMicros: 13_579_711n });
  assert.equal(o.samples.length, 0);
});
