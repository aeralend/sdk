/**
 * The live SOL perps market (`protocol/perps-live`, program GqvG8…).
 *
 * Inverse SOL/USD, margined and settled in aSOL. A trader never sends a price:
 * every action is an *intent* that escrows its aSOL at submission, and the
 * keeper executes it on the first RedStone price published at least 2 seconds
 * later, within the intent's own price bounds. An intent that cannot execute is
 * refunded by its owner after its deadline (at most 60 s).
 *
 * The arithmetic here mirrors `perps-live/perps-engine` (fees, leverage,
 * maintenance, marks) for display and sizing. The program is the authority: a
 * quote that is off by a unit fails on chain, it never fills differently.
 */
import { Connection, PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';

export const PERPS_LIVE_PROGRAM_ID = new PublicKey('GqvG8aNWa8fJ8xuoPqqHbPiowVbX4GWm8gMPsSyFgJfq');
export const PERPS_ASOL_MINT = new PublicKey('FHv5bDrikq9sA4ckNNTsvqZHGoWYSnPMFJC8xHszKwbq');
/** Aera's SOL reserve in market 1: aSOL's exchange rate is read from it. */
export const PERPS_SOL_RESERVE = new PublicKey('HEr4uwrN7Cz1uegzYRP7GiHPXN2GjMK6tvQCTm12phjT');

/** Engine terms, fixed in the deployed program. */
export const PERPS_TERMS = Object.freeze({
  maxLeverage: 3,
  /** Charged on opening and again on closing. */
  feeBps: 8,
  maintenanceBps: 1000,
  maxNotionalUsd: 1000,
  /** The smallest position, so the 16 slots cannot be filled with dust. */
  minNotionalUsd: 10,
  maxPositions: 16,
  /** Open positions one wallet may hold in the market. */
  maxPositionsPerWallet: 4,
  /** Smallest LP deposit, and the smallest LP balance a partial withdrawal may leave: 0.1 aSOL. */
  minLpDeposit: 100_000_000n,
  maxLps: 32,
  /** A price older than this cannot settle anything. */
  maxPriceAgeSeconds: 35,
  /** An intent fills only on a price published this many seconds after it. */
  minFillDelaySeconds: 2,
  maxFillDelaySeconds: 32,
  /** Intents expire this long after submission at most. */
  maxDeadlineSeconds: 60,
  /**
   * How long after submission an order may still fill, then becomes refundable.
   * It must outlast the 2-32 s fill window plus RedStone delivery lag, inside
   * the program's 3-60 s; 55 s leaves room for Cookie's clock running behind.
   */
  orderDeadlineSeconds: 55,
  /** Fee split of every collected fee. */
  feeSplitBps: { lp: 4000, insurance: 1000, holders: 3000, protocol: 2000 },
});

const SCALE = 1_000_000_000n;
const BPS = 10_000n;
const FUNDING_SCALE = 1_000_000_000_000_000_000n;

const DISC = {
  submit: [88, 166, 102, 181, 162, 127, 170, 48],
  cancel: [232, 219, 223, 41, 219, 236, 220, 190],
  Intent: [247, 162, 35, 165, 254, 111, 129, 109],
  MarketState: [0, 125, 123, 215, 95, 96, 164, 194],
} as const;

// --- addresses -------------------------------------------------------------------

const seed = (s: string) => new TextEncoder().encode(s);
const pda = (...seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, PERPS_LIVE_PROGRAM_ID)[0];
const U64_MAX = 18_446_744_073_709_551_615n;
/** Refuse what would otherwise wrap modulo 2^64 when encoded. */
export function assertU64(v: bigint, what = 'amount'): bigint {
  if (typeof v !== 'bigint' || v < 0n || v > U64_MAX) throw new Error(`${what} is outside the u64 range`);
  return v;
}
const le64 = (v: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, assertU64(v, 'nonce'), true); return b; };
export const perpsMarket = (): PublicKey => pda(seed('market'));
export const perpsVault = (): PublicKey => pda(seed('custody'));
export const perpsPriceAccount = (): PublicKey => pda(seed('price'));
export const perpsIntent = (owner: PublicKey, nonce: bigint): PublicKey => pda(seed('intent'), owner.toBytes(), le64(nonce));
export const perpsAsolAccount = (owner: PublicKey): PublicKey =>
  getAssociatedTokenAddressSync(PERPS_ASOL_MINT, owner, true, TOKEN_2022_PROGRAM_ID);

// --- accounts ----------------------------------------------------------------------

export type PerpSide = 'long' | 'short';
export interface PerpsPosition {
  id: bigint;
  owner: PublicKey;
  side: PerpSide;
  /** aSOL base units after the opening fee. */
  margin: bigint;
  notionalUsdMicros: bigint;
  entryPriceMicros: bigint;
  /** The most this position can ever win, reserved from LP capital at entry. */
  profitCap: bigint;
  fundingEntry: bigint;
}
export interface PerpsLedger {
  lpCash: bigint;
  lpShareSupply: bigint;
  lpBalances: Map<string, bigint>;
  positions: PerpsPosition[];
  nextId: bigint;
  protocolFees: bigint;
  insuranceFees: bigint;
  holderFees: bigint;
  fundingIndex: bigint;
  fundingRate: bigint;
  fundingTime: bigint;
  fundingValidUntil: bigint;
  lastPublication: bigint;
}
export interface PerpsMarketState {
  paused: boolean;
  /** aSOL escrowed by intents not yet executed or refunded. */
  pending: bigint;
  ledger: PerpsLedger;
}
export interface PerpsPrice {
  priceUsdMicros: bigint;
  publishedAt: number;
  signers: number;
}
export type PerpsAction =
  | { kind: 'open'; long: boolean; collateral: bigint; notional: bigint; profitCap: bigint }
  | { kind: 'close'; position: bigint; minimum: bigint }
  | { kind: 'deposit'; amount: bigint; minimum: bigint }
  | { kind: 'withdraw'; shares: bigint; minimum: bigint };
export interface PerpsIntent {
  address: PublicKey;
  owner: PublicKey;
  nonce: bigint;
  action: PerpsAction;
  createdAt: number;
  deadline: number;
  minPrice: bigint;
  maxPrice: bigint;
  active: boolean;
}

function expect(d: Uint8Array, name: 'MarketState' | 'Intent') {
  if (!DISC[name].every((b, i) => d[i] === b)) throw new Error(`not a perps ${name} account`);
}

class Reader {
  o: number;
  constructor(private d: Uint8Array, at = 0) { this.o = at; }
  private view(n: number) { const v = new DataView(this.d.buffer, this.d.byteOffset + this.o, n); this.o += n; return v; }
  u8() { return this.view(1).getUint8(0); }
  u32() { return this.view(4).getUint32(0, true); }
  u64() { return this.view(8).getBigUint64(0, true); }
  i64() { return this.view(8).getBigInt64(0, true); }
  i128() { const v = this.view(16); return v.getBigUint64(0, true) | (v.getBigInt64(8, true) << 64n); }
  key() { const k = new PublicKey(this.d.subarray(this.o, this.o + 32)); this.o += 32; return k; }
}

/** The program's `MarketState` account, ledger included. */
export function decodePerpsMarket(d: Uint8Array): PerpsMarketState {
  expect(d, 'MarketState');
  const r = new Reader(d, 8 + 32 + 32 + 1);
  const paused = r.u8() === 1;
  const pending = r.u64();
  r.u32(); // ledger byte length
  const lpCash = r.u64();
  const lpShareSupply = r.u64();
  const lpBalances = new Map<string, bigint>();
  for (let n = r.u32(); n > 0; n--) lpBalances.set(r.key().toBase58(), r.u64());
  const positions: PerpsPosition[] = [];
  for (let n = r.u32(); n > 0; n--) {
    const id = r.u64();
    positions.push({
      id,
      owner: r.key(),
      side: r.u8() === 0 ? 'long' : 'short',
      margin: r.u64(),
      notionalUsdMicros: r.u64(),
      entryPriceMicros: r.u64(),
      profitCap: r.u64(),
      fundingEntry: r.i128(),
    });
  }
  return {
    paused,
    pending,
    ledger: {
      lpCash, lpShareSupply, lpBalances, positions,
      nextId: r.u64(), protocolFees: r.u64(), insuranceFees: r.u64(), holderFees: r.u64(),
      fundingIndex: r.i128(), fundingRate: r.i128(), fundingTime: r.i64(), fundingValidUntil: r.i64(), lastPublication: r.i64(),
    },
  };
}

export function decodePerpsPrice(d: Uint8Array): PerpsPrice {
  const r = new Reader(d, 8);
  return { priceUsdMicros: r.u64(), publishedAt: Number(r.i64()), signers: r.u8() };
}

export function decodePerpsIntent(address: PublicKey, d: Uint8Array): PerpsIntent {
  expect(d, 'Intent');
  const r = new Reader(d, 8);
  const owner = r.key();
  const nonce = r.u64();
  const tag = r.u8();
  let action: PerpsAction;
  if (tag === 0) action = { kind: 'open', long: r.u8() === 1, collateral: r.u64(), notional: r.u64(), profitCap: r.u64() };
  else if (tag === 1) action = { kind: 'close', position: r.u64(), minimum: r.u64() };
  else if (tag === 2) action = { kind: 'deposit', amount: r.u64(), minimum: r.u64() };
  else action = { kind: 'withdraw', shares: r.u64(), minimum: r.u64() };
  const createdAt = Number(r.i64());
  r.u64(); // created_slot
  return { address, owner, nonce, action, createdAt, deadline: Number(r.i64()), minPrice: r.u64(), maxPrice: r.u64(), active: r.u8() === 1 };
}

// --- arithmetic (mirrors perps-engine) --------------------------------------------------

const ceilDiv = (n: bigint, d: bigint) => n / d + (n % d === 0n ? 0n : 1n);
/** Euclidean floor for signed values, as Rust's `div_euclid` with a positive divisor. */
const floorDiv = (n: bigint, d: bigint) => { const q = n / d; return n % d !== 0n && (n < 0n) !== (d < 0n) ? q - 1n : q; };
/** aSOL base units for `lamports` of SOL at `rateE9` (SOL per aSOL, 1e9-scaled), rounded up. */
const sharesCeil = (lamports: bigint, rateE9: bigint) => ceilDiv(lamports * SCALE, rateE9);

/** The fee on `notional` USD-micros, in aSOL base units: `PERPS_TERMS.feeBps`, rounded up. */
export function perpsFee(notional: bigint, priceMicros: bigint, rateE9: bigint): bigint {
  return sharesCeil(ceilDiv(notional * SCALE * BigInt(PERPS_TERMS.feeBps), priceMicros * BPS), rateE9);
}

/** The funding index at `now`, as `Market::funding_index`. */
export function perpsFundingIndex(l: PerpsLedger, now: bigint): bigint {
  const end = now < l.fundingValidUntil ? now : l.fundingValidUntil;
  const seconds = end > l.fundingTime ? end - l.fundingTime : 0n;
  return l.fundingIndex + l.fundingRate * seconds;
}

export interface PerpsMark {
  /** Signed aSOL base units, clamped to [-margin, profitCap]. */
  pnl: bigint;
  closingFee: bigint;
  /** What closing now would pay out, in aSOL base units. */
  payable: bigint;
  maintenance: bigint;
  liquidatable: boolean;
  profitCapReached: boolean;
}

/** `mark_with_funding`: a position marked at `priceMicros`. */
export function perpsMark(p: PerpsPosition, priceMicros: bigint, rateE9: bigint, fundingIndex: bigint): PerpsMark {
  const direction = p.side === 'long' ? 1n : -1n;
  const n = p.notionalUsdMicros * SCALE * (priceMicros - p.entryPriceMicros) * direction * SCALE;
  const d = p.entryPriceMicros * priceMicros * rateE9;
  const funding = (fundingIndex - p.fundingEntry) * p.notionalUsdMicros * -direction;
  const raw = floorDiv(n, d) + floorDiv(funding, FUNDING_SCALE);
  const pnl = raw < -p.margin ? -p.margin : raw > p.profitCap ? p.profitCap : raw;
  const equity = p.margin + pnl;
  const fee = perpsFee(p.notionalUsdMicros, priceMicros, rateE9);
  const closingFee = fee < equity ? fee : equity;
  const maintenance = sharesCeil(ceilDiv(p.notionalUsdMicros * SCALE * 1000n, priceMicros * BPS), rateE9);
  const payable = equity - closingFee;
  return { pnl, closingFee, payable, maintenance, liquidatable: payable <= maintenance, profitCapReached: raw >= p.profitCap };
}

/**
 * The SOL/USD price at which a position becomes liquidatable, ignoring
 * funding: payable falls to the 10% maintenance margin. Null when it never
 * does (a short whose margin covers its notional).
 */
export function perpsLiquidationPrice(p: Pick<PerpsPosition, 'side' | 'margin' | 'notionalUsdMicros' | 'entryPriceMicros'>, rateE9: bigint): number | null {
  const marginSol = (Number(p.margin) * Number(rateE9)) / 1e18;
  const notional = Number(p.notionalUsdMicros) / 1e6;
  const entry = Number(p.entryPriceMicros) / 1e6;
  // Inverse PnL in SOL: long N(1/e - 1/p), short N(1/p - 1/e). Liquidation when
  // margin + PnL - fee(feeBps of N/p) <= maintenance (10% of N/p).
  const fee = PERPS_TERMS.feeBps / 10_000;
  const k = 1 + fee + 0.1;
  if (p.side === 'long') return (notional * k) / (marginSol + notional / entry);
  const room = notional / entry - marginSol;
  return room > 0 ? (notional * (1 - fee - 0.1)) / room : null;
}

export interface PerpsOpenQuote {
  /** aSOL to escrow: margin plus the opening fee. */
  collateral: bigint;
  margin: bigint;
  openingFee: bigint;
  notional: bigint;
  /** The position's maximum win, reserved from LP free capital. */
  profitCap: bigint;
  liquidationPrice: number | null;
  /** Why it cannot open now, or null. */
  problem: string | null;
}

/** LP capital not already reserved for open positions' maximum wins. */
export function perpsFreeCash(l: PerpsLedger): bigint {
  const reserved = l.positions.reduce((sum, p) => sum + p.profitCap, 0n);
  return l.lpCash > reserved ? l.lpCash - reserved : 0n;
}

/**
 * Size an order: `notionalUsdMicros` at `leverage`, at the current price. The
 * maximum win is the margin (a 100% return), or less when LP free capital is
 * smaller; the engine rejects a cap above free capital.
 */
export function perpsOpenQuote(
  market: PerpsMarketState,
  side: PerpSide,
  notionalUsdMicros: bigint,
  leverage: number,
  priceMicros: bigint,
  rateE9: bigint,
  /** The wallet opening it, for the per-wallet position limit. */
  owner?: PublicKey,
): PerpsOpenQuote {
  const lev = BigInt(Math.max(1, Math.min(PERPS_TERMS.maxLeverage, Math.floor(leverage))));
  // Size at the lowest price the order may fill at (its lower bound): a lower
  // fill needs more margin for the same leverage and charges a larger fee, so
  // sizing at the quoted price failed every 3x order that filled lower.
  const floor = perpsPriceBounds(priceMicros)[0];
  const openingFee = perpsFee(notionalUsdMicros, floor, rateE9);
  // margin_sol * price * 3 >= notional, with margin_sol floored from shares: one unit of slack.
  const marginLamports = ceilDiv(notionalUsdMicros * SCALE, floor * lev);
  const margin = sharesCeil(marginLamports, rateE9) + 1n;
  const collateral = margin + openingFee;
  const free = perpsFreeCash(market.ledger);
  const profitCap = margin < free ? margin : free;
  let problem: string | null = null;
  if (market.paused) problem = 'Trading is paused.';
  else if (notionalUsdMicros <= 0n) problem = 'Enter a size.';
  else if (notionalUsdMicros < BigInt(PERPS_TERMS.minNotionalUsd) * 1_000_000n) problem = `The smallest position is $${PERPS_TERMS.minNotionalUsd}.`;
  else if (notionalUsdMicros > BigInt(PERPS_TERMS.maxNotionalUsd) * 1_000_000n) problem = `SOL-PERP caps a position at $${PERPS_TERMS.maxNotionalUsd.toLocaleString('en-US')}.`;
  else if (owner && market.ledger.positions.filter((p) => p.owner.equals(owner)).length >= PERPS_TERMS.maxPositionsPerWallet) problem = `A wallet can hold ${PERPS_TERMS.maxPositionsPerWallet} open positions. Close one first.`;
  else if (market.ledger.positions.length >= PERPS_TERMS.maxPositions) problem = 'Every position slot is taken. Try again after one closes.';
  else if (profitCap === 0n) problem = 'The LP vault has no free capital to back a new position.';
  const liquidationPrice = perpsLiquidationPrice({ side, margin, notionalUsdMicros, entryPriceMicros: priceMicros }, rateE9);
  return { collateral, margin, openingFee, notional: notionalUsdMicros, profitCap, liquidationPrice, problem };
}

/** Value of `shares` LP shares at the ledger's cash, ignoring unrealized PnL. */
export function perpsLpValue(l: PerpsLedger, shares: bigint): bigint {
  return l.lpShareSupply === 0n ? 0n : (shares * l.lpCash) / l.lpShareSupply;
}

// --- reading -----------------------------------------------------------------------------

export interface PerpsLiveState {
  market: PerpsMarketState;
  price: PerpsPrice | null;
  /** aSOL's value in SOL, 1e9-scaled, from Aera's SOL reserve. */
  rateE9: bigint;
  slot: number;
  /** Only when an owner was given. */
  mine: { positions: PerpsPosition[]; lpShares: bigint; intents: PerpsIntent[]; asol: bigint } | null;
}

/** aSOL's value in SOL (1e9-scaled) from Aera's SOL reserve account data. */
export function perpsReserveRate(d: Uint8Array): bigint {
  const r = new Reader(d, 169);
  const available = r.u64();
  const supply = r.u64();
  const principal = (() => { const v = new DataView(d.buffer, d.byteOffset + 185, 16); return v.getBigUint64(0, true) | (v.getBigUint64(8, true) << 64n); })();
  const index = (() => { const v = new DataView(d.buffer, d.byteOffset + 201, 16); return v.getBigUint64(0, true) | (v.getBigUint64(8, true) << 64n); })();
  const fees = new DataView(d.buffer, d.byteOffset + 225, 8).getBigUint64(0, true);
  if (supply === 0n) return SCALE;
  const product = principal * index;
  const borrowed = product / 1_000_000_000_000_000_000n + (product % 1_000_000_000_000_000_000n === 0n ? 0n : 1n);
  return ((available + borrowed - fees) * SCALE) / supply;
}

/** Market, price, aSOL rate and (optionally) one wallet's positions, LP and open intents. */
export async function fetchPerpsLive(connection: Connection, owner?: PublicKey): Promise<PerpsLiveState> {
  const keys = [perpsMarket(), perpsPriceAccount(), PERPS_SOL_RESERVE, ...(owner ? [perpsAsolAccount(owner)] : [])];
  const { context, value } = await connection.getMultipleAccountsInfoAndContext(keys, 'confirmed');
  const [m, p, reserve, ata] = value;
  if (!m || !m.owner.equals(PERPS_LIVE_PROGRAM_ID)) throw new Error('the perps market is not on chain');
  const market = decodePerpsMarket(m.data);
  const rateE9 = reserve ? perpsReserveRate(reserve.data) : SCALE;
  let mine: PerpsLiveState['mine'] = null;
  if (owner) {
    const raw = await connection.getProgramAccounts(PERPS_LIVE_PROGRAM_ID, {
      commitment: 'confirmed',
      filters: [{ dataSize: 160 }, { memcmp: { offset: 8, bytes: owner.toBase58() } }],
    });
    const intents = raw.map((a) => decodePerpsIntent(a.pubkey, a.account.data)).filter((i) => i.active);
    const asol = ata && ata.data.length >= 72 ? new DataView(ata.data.buffer, ata.data.byteOffset + 64, 8).getBigUint64(0, true) : 0n;
    mine = {
      positions: market.ledger.positions.filter((x) => x.owner.equals(owner)),
      lpShares: market.ledger.lpBalances.get(owner.toBase58()) ?? 0n,
      intents,
      asol,
    };
  }
  return { market, price: p ? decodePerpsPrice(p.data) : null, rateE9, slot: context.slot, mine };
}

// --- instructions --------------------------------------------------------------------------

const w = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });
const ro = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });

function encodeAction(a: PerpsAction): Uint8Array {
  const out = new Uint8Array(a.kind === 'open' ? 26 : 17);
  const v = new DataView(out.buffer);
  if (a.kind === 'open') {
    out[0] = 0; out[1] = a.long ? 1 : 0;
    v.setBigUint64(2, assertU64(a.collateral, 'collateral'), true); v.setBigUint64(10, assertU64(a.notional, 'notional'), true); v.setBigUint64(18, assertU64(a.profitCap, 'profit cap'), true);
  } else {
    out[0] = a.kind === 'close' ? 1 : a.kind === 'deposit' ? 2 : 3;
    const [x, y] = a.kind === 'close' ? [a.position, a.minimum] : a.kind === 'deposit' ? [a.amount, a.minimum] : [a.shares, a.minimum];
    v.setBigUint64(1, assertU64(x), true); v.setBigUint64(9, assertU64(y, 'minimum'), true);
  }
  return out;
}

/**
 * Submit an intent. `nowSeconds` should be the chain's clock (Cookie's trails
 * real time by a second or two); the deadline is `PERPS_TERMS.orderDeadlineSeconds`
 * after it, inside the program's 3–60 s window. Price bounds are inclusive, in USD micros.
 */
export function perpsSubmitIx(owner: PublicKey, nonce: bigint, action: PerpsAction, nowSeconds: number, minPrice: bigint, maxPrice: bigint): TransactionInstruction {
  const head = new Uint8Array([...DISC.submit, ...le64(nonce)]);
  const body = encodeAction(action);
  const tail = new Uint8Array(24);
  const v = new DataView(tail.buffer);
  v.setBigInt64(0, BigInt(nowSeconds + PERPS_TERMS.orderDeadlineSeconds), true);
  v.setBigUint64(8, assertU64(minPrice, 'min price'), true);
  v.setBigUint64(16, assertU64(maxPrice, 'max price'), true);
  return new TransactionInstruction({
    programId: PERPS_LIVE_PROGRAM_ID,
    keys: [w(owner, true), w(perpsIntent(owner, nonce)), w(perpsAsolAccount(owner)), w(perpsMarket()), w(perpsVault()), ro(PERPS_ASOL_MINT), ro(TOKEN_2022_PROGRAM_ID), ro(SystemProgram.programId)],
    data: Buffer.from([...head, ...body, ...tail]),
  });
}

/** Refund an intent that missed its deadline. */
export function perpsCancelIx(owner: PublicKey, intent: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PERPS_LIVE_PROGRAM_ID,
    keys: [{ pubkey: owner, isSigner: true, isWritable: false }, w(intent), w(perpsAsolAccount(owner)), w(perpsMarket()), w(perpsVault()), ro(PERPS_ASOL_MINT), ro(TOKEN_2022_PROGRAM_ID)],
    data: Buffer.from(DISC.cancel),
  });
}

/**
 * Bounds for closing `side`: only the side that hurts the trader is limited
 * (a long closing lower, a short closing higher); a move in their favour must
 * never make the close fail.
 */
export function perpsCloseBounds(side: PerpSide, priceMicros: bigint, bps = 100n): [bigint, bigint] {
  return side === 'long' ? [(priceMicros * (BPS - bps)) / BPS, U64_MAX] : [1n, (priceMicros * (BPS + bps)) / BPS];
}

/** The least a close may pay: the position's payout at the worst price its bounds allow. */
export function perpsCloseMinimum(p: PerpsPosition, worstPriceMicros: bigint, rateE9: bigint, fundingIndex: bigint): bigint {
  return perpsMark(p, worstPriceMicros, rateE9, fundingIndex).payable;
}

/** The LP pool's value as the engine prices withdrawals: cash minus traders' unrealized PnL. */
export function perpsLpNav(l: PerpsLedger, priceMicros: bigint, rateE9: bigint, now: bigint): bigint {
  const funding = perpsFundingIndex(l, now);
  const pnl = l.positions.reduce((sum, p) => sum + perpsMark(p, priceMicros, rateE9, funding).pnl, 0n);
  const nav = l.lpCash - pnl;
  return nav > 0n ? nav : 0n;
}

/** Slippage bounds around `priceMicros`: `bps` either side. */
export function perpsPriceBounds(priceMicros: bigint, bps = 100n): [bigint, bigint] {
  return [(priceMicros * (BPS - bps)) / BPS, (priceMicros * (BPS + bps)) / BPS];
}

/** A fresh nonce for a wallet's next intent. */
export const perpsNonce = (): bigint => BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
