/**
 * Relayed stake-pool rates: the `rate_receiver` feed Aera's `RelayedRate`
 * oracle reads.
 *
 * JitoSOL's backing lives in Jito's stake pool on Solana, where Aera cannot
 * read. `rate_sender` reads the pool there and dispatches its figures over
 * Hyperlane; `rate_receiver` stores them on Cookie Chain in one feed account
 * per pool. This module decodes that account, for keepers and the app.
 *
 * Nothing here is trusted by the program: Aera parses the same bytes itself in
 * `oracle/relayed_rate.rs`, and this decoder exists only so off-chain code can
 * see what the program will see.
 */

import { PublicKey } from '@solana/web3.js';

/**
 * Oldest a relayed rate may be, from the sender's read on Solana, before new
 * borrowing against it freezes. Mirrors `MAX_RELAYED_RATE_AGE_SECONDS`.
 */
export const MAX_RELAYED_RATE_AGE_SECONDS = 3 * 24 * 60 * 60;

/** `sha256("account:RelayedRate")[..8]`. */
export const RELAYED_RATE_DISCRIMINATOR = Uint8Array.from([119, 32, 232, 10, 165, 124, 207, 54]);

/** The account's exact length; anything else is not a feed. */
export const RELAYED_RATE_LEN = 189;

/** One stake pool's books, as last relayed. */
export interface RelayedRateAccount {
  /** The stake pool on the origin chain. */
  stakePool: PublicKey;
  /** The pool's token on the origin chain (JitoSOL on Solana, not on Cookie). */
  poolMint: PublicKey;
  tokenProgram: PublicKey;
  totalLamports: bigint;
  poolTokenSupply: bigint;
  /** The origin pool's epoch — Solana's — which the breaker counts in. */
  lastUpdateEpoch: bigint;
  stakeWithdrawalFeeBps: number;
  solWithdrawalFeeBps: number;
  lastEpochTotalLamports: bigint;
  lastEpochPoolTokenSupply: bigint;
  /** When the sender read the pool, on Solana's clock. */
  sourceSlot: bigint;
  sourceUnixTimestamp: bigint;
  /** When the receiver stored it, on Cookie's clock. */
  receivedSlot: bigint;
  receivedUnixTimestamp: bigint;
  /** Deliveries accepted. Zero means never written, which Aera treats as no price. */
  updates: bigint;
}

/**
 * Decode a feed. Throws on anything that is not exactly a `RelayedRate`:
 * the program would refuse it, so a caller should not reason from it.
 */
export function decodeRelayedRate(data: Uint8Array): RelayedRateAccount {
  if (data.length !== RELAYED_RATE_LEN) {
    throw new Error(`a RelayedRate is ${RELAYED_RATE_LEN} bytes, got ${data.length}`);
  }
  for (let i = 0; i < 8; i += 1) {
    if (data[i] !== RELAYED_RATE_DISCRIMINATOR[i]) throw new Error('not a RelayedRate account');
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const key = (at: number) => new PublicKey(data.subarray(at, at + 32));
  const u64 = (at: number) => view.getBigUint64(at, true);
  const i64 = (at: number) => view.getBigInt64(at, true);
  const u16 = (at: number) => view.getUint16(at, true);

  return {
    stakePool: key(8),
    poolMint: key(40),
    tokenProgram: key(72),
    totalLamports: u64(104),
    poolTokenSupply: u64(112),
    lastUpdateEpoch: u64(120),
    stakeWithdrawalFeeBps: u16(128),
    solWithdrawalFeeBps: u16(130),
    lastEpochTotalLamports: u64(132),
    lastEpochPoolTokenSupply: u64(140),
    sourceSlot: u64(148),
    sourceUnixTimestamp: i64(156),
    receivedSlot: u64(164),
    receivedUnixTimestamp: i64(172),
    updates: u64(180),
  };
}

/** Seconds since the sender read the pool. Never negative, as on chain. */
export function relayAgeSeconds(feed: RelayedRateAccount, nowUnixSeconds: number): number {
  return Math.max(0, nowUnixSeconds - Number(feed.sourceUnixTimestamp));
}

/** Whether Aera would freeze new borrowing for this feed's age right now. */
export function isRelayStale(feed: RelayedRateAccount, nowUnixSeconds: number): boolean {
  return relayAgeSeconds(feed, nowUnixSeconds) > MAX_RELAYED_RATE_AGE_SECONDS;
}
