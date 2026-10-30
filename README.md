# @aera/sdk

TypeScript SDK for [Aera](https://aeralend.app) on Cookie Chain: lending, perps (SOL, BTC, ETH, HYPE, COOK) margined and settled in bCOOK, the shared Pool vault, swaps and Yield Tokens. It builds instructions and reads accounts; your wallet signs.

Docs: https://docs.aeralend.app. The programs are not audited (internal review only).

**0.5.0 adds the signed COOK price (same program id; [Migrating from 0.4.0](#migrating-from-040)).** **0.4.0 was the final perps upgrade of the bCOOK program.** If you integrated 0.3.0, read [Migrating from 0.3.0](#migrating-from-030): builders from 0.3.0 no longer work against the upgraded program (price-reading instructions gained a config account, ledgers are v4). **0.3.0 moves perps to a new program.** If you integrated 0.2.0, read [Migrating from 0.2.0](#migrating-from-020) first: the program id, the margin token and two accounts of every perps instruction changed. An order built with 0.2.0 now fails instead of sending aSOL.

## Install

Not on npm yet. Install from this repository (it builds on install) or from a release tarball:

```sh
npm install github:aeralend/sdk#v0.5.0
# or, from the tarball attached to the release:
npm install ./aera-sdk-0.5.0.tgz
```

It brings its own `@solana/web3.js`, `@solana/spl-token` and Anchor; import `PublicKey`, `Connection` and the like from `@solana/web3.js` as usual. ESM only, Node 18+ or any modern bundler. Use Cookie Chain's RPC: `https://rpc.cookiescan.io` (genesis `9wDaBRDgArEUpvhHxGguNkwozsZh4UpGZB9o2EoEcBB2`).

## Perps on bCOOK

| | |
| --- | --- |
| Program | `AE5G6RFSxbyJ5HLCSAiXTb96WUkj9tr9zLxjWwZkp4m2` (`PERPS_PROGRAM_ID`) |
| Margin, payouts, LP and referrals | bCOOK `EkPafx58mgwkEnGwo62jXhXDAdJ37Z8G8MFBRPsr9uhz` (`PERPS_BCOOK_MINT`), 9 decimals |
| Token program | **classic SPL Token** (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`) for every account: users, vaults, referrers, the fee destination. Not Token-2022. |
| Markets | `BTC`, `ETH`, `HYPE`, `SOL` (the shared Pool vault) and `MCOOK` (COOK-PERP, its own vault; paused at launch) |
| Settlement price | the program's pool oracle `["pool-oracle", "MCOOK"]` (`settleOracleAccount()`), COOK/USD from two pinned COOK/SOL pools times RedStone's SOL/USD |
| bCOOK's rate | BakeYourStake's stake pool `GxbNKNYdtNXQkhDkpHdLDAMX64GxaECgANqdfp6cUGH4` (`PERPS_STAKE_POOL`) |

PnL is in USD (linear in the asset) and paid in bCOOK. Every USD amount becomes bCOOK through COOK/USD at the fill, read as a **band**: `settleLo = min(TWAP, lower pool) × (1 − the stake pool's withdrawal fee)`, `settleHi = max(TWAP, higher pool)`. Each conversion takes the end worse for the trader:

* a USD gain converts at `settleHi` (fewer bCOOK), a loss, the fees, maintenance and the margin's buying power at `settleLo` (more bCOOK);
* a position is liquidated only if it is liquidatable at **both** ends, so a pushed pool alone never liquidates anyone;
* the reserved profit cap is bounded by twice the notional's value at `settleHi`;
* LP deposits are priced at the higher NAV, withdrawals at the lower one; funding runs at the TWAP.

Units: amounts are raw bCOOK (1e9 = 1 bCOOK), USD amounts are micros (1e6 = $1), settlement prices are USD micros per **million** COOK (~53,000,000 in October 2026).

### Capacity and floors

* **Settlement capacity.** Each book (the shared pool, and COOK-PERP's own vault) may have reserved at most the oracle's open-interest ceiling in profit caps, converted at `settleHi`. An open over it is refused (`Market`). At launch (`oi_share_bps` 2,500 of ~0.5 SOL of depth) that is about $14 of caps for the whole pool, barely more than one $20 position's $10 margin, so **offer the cap that fits, never assume the margin**: `linearOpenQuote` does it (`quote.capacity`, `quote.profitCap`), or call `maxCapThatFits(market, quote, pool)`.
* **Launch limits:** BTC, ETH, HYPE and SOL take at most $20 per position, 8 positions, 2x. The smallest position is $10.
* **LP floor:** 10,000 bCOOK per deposit and per remaining balance (`LINEAR_TERMS.minLpDeposit`, refused with `Accounting`; `lpFloorProblem` says why before you send).

### What the depth means, honestly

The whole COOK/SOL market behind the settlement price is about 0.5 SOL deep (roughly $55 a side, October 2026). Everything above follows from it: the capacity is about $14 of caps for the whole pool, and turning a bCOOK payout into SOL or dollars means selling COOK into those same pools (about 20% slippage on $14). bCOOK redeems for COOK at the stake pool's rate less its 2% withdrawal fee, while its reserve holds liquidity; its rate grows only while a sponsor keeps funding it. Anyone can halt fills cheaply by moving the two pools more than 3% apart; nothing fills until they are back. Treat it as a small product and describe it to your users as one.

### Getting bCOOK

Stake native COOK with BakeYourStake's stake pool directly (no website in the path):

```ts
import { Connection, Transaction } from '@solana/web3.js';
import { BCOOK_STAKE_POOL, cookForBcook, decodeStakePool, stakeForBcookIxs } from '@aera/sdk';

const connection = new Connection('https://rpc.cookiescan.io', 'confirmed');
const info = await connection.getAccountInfo(BCOOK_STAKE_POOL);
const pool = decodeStakePool(BCOOK_STAKE_POOL, info!.data);
const lamports = cookForBcook(20_000n * 1_000_000_000n, pool); // the COOK whose stake mints 20,000 bCOOK (fee included)
const tx = new Transaction().add(...stakeForBcookIxs(pool, trader, lamports)); // creates the classic bCOOK ATA, then DepositSol
// poolTokensForDeposit(lamports, pool) is the bCOOK it mints.
```

## Referrals for wallets and frontends

Name your wallet as `referrer` and you earn **20% of Aera's fee** on what your users trade. Your users pay exactly the same; the 20% comes out of Aera's own share.

| Product | Fee | Your share | Paid |
| --- | --- | --- | --- |
| Perps | 0.08% of size, on open and on close (partial closes too) | 20% of it: 0.016% of size per fill | in **bCOOK**, on chain, at each fill |
| Swap | Aera's 0.10% of the input | 20% of it: 0.02% of the input | in the input token, inside the swap |

A $10,000 perps position opened and closed pays $16 in fees: $3.20 is yours (at today's limits positions are far smaller). A $10,000 swap pays you $2.

**Set up once:** create your receiving accounts.

* Perps: your **classic SPL Token** bCOOK account (the associated token account of mint `EkPafx58mgwkEnGwo62jXhXDAdJ37Z8G8MFBRPsr9uhz` under `TokenkegQ…`), `marketsBcookAccount(REFERRER)`.
* Swap: a COOK (native) balance, plus token accounts for SOL (`6tL24Fn75uCMrBSZAvohAq57LSv6KrY6ceEq1wonvucb`, Token-2022) and bCOOK.

Keep them plain: not frozen, no required memos, no transfer hooks. If an account is missing, that trade pays Aera as usual. A trade never fails because of a referral. Self-referral (referrer = trader) pays nothing.

```ts
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import { PERPS_BCOOK_MINT, marketsBcookAccount } from '@aera/sdk';

const REFERRER = new PublicKey('YOUR_WALLET');
const setup = new Transaction().add(
  createAssociatedTokenAccountIdempotentInstruction(REFERRER, marketsBcookAccount(REFERRER), REFERRER, PERPS_BCOOK_MINT, TOKEN_PROGRAM_ID),
);
// sign with REFERRER and send once
```

### The simplest integration: a link

Open Aera with `?ref=YOUR_WALLET` on any page, for example `https://aeralend.app/trade/?market=btc&ref=YOUR_WALLET`. The app remembers it for 30 days (the last link wins) and adds it to every perps order and swap. Nothing else is needed.

### Perps orders with a referrer

An order is submitted by the trader and filled by Aera's keeper on the first asset and settlement prices published 2–32 s later. The referrer is stored in the order the trader signs, so nobody can change it.

```ts
import { randomBytes } from 'node:crypto';
import { fetchLinearMarket, linearOpenQuote, linearSubmitIx, linearPriceBounds, bcookUsdValue } from '@aera/sdk';

const connection = new Connection('https://rpc.cookiescan.io', 'confirmed');
const trader = wallet.publicKey;

// Market: 'SOL', 'BTC', 'ETH', 'HYPE' (shared Pool vault) or 'MCOOK' (COOK-PERP).
const view = await fetchLinearMarket(connection, 'BTC', trader);
const q = view.quote; // asset price, settlement band, bCOOK's rate, the capacity's ceiling
if (!q) throw new Error('no fresh prices: the settlement price may be halted');

// $20 long at 2x. USD amounts are micros (6 decimals).
const quote = linearOpenQuote(view.market, trader, 'long', 20_000_000n, 2, q, view.pool);
if (quote.problem) throw new Error(quote.problem); // capacity, limits, paused, ...
// quote.collateral is the bCOOK to send; quote.profitCap is the max win that fits the capacity.
// For display only: bcookUsdValue(quote.collateral, q) is its value at the TWAP.

const [minPrice, maxPrice] = linearPriceBounds(q.assetMicros, 100n); // fill within 1%
const now = await connection.getBlockTime(await connection.getSlot('confirmed'));
const ix = linearSubmitIx(
  'BTC', trader, randomBytes(8).readBigUInt64LE(0),
  { kind: 'open', long: true, collateral: quote.collateral, notional: quote.notional, profitCap: quote.profitCap },
  now!, minPrice, maxPrice,
  REFERRER, // your wallet
);
// add ix to a transaction, have the trader sign, send. The keeper fills it.
```

Other actions, same call and same `REFERRER`:

```ts
{ kind: 'close', position, minimum }                       // full close
{ kind: 'closePart', position, minimum, notional }         // partial close (USD micros; each side ≥ $10)
```

`minimum` is the least bCOOK the trader accepts back (`linearCloseMinimum` computes it at the worst price inside the bounds and a settlement band widened by 1%; use `linearCloseBounds` for close bounds). An order that cannot fill before its deadline (55 s) is refunded with `linearCancelIx`.

Each perps payment emits a `ReferralPaid` event (market, referrer, owner, position, amount, in raw bCOOK) from program `AE5G6RFSxbyJ5HLCSAiXTb96WUkj9tr9zLxjWwZkp4m2`. `MarketPositionOpened` carries `settle_price` (`decodeMarketPositionOpened`).

### Swaps with a referrer

Quotes and the route transaction come from Aera's API; the SDK checks the route and adds Aera's fee (and your share).

```ts
import { VersionedTransaction } from '@solana/web3.js';
import { prepareExchangeTransaction, EXCHANGE_ASSETS } from '@aera/sdk';

const API = 'https://api.aeralend.app/v1/exchange';
const post = async (path: string, body: unknown) => (await fetch(`${API}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();

const request = { inputMint: COOK_MINT, outputMint: SOL_MINT, amount: '25000000000', slippageBps: 50 }; // amount: base units, Aera fee included
const { quotes } = await post('quote', { ...request, venue: 'best' });
const quote = quotes[0];
const built = await post('build', { quoteId: quote.id, owner: trader.toBase58() });
const prepared = await prepareExchangeTransaction(connection, trader, built.transactionBase64, quote, request, { referrer: REFERRER });
// prepared.transaction is a simulated VersionedTransaction: have the trader sign it and send it before quote.expiresAt.
```

Supported tokens are `EXCHANGE_ASSETS` (COOK, SOL, bCOOK). Calling the API from a browser extension or another web origin may be blocked by CORS: call it from your backend, or ask us to allow your origin.

## Partial closes and Wick-proof

* `closePart` closes part of a position: margin and max win scale with it; entry price and funding carry over. `linearPartialClose` previews it.
* **Wick-proof positions are paused at launch** on the bCOOK program (`maxPositions: 0`, `wickOffered()` is false; `wickOpenQuote` says so). The code paths (`openWick`, `wickOpenQuote`, `linearSettleWickIx`) are unchanged for when they reopen.

## Migrating from 0.2.0

Every change below is breaking for a 0.2.0 perps integration. Swaps, lending and referrals on swaps are unchanged.

1. **Program id.** Perps PDAs and builders target `AE5G6RFSxbyJ5HLCSAiXTb96WUkj9tr9zLxjWwZkp4m2` (`PERPS_PROGRAM_ID`). `PERPS_V2_PROGRAM_ID` is removed: the aSOL program `GqvG8aNWa8fJ8xuoPqqHbPiowVbX4GWm8gMPsSyFgJfq` is `RETIRED_ASOL_PERPS_PROGRAM_ID` (paused, read-only history).
2. **bCOOK, classic SPL Token, everywhere aSOL was:** user accounts, market and pool vaults, the referrer's account, the fee destination's account. Use `marketsBcookAccount(owner)` (or `marketsTokenAccount(owner)`) instead of `marketsAsolAccount`, and `TOKEN_PROGRAM_ID`, not `TOKEN_2022_PROGRAM_ID`. Referral payouts arrive as bCOOK in the referrer's classic ATA.
3. **Two accounts of every linear-market and pool instruction changed, same positions:** the account formerly `sol_price` (`["price"]`) is `settle` = `["pool-oracle", "MCOOK"]` (`settleOracleAccount()`); the account formerly `reserve` (Aera's SOL reserve) is `stake_pool` = `GxbNKNYdtNXQkhDkpHdLDAMX64GxaECgANqdfp6cUGH4` (`rateAccount()`). No Aera accrue instruction is needed. `post_pool_price` still takes the SOL price `["price"]`.
4. **Quotes.** `LinearQuote` is now `BcookQuote | AsolV2Quote`. A `BcookQuote` is `{ assetMicros, settleTwap, settleLo, settleHi, rateE9, oiCapUsdMicros? }`: take `fetchLinearMarket(...).quote`, or build it with `bcookQuote(assetMicros, poolQuote, bcookRate(stakePoolAccountData))`. The 0.2.0 shape `{ assetMicros, solMicros, rateE9 }` still type-checks but computes the retired program's arithmetic: do not use it for the new program.
5. **`fetchLinearMarket(connection, feed, owner?, program?)`** returns `settle` (the settlement post), `rate` (bCOOK's gross rate and withdrawal fee) and `quote`; `solPrice` is null on the new program; `mine.asol` is now `mine.balance` (raw bCOOK).
6. **`PoolQuote.previousPublishedAt`** (the oracle account grew by 8 bytes, 1,516). `decodePoolOracle(data, program?)` reads either layout. Orders fill only on the first settlement post of their window (`firstInWindow(publishedAt, previousPublishedAt, createdAt)`).
7. **Event:** `MarketPositionOpened.sol_price` is `settle_price` (the TWAP, USD micros per million COOK).
8. **Removed instructions:** the inverse SOL-PERP's `initialize`, `set_paused`, `submit`, `execute`, `cancel`, `checkpoint`, `liquidate`, `outage_close`, `outage_withdraw`, `collect_protocol_fees`, `collect_bucket_fees` do not exist on the new program. The `perps*` builders of the inverse market (`perpsLive.ts`) only ever target the retired program.
9. **New refusals:** an LP deposit below 10,000 bCOOK, or a withdrawal leaving less (`Accounting`; `LINEAR_TERMS.minLpDeposit` is now `10_000_000_000_000n`, `lpFloorProblem`); an open whose book would exceed the settlement capacity (`Market`; `maxCapThatFits`, `linearOpenQuote(...).capacity`).
10. **LP NAV has two sides:** `poolNav`, `poolUnrealizedPnl` and `linearLpNav` take a last `side: 'deposit' | 'withdraw'` (default `'withdraw'`, the lower NAV). A deposit's shares are priced at the `'deposit'` NAV.
11. **Sizing:** `linearOpenQuote` and `wickOpenQuote` size against the band (1% buffer, `LINEAR_SETTLE_BUFFER_BPS`; `LINEAR_SOL_BUFFER_BPS` is a deprecated alias) and hold the cap within the capacity; `linearCloseMinimum`'s last argument widens the settlement band instead of moving a SOL price; `linearLiquidationPrice` is where the position is liquidatable at both ends.
12. **`POOL_MEMBER_FEEDS`** is `BTC, ETH, SOL, HYPE` (the new pool's member order); always read the order from the pool's ledger (`poolMemberAccounts(pool)`).
13. **Every address helper and builder takes a last optional `program`** (`'bcook'`, the default, or `'asol-v2'`); `postFeedPriceIx` refuses `MCOOK` (pool-priced).

New in 0.3.0: `bcookRate`, `settlementBand`, `bcookQuote`, `quoteAtSettle`, `settleCapacity`, `bookReserved`, `maxCapThatFits`, `linearOpenTerms` (the engine's exact open terms), `linearNavPnl`, `linearFundingRate`, `linearDepositShares`, `lpFloorProblem`, `bcookUsdValue`, `cookForBcook`, `stakeForBcookIxs`, `usdToBcook`, `decodeMarketPositionOpened`, `postSolPriceIx`, `setMarketLimitsIx`, `setPoolPinsIx`, `perpsDeployment`.

## Migrating from 0.4.0

0.5.0 changes one thing you may have built: **`postPoolPriceIx` now ends with a read-only `cook-feed` account** (`cookFeedAccount()`). The upgraded program reads it to learn which source publishes COOK's price; a program that predates it ignores a trailing account, so 0.5.0's builder works against the old and the new program alike. Rebuild it with 0.5.0 before the program upgrade lands; an instruction built with 0.4.0 fails afterwards (it lacks the account). Nothing else you send changes: orders, closes, margin, liquidations and claims are the same bytes and the same accounts, and no account you read changes layout.

What is new (`src/cookFeed.ts`, pinned to the program's golden file):

* **Where COOK's price comes from.** The settlement band that converts every USD result into bCOOK is built from the COOK/SOL price. Until the owner switches it, that is the two thin Cookie pools; afterwards it is the deep Solana pool as read and signed by Aera's five price signers (the program verifies four of five). `decodeCookFeed(account)` and `effectiveCookSettings(feed, now)` tell you which source is in force (`source`: `COOK_SOURCE.cookie` or `.signed`), the ceiling and the share that size the book, and the last signed reading (`lastPrice` lamports per million COOK, `lastDepth` the pool's SOL side). The account is absent until the owner creates it: absent means the Cookie pools and no ceiling.
* **Capacity.** The open-interest ceiling per market is already in the settlement oracle's quote (`oiCapUsdMicros`, unchanged field); after the switch it is `min(share x the smallest signed depth, ceiling)`. `cookCapacity(settings, minDepth, solUsdMicros)` reproduces the formula. A cap that changes is normal now: read it per quote, do not hard-code it.
* **Posting.** `postSignedCookIx` is the signed source's post (any wallet; alone in its transaction; about 400,000 compute units). Keepers choose it over `postPoolPriceIx` when the source is signed; the program refuses the other one. `cookValue`, `splitCookValue` and `lamportsPerMillionCook` are the signers' wire format.
* **Admin.** `initCookFeedIx`, `setCookFeedIx`, `applyCookFeedIx`, `cancelCookFeedIx`, `cookSettingsProblems` and `cookSettingsApplyAtOnce` (tightening applies at once; a loosening, the signed source included, waits the config's timelock).

What it costs you to trust: after the switch COOK's price depends on Aera's five signer keys the way BTC, ETH, SOL and HYPE already do, and every source behind the signers mirrors one Solana pool. Not audited.

## Migrating from 0.3.0

The program id (`AE5G6RFSxbyJ5HLCSAiXTb96WUkj9tr9zLxjWwZkp4m2`) and the margin token (bCOOK) are unchanged. What changed:

1. **Rebuild every perps and Pool instruction with 0.4.0.** On the bCOOK program the instructions that read the settlement price and the bCOOK rate now carry a read-only `config` account (`configAccount()`, the price-signer settings). An order built with 0.3.0 fails on chain.
2. **Ledgers are v4** (`LEDGER_MAGIC`). `fetchLinearMarket` and the decoders read v3 and v4. `LinearLedger` gains `risk`, `claims`, `badDebt`, `breakerUntil`, `pendingRisk` and `v4`; a v3 ledger gets `defaultRisk(limits)`. All five launch markets are migrated to v4.
3. **Leverage is per market and tiered by size.** Launch maximums: BTC and ETH 50x, SOL 30x, HYPE 20x, COOK-PERP 2x (paused). Use `leverageForNotional(limits, risk, notional)`, `topLeverage(limits, risk)` and, for what is allowed right now, `openLeverageNow(ledger, notional, now, assetMicros, previousAssetMicros)`: a volatility breaker (`breakerActive`) lowers it for a few minutes after a price jump. Read the numbers from the ledger; do not hard-code them, they are admin settings with on-chain bounds (`RISK_BOUNDS`).
4. **Marks take the market's rules.** `linearMark`, `linearLiquidationPrice`, `linearFee`, `linearMaintenance` and `cookDropToLiquidate` take a last `rules` argument (`riskRules(ledger.risk)`: fee, maintenance, whether a bankrupt position is liquidated). The default is the v3 rule set, so a liquidation price computed without the ledger's rules is wrong on a 50x market. `positionLeverage(position, quote)` gives the live leverage.
5. **Margin can be added and removed.** `addMarginIx(owner, feed, position, amount)` adds in one transaction. Removing is an order, `{ kind: 'removeMargin', position, amount }`, filled at the next settlement price like any other; `maxRemovableMargin(...)` is the most that keeps the position inside its leverage limit.
6. **Delayed settlement of large results.** A close whose gain or loss is above the market's `deferGainUsd` / `deferLossUsd` is revalued on the TWAP of the `deferWindowSeconds` after the close and paid by `settleClaimIx(feed, claimId, owner, pool?)` once due; `ledger.claims` lists them, `claimPayout(claim, cumNow, cumNowAt, now)` previews the payout, and `CLAIM_STALE_SECONDS` (72 h) is the settlement-outage limit. Show a pending claim to the trader; it is not a failed close.
7. **Insurance fund.** A share of fees (`risk.insuranceBps`) builds a fund that pays bad debt before the LPs: `ledger.badDebt = { shortfall, covered, uncovered }`. `fundInsuranceIx` lets anyone add to it.
8. **Prices.** `decodeSolPrice` adds `previousPriceMicros`; `firstInWindow(publishedAt, previous, createdAt, window?)` takes the fill window, which is an admin setting (`decodeProgramConfig`, `effectiveOracleSettings`). Prices are signed by Aera's own signer set, not RedStone's: do not post or verify RedStone packages yourself.
9. **Admin builders** (`setMarketRiskIx`, `applyMarketRiskIx`, `proposeOracleSettingsIx`, `migrateMarketIx` and the like) exist for Aera's own tooling; a wallet integration does not call them.

### The retired aSOL program

`'asol-v2'` exists so the retired program can be paused, its LPs withdrawn and its fees collected, and its history read: `setMarketPausedIx(admin, feed, true, 'asol-v2')`, `poolSubmitIx(owner, nonce, { kind: 'withdraw', … }, now, 0, 'asol-v2')`, `linearCollectIx(feed, true, 'asol-v2')` (aSOL, Token-2022). Do not build new positions for it.

## Support

Reach the Aera team through the links on https://aeralend.app. Report anything that looks wrong before you ship it to users.
