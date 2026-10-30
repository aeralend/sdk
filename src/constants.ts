import { PublicKey } from '@solana/web3.js';

import idl from '../idl/aera.json' with { type: 'json' };
import { readEnvOr } from './env.js';

/** The deployed program. Kept in sync with `declare_id!` via the IDL. */
export const AERA_PROGRAM_ID = new PublicKey(idl.address);

/**
 * Cookie infrastructure. These three endpoints are the only ones the protocol,
 * the apps and the keepers ever talk to.
 *
 * Each is overridable by environment variable so a local validator or a staging
 * host can be pointed at, but the defaults are Cookie's own and nothing else is
 * ever reached for — no Helius, no Triton, no Solana mainnet.
 *
 * Genesis 9wDaBRDgArEUpvhHxGguNkwozsZh4UpGZB9o2EoEcBB2, solana-core 4.1.2.
 */

/** JSON-RPC: chain reads, simulation, sending. Does **not** serve DAS. */
export const COOKIE_RPC_URL = readEnvOr('AERA_RPC_URL', 'https://rpc.cookiescan.io');

/** Subscriptions. Verified: `slotSubscribe` and account notifications both work. */
export const COOKIE_WS_URL = readEnvOr('AERA_WS_URL', 'wss://rpc.cookiescan.io');

/**
 * DAS: asset and token metadata. A separate service from the RPC — `getAsset`
 * is served here and returns "Method not found" on the RPC, and `getHealth` is
 * served on the RPC and returns "Method not found" here.
 */
export const COOKIE_API_URL = readEnvOr('AERA_API_URL', 'https://api.cookiescan.io');

export const COOKIE_EXPLORER_URL = readEnvOr('AERA_EXPLORER_URL', 'https://cookiescan.io');

/** Every ratio in the program is an integer scaled by this. */
export const FIXED_POINT_SCALE = 1_000_000_000_000_000_000n;

/** 100% in basis points. */
export const BPS = 10_000n;

/** COOK and bCOOK both use 9 decimals. */
export const COOK_DECIMALS = 9;

/**
 * PDA seeds, byte-identical to constants.rs.
 *
 * `TextEncoder`, not `Buffer`: `Buffer` is a Node global, and reaching for it
 * at module scope makes the whole SDK throw on import in a browser — the page
 * renders blank with "Buffer is not defined" long before any RPC call. The
 * seeds are ASCII, so UTF-8 encoding is byte-for-byte what the program expects.
 */
const seed = (text: string): Uint8Array => new TextEncoder().encode(text);

export const SEED = {
  global: seed('global'),
  market: seed('market'),
  oracle: seed('oracle'),
  reserve: seed('reserve'),
  liquidityVault: seed('liquidity_vault'),
  shareMint: seed('share_mint'),
  obligation: seed('obligation'),
  obligationShareVault: seed('obligation_share_vault'),
  supplyPosition: seed('supply_position'),
  marketOracle: seed('market_oracle'),
  riskConfig: seed('risk_config'),
} as const;

/**
 * Health-factor presentation bands, shared by both apps so a position never
 * looks safe on one screen and at risk on another.
 *
 * These are display thresholds only. The protocol's single hard line is
 * `liquidatable` — at HF below 1.0 anyone may close the position.
 */
export const HF_BAND = {
  /** At or below 1.0, collateral can be seized. */
  liquidatable: 1.0,
  /** Below this, render in --bad. */
  bad: 1.1,
  /** Below this (and at or above `bad`), render in --warn. At or above, --good. */
  warn: 1.5,
} as const;
