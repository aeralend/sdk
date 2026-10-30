/**
 * Perps holder fees to aSOL stakers: the "real yield" half of aSOL staking.
 *
 * Every perps fee splits LP 40% / protocol 20% / insurance 10% / holders 30%.
 * The insurance and holder buckets leave a market together, as aSOL, to Aera's
 * fee destination (`collect_bucket_fees`, `collect_market_bucket_fees`), so the
 * holders' part of a bucket payout is 3/4 of it. Aera keeps protocol and
 * insurance; the holders' part is redeemed to SOL and funded into the aSOL
 * staking stream by `scripts/route-holder-fees.mjs`.
 *
 * Nothing here keeps a ledger file. What is owed is derived from chain
 * history alone, so a routing can be re-run at any time without paying twice:
 *
 *   accrued = sum over bucket collects of floor(3/4 x aSOL paid to the fee destination)
 *   routed  = sum over recorded routings of aSOL that left the fee destination
 *   owed    = accrued - routed
 *
 * A routing is one atomic transaction (redeem, transfer, fund, memo), signed by
 * the fee destination and the staking admin, so its record and its payment
 * exist together or not at all.
 *
 * The stake program has one stream, so Aera's budget and routed fees share it.
 * Every fund through Aera's tools carries a memo recording how much of what is
 * left to stream came from fees; that is how the app splits the stream rate
 * into "perps fee share" and "funded by Aera" without guessing.
 */
import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type ConfirmedSignatureInfo,
  type ParsedInstruction,
  type ParsedTransactionWithMeta,
  type PartiallyDecodedInstruction,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
} from '@solana/spl-token';
import {
  ASOL_MINT,
  ASOL_STAKE_ADMIN,
  ASOL_STAKE_PROGRAM_ID,
  COOKIE_SOL_MINT,
  STREAM_MAX_DURATION,
  STREAM_MIN_DURATION,
  STREAM_PRECISION,
  asolAccount,
  asolRewardVault,
  cookieSolAccount,
  decodeFundAsolStakingData,
  fundAsolStakingIx,
  rewardApr,
  streamAfterFund,
  streamRemaining,
  streamSecondsLeft,
  type AsolStakePool,
} from './asolStaking.js';
import { perpsMarket, perpsVault } from './perpsLive.js';
import { linearCollectIx } from './perpsMarkets.js';

export const PERPS_FEE_PROGRAM_ID = new PublicKey('GqvG8aNWa8fJ8xuoPqqHbPiowVbX4GWm8gMPsSyFgJfq');
/** Where every perps fee is paid, as aSOL. */
export const PERPS_FEE_DESTINATION = new PublicKey('22v7PjUXNu8t9JJhZYFhsS1TFgkqqTxJtq3ZQdy85CyR');
export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
/** `SupplyPosition`: discriminator, reserve, owner, supplied, bump. A first redeem creates it. */
export const SUPPLY_POSITION_SPACE = 8 + 32 + 32 + 8 + 1;
const SECONDS_PER_YEAR = 365n * 86_400n;

/** `collect_bucket_fees` (SOL market) and `collect_market_bucket_fees` (BTC/ETH/HYPE). */
const BUCKET_COLLECT = [
  [0x7c, 0x24, 0x4b, 0xa1, 0xb8, 0xc8, 0x94, 0x59],
  [0x6e, 0x0d, 0x60, 0x4d, 0xe6, 0xba, 0x09, 0x65],
] as const;

/**
 * The permissionless bucket collect for one market (`SOL`, or a linear feed):
 * insurance + holder buckets, as aSOL, to the fee destination's aSOL account,
 * which must exist.
 */
export function bucketCollectIx(market: string): TransactionInstruction {
  if (market !== 'SOL') return linearCollectIx(market, true, 'asol-v2');
  const w = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
  const r = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
  return new TransactionInstruction({
    programId: PERPS_FEE_PROGRAM_ID,
    keys: [w(asolAccount(PERPS_FEE_DESTINATION)), w(perpsMarket()), w(perpsVault()), r(ASOL_MINT), r(TOKEN_2022_PROGRAM_ID)],
    data: Buffer.from(BUCKET_COLLECT[0]),
  });
}

/** Holders' part of a bucket payout: 30 of every 40. Floored, so it never over-counts. */
export const holdersShareOfBucket = (amount: bigint): bigint => (amount * 3n) / 4n;

// --- base58, for instruction data the RPC could not parse --------------------

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58Decode(text: string): Uint8Array {
  let n = 0n;
  for (const c of text) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) throw new Error('not base58');
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  for (; n > 0n; n >>= 8n) bytes.unshift(Number(n & 0xffn));
  for (const c of text) {
    if (c !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

// --- the memo every fund through Aera's tools carries ---------------------------

export const STAKE_FUND_MEMO_PREFIX = 'aera:stake-fund v1';
export type StakeFundKind = 'fees' | 'aera';
export interface StakeFundMemo {
  /** `fees`: perps holder fees routed by route-holder-fees. `aera`: a budget Aera pays for. */
  kind: StakeFundKind;
  /** SOL base units funded by this transaction. */
  amount: bigint;
  seconds: bigint;
  /** aSOL that left the fee destination for it (fees only). */
  asol: bigint;
  /** SOL base units left to stream right after this fund, and how many of them are fees. */
  left: bigint;
  feesLeft: bigint;
  /** The pool's `funded` counter right after this fund. */
  funded: bigint;
}

export function encodeStakeFundMemo(m: StakeFundMemo): string {
  return `${STAKE_FUND_MEMO_PREFIX} kind=${m.kind} amount=${m.amount} seconds=${m.seconds} asol=${m.asol} left=${m.left} fees_left=${m.feesLeft} funded=${m.funded}`;
}

/** Parses a memo as written, or as `getSignaturesForAddress` reports it (`[len] text`). */
export function parseStakeFundMemo(text: string | null | undefined): StakeFundMemo | null {
  if (!text) return null;
  const at = text.indexOf(STAKE_FUND_MEMO_PREFIX);
  if (at < 0) return null;
  const fields = new Map<string, string>();
  for (const part of text.slice(at + STAKE_FUND_MEMO_PREFIX.length).split(/[\s;]+/)) {
    const eq = part.indexOf('=');
    if (eq > 0) fields.set(part.slice(0, eq), part.slice(eq + 1));
  }
  const kind = fields.get('kind');
  if (kind !== 'fees' && kind !== 'aera') return null;
  const num = (k: string) => {
    const v = fields.get(k);
    return v !== undefined && /^\d{1,20}$/.test(v) ? BigInt(v) : null;
  };
  const [amount, seconds, asol, left, feesLeft, funded] = ['amount', 'seconds', 'asol', 'left', 'fees_left', 'funded'].map(num);
  if (amount == null || seconds == null || asol == null || left == null || feesLeft == null || funded == null || feesLeft > left) return null;
  return { kind, amount, seconds, asol, left, feesLeft, funded };
}

// --- reading transactions ---------------------------------------------------------

type AnyIx = ParsedInstruction | PartiallyDecodedInstruction;
const parsed = (ix: AnyIx): ix is ParsedInstruction => 'parsed' in ix;
const dataOf = (ix: AnyIx): Uint8Array | null => {
  if (parsed(ix)) return null;
  try {
    return base58Decode(ix.data);
  } catch {
    return null;
  }
};
const tokenInfo = (ix: AnyIx): { type: string; info: Record<string, any> } | null =>
  parsed(ix) && (ix.program === 'spl-token-2022' || ix.program === 'spl-token') && typeof ix.parsed === 'object' && ix.parsed
    ? { type: String(ix.parsed.type), info: ix.parsed.info ?? {} }
    : null;
const tokenAmount = (info: Record<string, any>): bigint => BigInt(info.tokenAmount?.amount ?? info.amount ?? 0);

/** Outer instructions, each with its inner (CPI) instructions. */
function instructionsOf(tx: ParsedTransactionWithMeta): Array<{ ix: AnyIx; inner: AnyIx[] }> {
  const inner = new Map<number, AnyIx[]>();
  for (const group of tx.meta?.innerInstructions ?? []) inner.set(group.index, group.instructions as AnyIx[]);
  return tx.transaction.message.instructions.map((ix, i) => ({ ix: ix as AnyIx, inner: inner.get(i) ?? [] }));
}
const signers = (tx: ParsedTransactionWithMeta): Set<string> =>
  new Set(tx.transaction.message.accountKeys.filter((k) => k.signer).map((k) => k.pubkey.toBase58()));
function memoText(tx: ParsedTransactionWithMeta): string | null {
  for (const { ix } of instructionsOf(tx)) {
    if (ix.programId.equals(MEMO_PROGRAM_ID) && parsed(ix) && typeof ix.parsed === 'string') return ix.parsed;
  }
  return null;
}

export interface StakeFundRecord {
  signature: string;
  blockTime: number | null;
  memo: StakeFundMemo;
}

/**
 * A fund to the aSOL staking pool, signed by the staking admin, whose memo
 * matches the instruction it rides with. Anyone can write a memo on a claim;
 * only the admin can sign a fund, so a memo without one is ignored.
 */
export function readStakeFundRecord(signature: string, tx: ParsedTransactionWithMeta | null, admin = ASOL_STAKE_ADMIN): StakeFundRecord | null {
  if (!tx || tx.meta?.err || !signers(tx).has(admin.toBase58())) return null;
  const memo = parseStakeFundMemo(memoText(tx));
  if (!memo) return null;
  const funds = instructionsOf(tx)
    .filter(({ ix }) => ix.programId.equals(ASOL_STAKE_PROGRAM_ID))
    .map(({ ix }) => { const d = dataOf(ix); return d ? decodeFundAsolStakingData(d) : null; })
    .filter((f) => f !== null);
  if (funds.length !== 1 || funds[0]!.amount !== memo.amount || funds[0]!.durationSeconds !== memo.seconds) return null;
  return { signature, blockTime: tx.blockTime ?? null, memo };
}

export interface HolderFeeEvent {
  signature: string;
  blockTime: number | null;
  /** aSOL the fee destination received from insurance + holder buckets. */
  bucketCollected: bigint;
  /** The holders' part of it, floored per collect. */
  holdersAccrued: bigint;
  /** aSOL that left the fee destination in a recorded routing to stakers. */
  routedAsol: bigint;
  routing: StakeFundRecord | null;
}

/** What one transaction touching the fee destination's aSOL account did for holders. */
export function readHolderFeeEvent(
  signature: string,
  tx: ParsedTransactionWithMeta | null,
  feeDestination = PERPS_FEE_DESTINATION,
  admin = ASOL_STAKE_ADMIN,
): HolderFeeEvent | null {
  if (!tx || tx.meta?.err) return null;
  const account = asolAccount(feeDestination).toBase58();
  let bucketCollected = 0n;
  let holdersAccrued = 0n;
  let outflow = 0n;
  for (const { ix, inner } of instructionsOf(tx)) {
    const d = ix.programId.equals(PERPS_FEE_PROGRAM_ID) ? dataOf(ix) : null;
    if (d && d.length === 8 && BUCKET_COLLECT.some((disc) => disc.every((b, i) => d[i] === b))) {
      let paid = 0n;
      for (const t of inner.map(tokenInfo)) {
        if (t && (t.type === 'transfer' || t.type === 'transferChecked') && t.info.destination === account) paid += tokenAmount(t.info);
      }
      bucketCollected += paid;
      holdersAccrued += holdersShareOfBucket(paid);
    }
    for (const t of [ix, ...inner].map(tokenInfo)) {
      if (!t) continue;
      if ((t.type === 'burn' || t.type === 'burnChecked') && t.info.account === account) outflow += tokenAmount(t.info);
      if ((t.type === 'transfer' || t.type === 'transferChecked') && t.info.source === account) outflow += tokenAmount(t.info);
    }
  }
  const record = readStakeFundRecord(signature, tx, admin);
  const routing = record && record.memo.kind === 'fees' && signers(tx).has(feeDestination.toBase58()) ? record : null;
  const routedAsol = routing ? outflow : 0n;
  if (bucketCollected === 0n && routedAsol === 0n) return null;
  return { signature, blockTime: tx.blockTime ?? null, bucketCollected, holdersAccrued, routedAsol, routing };
}

export interface HolderFeeLedger {
  accrued: bigint;
  routed: bigint;
  /** accrued - routed, never below zero. */
  owed: bigint;
  collects: number;
  routings: StakeFundRecord[];
}

export function holderFeeLedger(events: HolderFeeEvent[]): HolderFeeLedger {
  let accrued = 0n;
  let routed = 0n;
  let collects = 0;
  const routings: StakeFundRecord[] = [];
  for (const e of events) {
    accrued += e.holdersAccrued;
    routed += e.routedAsol;
    if (e.bucketCollected > 0n) collects++;
    if (e.routing) routings.push(e.routing);
  }
  return { accrued, routed, owed: accrued > routed ? accrued - routed : 0n, collects, routings };
}

/**
 * Signatures for `address`, newest first, up to `maxPages` pages of 1,000.
 * `complete` is false when the history is longer than that.
 */
async function signaturesFor(connection: Connection, address: PublicKey, maxPages: number): Promise<{ sigs: ConfirmedSignatureInfo[]; complete: boolean }> {
  const sigs: ConfirmedSignatureInfo[] = [];
  let before: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const batch = await connection.getSignaturesForAddress(address, { before, limit: 1000 }, 'confirmed');
    sigs.push(...batch);
    if (batch.length < 1000) return { sigs, complete: true };
    before = batch[batch.length - 1]!.signature;
  }
  return { sigs, complete: false };
}

async function parsedTransactions(connection: Connection, signatures: string[]): Promise<Array<ParsedTransactionWithMeta | null>> {
  const out: Array<ParsedTransactionWithMeta | null> = [];
  for (let i = 0; i < signatures.length; i += 25) {
    out.push(...(await connection.getParsedTransactions(signatures.slice(i, i + 25), { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })));
  }
  return out;
}

/** Every holder-fee event in the fee destination's aSOL history, oldest first. */
export async function fetchHolderFeeEvents(
  connection: Connection,
  feeDestination = PERPS_FEE_DESTINATION,
  maxPages = 50,
): Promise<{ events: HolderFeeEvent[]; scanned: number; newest: string | null }> {
  const listed = await signaturesFor(connection, asolAccount(feeDestination), maxPages);
  // A partial history would under-count what was routed, and could pay twice.
  if (!listed.complete) throw new Error(`more than ${maxPages * 1000} transactions on the fee destination's aSOL account; raise maxPages`);
  const sigs = listed.sigs.filter((s) => !s.err);
  const txs = await parsedTransactions(connection, sigs.map((s) => s.signature));
  const events = sigs.map((s, i) => readHolderFeeEvent(s.signature, txs[i] ?? null, feeDestination)).filter((e) => e !== null);
  return { events: events.reverse(), scanned: listed.sigs.length, newest: listed.sigs[0]?.signature ?? null };
}

/**
 * Recorded funds to the staking pool, newest first. Only transactions whose
 * memo mentions a fund are fetched, so this costs one signature listing plus
 * one batch for the handful of funds.
 */
export async function fetchStakeFundRecords(connection: Connection, maxPages = 3): Promise<StakeFundRecord[]> {
  // Claims touch the reward vault too; a history longer than this only drops old funds.
  const { sigs } = await signaturesFor(connection, asolRewardVault(), maxPages);
  const candidates = sigs.filter((s) => !s.err && s.memo?.includes(STAKE_FUND_MEMO_PREFIX)).map((s) => s.signature);
  const txs = await parsedTransactions(connection, candidates);
  return candidates.map((sig, i) => readStakeFundRecord(sig, txs[i] ?? null)).filter((r) => r !== null);
}

// --- planning a fund --------------------------------------------------------------

/**
 * The duration for a routed amount: at least `minSeconds`, and never shorter
 * than what the current budget still has to run. The program streams
 * everything unpaid over the new duration, so a shorter one would spend Aera's
 * budget faster and pull its disclosed end date in.
 */
export function routingDuration(pool: AsolStakePool, now: bigint, minSeconds: bigint): bigint {
  const left = streamSecondsLeft(pool.stream, now);
  let seconds = left > minSeconds ? left : minSeconds;
  if (seconds < BigInt(STREAM_MIN_DURATION)) seconds = BigInt(STREAM_MIN_DURATION);
  if (seconds > BigInt(STREAM_MAX_DURATION)) seconds = BigInt(STREAM_MAX_DURATION);
  return seconds;
}

/**
 * The fee part of what is left to stream at `now`, from the latest record.
 * Everything unpaid streams at one rate, so the fee fraction holds between
 * funds. Null when the pool was funded since without a record (it cannot be
 * split honestly); zero when there is no record at all (only Aera has funded).
 */
export function feeShareOfStream(pool: AsolStakePool, now: bigint, latest: StakeFundRecord | null): { fees: bigint; left: bigint } | null {
  const left = streamRemaining(pool, now);
  if (!latest) return { fees: 0n, left };
  if (latest.memo.funded !== pool.funded) return null;
  const fees = latest.memo.left === 0n ? 0n : (left * latest.memo.feesLeft) / latest.memo.left;
  return { fees, left };
}

/** The memo for a fund about to be sent: what will be left to stream, and how much of it is fees. */
export function planStakeFundMemo(
  pool: AsolStakePool,
  now: bigint,
  kind: StakeFundKind,
  amount: bigint,
  seconds: bigint,
  latest: StakeFundRecord | null,
  asol = 0n,
): StakeFundMemo {
  const before = feeShareOfStream(pool, now, latest);
  const after = streamAfterFund(pool.stream, amount, seconds, now);
  const left = (after.rewardRate * seconds) / STREAM_PRECISION;
  // Unrecorded funds can only be the admin's, so an unknown split counts as Aera's.
  const fees = (before?.fees ?? 0n) + (kind === 'fees' ? amount : 0n);
  return { kind, amount, seconds, asol, left, feesLeft: fees > left ? left : fees, funded: pool.funded + amount };
}

// --- the routing transaction --------------------------------------------------------

/** The two calls of `AeraClient` a redeem needs, so tests can stand in for it. */
export interface RedeemBuilder {
  reserveAddress(liquidityMint: PublicKey): PublicKey;
  accrueIx(reserve: PublicKey): Promise<TransactionInstruction>;
  withdrawIx(owner: PublicKey, liquidityMint: PublicKey, shares: bigint): Promise<TransactionInstruction>;
}

export interface RouteHolderFeesInput {
  /** `redeem`: burn the aSOL for SOL from Aera's reserve. `front`: Aera pays the SOL and takes the aSOL. */
  mode: 'redeem' | 'front';
  asol: bigint;
  /** SOL funded to stakers; at most what the aSOL redeems for. */
  sol: bigint;
  seconds: bigint;
  memo: StakeFundMemo;
  /** COOK lamports the admin sends the fee destination first, for the supply position's rent. */
  topUpLamports?: bigint;
  feeDestination?: PublicKey;
  admin?: PublicKey;
}

export function memoIx(text: string): TransactionInstruction {
  return new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(text, 'utf8') });
}

/**
 * One transaction, signed by the admin (fee payer) and the fee destination:
 *
 *   redeem  create the fee destination's SOL account; top up its rent; accrue;
 *           withdraw `asol` from the SOL reserve to it; transfer `sol` to the
 *           admin; fund the stream with `sol`; memo
 *   front   create the admin's aSOL account; transfer `asol` from the fee
 *           destination to the admin; fund `sol` from the admin's own SOL; memo
 *
 * Redeeming pays out at least the quoted `sol` (the rate only rises between
 * quote and execution), so the transfer never comes up short; a few lamports
 * of excess stay with the fee destination.
 */
export async function routeHolderFeesIxs(client: RedeemBuilder, p: RouteHolderFeesInput): Promise<TransactionInstruction[]> {
  const feeDestination = p.feeDestination ?? PERPS_FEE_DESTINATION;
  const admin = p.admin ?? ASOL_STAKE_ADMIN;
  if (p.asol <= 0n || p.sol <= 0n) throw new Error('route a positive amount');
  if (p.memo.kind !== 'fees' || p.memo.amount !== p.sol || p.memo.seconds !== p.seconds || p.memo.asol !== p.asol) {
    throw new Error('the memo must describe this routing');
  }
  const fund = fundAsolStakingIx(p.sol, p.seconds, admin);
  const memo = memoIx(encodeStakeFundMemo(p.memo));
  if (p.mode === 'front') {
    return [
      createAssociatedTokenAccountIdempotentInstruction(admin, asolAccount(admin), admin, ASOL_MINT, TOKEN_2022_PROGRAM_ID),
      createTransferCheckedInstruction(asolAccount(feeDestination), ASOL_MINT, asolAccount(admin), feeDestination, p.asol, 9, [], TOKEN_2022_PROGRAM_ID),
      fund,
      memo,
    ];
  }
  const reserve = client.reserveAddress(COOKIE_SOL_MINT);
  return [
    createAssociatedTokenAccountIdempotentInstruction(admin, cookieSolAccount(feeDestination), feeDestination, COOKIE_SOL_MINT, TOKEN_2022_PROGRAM_ID),
    ...(p.topUpLamports && p.topUpLamports > 0n ? [SystemProgram.transfer({ fromPubkey: admin, toPubkey: feeDestination, lamports: p.topUpLamports })] : []),
    await client.accrueIx(reserve),
    await client.withdrawIx(feeDestination, COOKIE_SOL_MINT, p.asol),
    createTransferCheckedInstruction(cookieSolAccount(feeDestination), COOKIE_SOL_MINT, cookieSolAccount(admin), feeDestination, p.sol, 9, [], TOKEN_2022_PROGRAM_ID),
    fund,
    memo,
  ];
}

// --- the yield, split by source -------------------------------------------------------

export interface AsolStakingYield {
  /** aSOL's own lending rate (APR, a fraction), earned whether staked or not. */
  lendingApr: number;
  /** Perps holder fees routed to stakers over the trailing window, annualized on today's stake. */
  feeApr: number | null;
  /** The part of today's stream paid from budgets Aera funded. */
  aeraApr: number | null;
  /** The sum of the three; null while nobody is staked. */
  totalApr: number | null;
  feesRouted: bigint;
  windowSeconds: bigint;
  /** SOL left to stream, split by where it came from. */
  aeraSolLeft: bigint;
  feeSolLeft: bigint;
  /** When the stream runs out at today's pace; null while nobody is staked or nothing is left. */
  endsAt: bigint | null;
  /** False when the pool was funded without a record, so all of the stream is shown as Aera's. */
  splitKnown: boolean;
}

/**
 * aSOL staking's return, by source. Every part is variable: lending moves with
 * utilization, the fee share with perps volume, and Aera's budget ends.
 */
export function asolStakingYield(input: {
  pool: AsolStakePool;
  now: bigint;
  /** aSOL's value in SOL, scaled by 1e9. */
  asolPerSolE9: bigint;
  supplyAprBps: number;
  /** Newest first, as `fetchStakeFundRecords` returns them. */
  records: StakeFundRecord[];
  windowSeconds?: bigint;
}): AsolStakingYield {
  const { pool, now, asolPerSolE9, records } = input;
  const windowSeconds = input.windowSeconds ?? 30n * 86_400n;
  const lendingApr = input.supplyAprBps / 10_000;
  const feesRouted = records
    .filter((r) => r.memo.kind === 'fees' && r.blockTime !== null && BigInt(r.blockTime) >= now - windowSeconds)
    .reduce((sum, r) => sum + r.memo.amount, 0n);
  const stakedSol = (pool.stream.totalStaked * asolPerSolE9) / 1_000_000_000n;
  const split = feeShareOfStream(pool, now, records[0] ?? null);
  // Unsplittable: the whole stream is shown as Aera's and no fee share is
  // claimed, so nothing is counted twice and nothing subsidised looks earned.
  const feeApr = stakedSol === 0n || !split ? null : Number((feesRouted * SECONDS_PER_YEAR * 1_000_000n) / windowSeconds / stakedSol) / 1_000_000;
  const left = streamRemaining(pool, now);
  const feeSolLeft = split?.fees ?? 0n;
  const stream = rewardApr(pool, now, asolPerSolE9);
  const aeraApr = stream === null ? null : left === 0n ? 0 : (stream * Number(((left - feeSolLeft) * 1_000_000n) / left)) / 1_000_000;
  const running = pool.stream.totalStaked > 0n && left > 0n;
  return {
    lendingApr,
    feeApr,
    aeraApr,
    totalApr: stakedSol === 0n ? null : lendingApr + (feeApr ?? 0) + (aeraApr ?? 0),
    feesRouted,
    windowSeconds,
    aeraSolLeft: left - feeSolLeft,
    feeSolLeft,
    endsAt: running ? pool.stream.periodFinish : null,
    splitKnown: split !== null,
  };
}
