// Run a REAL route from the production swap API through the SDK's checks,
// up to and including simulation. Nothing is signed or sent. Use it after
// changing the swap guards, to prove real Cookiebox/CookieSwap routes still pass.
//
//   npx tsx test/live-swap-check.mts <owner> [amount base units] [from symbol] [to symbol]
import { Connection, PublicKey } from '@solana/web3.js';
import { EXCHANGE_ASSETS, prepareExchangeTransaction, type SwapQuote } from '../src/index.ts';

const [owner, amount = '1000000000', from = 'COOK', to = 'bCOOK'] = process.argv.slice(2);
if (!owner) throw new Error('usage: live-swap-check.mts <owner> [amount] [from] [to]');
const API = 'https://api.aeralend.app';
const mint = (symbol: string) => {
  const a = EXCHANGE_ASSETS.find((x) => x.symbol === symbol);
  if (!a) throw new Error(`unknown asset ${symbol}: ${EXCHANGE_ASSETS.map((x) => x.symbol).join(', ')}`);
  return a.mint;
};
const post = async (path: string, body: unknown) => {
  const r = await fetch(`${API}/v1/exchange/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${JSON.stringify(data)}`);
  return data;
};

const request = { inputMint: mint(from), outputMint: mint(to), amount, slippageBps: 50 };
const { quotes } = (await post('quote', { ...request, venue: 'best' })) as { quotes: SwapQuote[] };
for (const quote of quotes) {
  const built = (await post('build', { quoteId: quote.id, owner })) as { quote: SwapQuote; transactionBase64: string };
  const c = new Connection('https://rpc.cookiescan.io', 'confirmed');
  try {
    await prepareExchangeTransaction(c, new PublicKey(owner), built.transactionBase64, built.quote, {
      inputMint: request.inputMint, outputMint: request.outputMint, amount, slippageBps: request.slippageBps,
    });
    console.log(`${quote.venue}: ${from} -> ${to} out ${quote.outputAmount}, min ${quote.minimumOutput}: PASSES every check and simulates`);
  } catch (cause) {
    console.log(`${quote.venue}: REFUSED: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}
