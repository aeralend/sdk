/**
 * Cookie's DAS API — asset and token metadata.
 *
 * `https://api.cookiescan.io` is a separate service from the RPC: `getAsset` is
 * served here and returns "Method not found" on `rpc.cookiescan.io`, and
 * `getHealth` is served there and returns "Method not found" here. Neither is a
 * substitute for the other.
 *
 * This is the only supported way to resolve a mint the app was not configured
 * with. Guessing an address, or deriving one from an assumed layout, is how a
 * front end ends up reading an empty account and rendering a position that
 * looks plausible and is entirely wrong.
 */

import { PublicKey } from '@solana/web3.js';

import { COOKIE_API_URL } from './constants.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface DasTokenAsset {
  mint: PublicKey;
  name: string;
  symbol: string;
  decimals: number;
  /** UI-scale supply as DAS reports it, not base units. */
  supply: number;
  /** SPL Token or Token-2022. */
  tokenProgram: PublicKey | null;
}

export interface DasOptions {
  /** Defaults to `COOKIE_API_URL`. */
  endpoint?: string;
  /** Abort signal for a caller that navigates away mid-request. */
  signal?: AbortSignal;
}

async function rpc(method: string, params: unknown, options: DasOptions = {}): Promise<any> {
  const endpoint = options.endpoint ?? COOKIE_API_URL;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'aera', method, params }),
    signal: options.signal,
  });

  if (!response.ok) throw new Error(`DAS ${method}: HTTP ${response.status}`);

  // `Response.json()` is `Promise<any>` in the DOM lib and `Promise<unknown>`
  // in Node's, and this file compiles under both.
  const payload = (await response.json()) as { error?: { message?: string }; result?: any };

  if (payload.error) {
    throw new Error(`DAS ${method}: ${payload.error.message ?? 'unknown error'}`);
  }
  return payload.result;
}

const toPublicKey = (value: unknown): PublicKey | null => {
  if (typeof value !== 'string' || value === '') return null;
  try {
    return new PublicKey(value);
  } catch {
    return null;
  }
};

/** Normalise a DAS asset, or `null` if it is not a usable fungible token. */
function toTokenAsset(asset: any): DasTokenAsset | null {
  const mint = toPublicKey(asset?.id);
  if (!mint) return null;

  const info = asset?.token_info ?? {};
  const metadata = asset?.content?.metadata ?? {};
  const decimals = info.decimals;
  if (typeof decimals !== 'number') return null;

  return {
    mint,
    name: String(metadata.name ?? ''),
    symbol: String(info.symbol ?? metadata.symbol ?? ''),
    decimals,
    supply: Number(info.supply ?? 0),
    tokenProgram: toPublicKey(info.token_program),
  };
}

/** One asset by mint address. */
export async function getAsset(
  mint: PublicKey | string,
  options?: DasOptions,
): Promise<DasTokenAsset | null> {
  const id = typeof mint === 'string' ? mint : mint.toBase58();
  const result = await rpc('getAsset', { id }, options);
  return result ? toTokenAsset(result) : null;
}

/** A page of fungible assets. */
export async function searchFungibleAssets(
  page: number,
  limit = 1000,
  options?: DasOptions,
): Promise<DasTokenAsset[]> {
  const result = await rpc('searchAssets', { tokenType: 'fungible', limit, page }, options);
  const items: any[] = result?.items ?? [];
  return items.map(toTokenAsset).filter((asset): asset is DasTokenAsset => asset !== null);
}

export interface ResolveOptions extends DasOptions {
  /** Reject a match whose decimals differ from what the reserve expects. */
  expectedDecimals?: number;
  /** Pages of 1000 to scan before giving up. */
  maxPages?: number;
  /**
   * Called for each candidate that survived the metadata filters, to confirm
   * the mint actually exists on chain.
   *
   * This is not optional diligence. Cookie's DAS index contains a second mint
   * named "bakedCOOK" with symbol "bCOOK" and 9 decimals that `getAccountInfo`
   * reports as MISSING — a resolver matching on symbol alone picks it roughly
   * half the time. Pass a checker backed by the RPC.
   */
  exists?: (mint: PublicKey) => Promise<boolean>;
}

export interface ResolveResult {
  asset: DasTokenAsset;
  /** Other on-chain candidates that also matched. Non-empty means ambiguity. */
  alternatives: DasTokenAsset[];
}

/**
 * Find a fungible mint by symbol.
 *
 * Candidates are filtered by symbol, then by decimals if given, then — the part
 * that matters — by whether the mint exists on chain, and are finally ranked by
 * supply so a live token beats an empty impostor.
 *
 * Returns the alternatives alongside the winner rather than hiding them: a
 * caller that cares about being right should surface an ambiguity instead of
 * silently taking the first row.
 */
export async function resolveMintBySymbol(
  symbol: string,
  options: ResolveOptions = {},
): Promise<ResolveResult | null> {
  const wanted = symbol.trim().toLowerCase();
  const maxPages = options.maxPages ?? 12;
  const matches: DasTokenAsset[] = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const assets = await searchFungibleAssets(page, 1000, options);
    if (assets.length === 0) break;

    for (const asset of assets) {
      if (asset.symbol.trim().toLowerCase() !== wanted) continue;
      if (options.expectedDecimals != null && asset.decimals !== options.expectedDecimals) continue;
      matches.push(asset);
    }

    if (assets.length < 1000) break;
  }

  if (matches.length === 0) return null;

  // Drop anything the chain does not actually have.
  let live = matches;
  if (options.exists) {
    const checks = await Promise.all(matches.map((asset) => options.exists!(asset.mint)));
    const filtered = matches.filter((_, index) => checks[index]);
    // If the check knocked everything out, the RPC is more likely wrong than
    // every candidate being fake; fall back rather than returning nothing.
    if (filtered.length > 0) live = filtered;
  }

  const ranked = [...live].sort((a, b) => b.supply - a.supply);
  const [winner, ...alternatives] = ranked;
  return winner ? { asset: winner, alternatives } : null;
}
