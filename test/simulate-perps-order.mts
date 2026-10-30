// Simulate (never send) a perps Open intent on mainnet from a real aSOL holder,
// sized by the SDK on the live market: proves the instruction, its accounts and
// the quote are accepted by the deployed program. No signature is involved.
//
//   npx tsx test/simulate-perps-order.mts [usd=1] [long|short] [leverage=2]
import { Connection, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { PERPS_ASOL_MINT, fetchPerpsLive, perpsNonce, perpsOpenQuote, perpsPriceBounds, perpsSubmitIx } from '../src/perpsLive.ts';

const [usdText = '1', sideText = 'long', levText = '2'] = process.argv.slice(2);
const c = new Connection('https://rpc.cookiescan.io', 'confirmed');
const holders = await c.getTokenLargestAccounts(PERPS_ASOL_MINT);
let owner: PublicKey | null = null;
for (const h of holders.value) {
  const info = await c.getParsedAccountInfo(h.address);
  const parsed = (info.value?.data as { parsed?: { info?: { owner?: string } } })?.parsed?.info?.owner;
  if (parsed && BigInt(h.amount) > 0n) { owner = new PublicKey(parsed); break; }
}
if (!owner) throw new Error('no aSOL holder found');
const live = await fetchPerpsLive(c, owner);
if (!live.price) throw new Error('no price');
const notional = BigInt(Math.round(Number(usdText) * 1e6));
const quote = perpsOpenQuote(live.market, sideText === 'short' ? 'short' : 'long', notional, Number(levText), live.price.priceUsdMicros, live.rateE9);
console.log(`holder ${owner.toBase58()} with ${live.mine!.asol} aSOL units; price ${live.price.priceUsdMicros}, rate ${live.rateE9}`);
console.log(`quote: collateral ${quote.collateral}, margin ${quote.margin}, fee ${quote.openingFee}, cap ${quote.profitCap}, liq ${quote.liquidationPrice?.toFixed(2)}, problem ${quote.problem}`);
const [min, max] = perpsPriceBounds(live.price.priceUsdMicros);
const ix = perpsSubmitIx(owner, perpsNonce(), { kind: 'open', long: sideText !== 'short', collateral: quote.collateral, notional, profitCap: quote.profitCap }, Math.floor(Date.now() / 1000) - 2, min, max);
const tx = new Transaction().add(ix);
tx.feePayer = owner;
tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
const sim = await c.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, commitment: 'confirmed' });
console.log(sim.value.err ? `REFUSED ${JSON.stringify(sim.value.err)}\n${sim.value.logs?.slice(-6).join('\n')}` : `accepted on chain (${sim.value.unitsConsumed} CU): the aSOL would be escrowed for the keeper to fill`);
