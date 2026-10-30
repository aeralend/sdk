/**
 * Bridge SOL from Solana mainnet to Cookie Chain.
 *
 * The route is the Cookie team's own Hyperlane warp route (it is not in
 * Hyperlane's public registry). On Solana a native-SOL warp program locks the
 * lamports in its collateral PDA and dispatches a message through the Solana
 * mailbox; the Cookie team's relayer delivers it to the Cookie mailbox, and the
 * synthetic warp mints the same amount of bridged SOL (Token-2022, 9 decimals)
 * to the recipient's associated token account.
 *
 * Everything here is pure or read-only. Building a transaction never signs for
 * the user and never sends: the caller's wallet signs on Solana, and the
 * caller sends.
 *
 * Sources the layout was taken from, and checked against on 2026-10-13:
 *   - cookiechain/cookie-mcp `src/core/bridge.ts` and `bridgeRoutes.ts` (the
 *     team's own transfer_remote builder and HyperlaneToken parser);
 *   - hyperlane-xyz/hyperlane-monorepo `rust/sealevel` (instruction enum,
 *     `transfer_remote` account list, mailbox PDA seeds);
 *   - Solana mainnet and Cookie Chain, read only: every pinned account below
 *     was derived from its seeds and found on chain, and a transfer built by
 *     `solToCookieTransferIx` was simulated (signature verification off,
 *     nothing sent) and dispatched. See docs/BRIDGE.md.
 */

import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type AccountMeta,
  type Connection,
  type Keypair,
} from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

const pk = (value: string) => new PublicKey(value);

/**
 * The SOL warp route, both sides. The IGP accounts are what the Solana warp's
 * HyperlaneToken account names (an overhead IGP wrapping an IGP); the PDAs are
 * derived below and pinned by the tests.
 */
export const SOL_COOKIE_BRIDGE = {
  solana: {
    domain: 1399811149,
    genesis: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    /** Native SOL warp program (collateral: lamports locked in its PDA). */
    warp: pk('DWxkDF63gF5pMoAiACjkkYgr4onz4WPZi9wq59gctU6T'),
    mailbox: pk('E588QtVUvresuXq2KoNEwAmoifCzYGpRBdHByN9KQMbi'),
    igpProgram: pk('BhNcatUDC2D5JTyeaqrdSukiVFsEHK7e3hVmKMztwefv'),
    overheadIgp: pk('Dg5FAhqNaRfQPc3HwW9fXr7Bj4nrnszoQspoSLgysqfY'),
    igp: pk('3RbtjzzdhmthkQ1akmbe41SbGXS3e96AqupPt6VtxHEe'),
    explorer: 'https://solscan.io',
  },
  cookie: {
    domain: 420042004,
    genesis: '9wDaBRDgArEUpvhHxGguNkwozsZh4UpGZB9o2EoEcBB2',
    /** Synthetic warp program: mints bridged SOL on delivery, burns it on the way back. */
    warp: pk('E9zKioziEnQkc3v4pU9zVmVHi9dg6gKoD2qSnzY5sASi'),
    mailbox: pk('DhiHgUY8Y6mJ4D3MoRnZWAjTBEtSaFFn4CYgc6eDzZ8r'),
    /** Bridged SOL on Cookie Chain: Token-2022, 9 decimals, mint authority the warp. */
    mint: pk('6tL24Fn75uCMrBSZAvohAq57LSv6KrY6ceEq1wonvucb'),
    explorer: 'https://cookiescan.io',
  },
  decimals: 9,
} as const;

export const SPL_NOOP_PROGRAM_ID = pk('noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV');

/**
 * Smallest transfer the app offers. Relay cost is per message, not per amount,
 * and the Cookie team's own tooling refuses anything worth less than 15,000 COOK
 * (about 0.008 SOL in October 2026). 0.01 SOL clears it with room.
 */
export const BRIDGE_MIN_LAMPORTS = 10_000_000n;

/**
 * Largest transfer the app offers: the soft cap the Cookie team's bridge UI
 * applies (`SOL_MAX_ESCROW_SOL=50`). The program has no cap of its own in this
 * direction; this is a prudence limit, not a protocol one.
 */
export const BRIDGE_MAX_LAMPORTS = 50_000_000_000n;

/**
 * Compute for the bridge transaction. A simulated transfer used 147,421 units
 * on 2026-10-13 (dispatch with its Merkle insert, the gas payment, the
 * collateral transfer); this leaves headroom without pricing a priority fee on
 * the million units the team's tooling asks for.
 */
export const BRIDGE_COMPUTE_UNITS = 250_000;

// ---------------------------------------------------------------------------
// PDAs (seeds joined by a literal '-', as the Sealevel programs spell them)
// ---------------------------------------------------------------------------

const SEP = Buffer.from('-');
function pda(programId: PublicKey, ...parts: (string | Uint8Array)[]): PublicKey {
  const seeds: Buffer[] = [];
  parts.forEach((part, i) => {
    if (i > 0) seeds.push(SEP);
    seeds.push(typeof part === 'string' ? Buffer.from(part, 'utf8') : Buffer.from(part));
  });
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

/** A warp program's HyperlaneToken account (stored at its handle account-metas PDA). */
export const hyperlaneTokenPda = (warp: PublicKey) => pda(warp, 'hyperlane_message_recipient', 'handle', 'account_metas');
/** Where a native warp holds the locked lamports. */
export const nativeCollateralPda = (warp: PublicKey) => pda(warp, 'hyperlane_token', 'native_collateral');
/** A synthetic warp's mint. */
export const syntheticMintPda = (warp: PublicKey) => pda(warp, 'hyperlane_token', 'mint');
/** What a synthetic warp pays a new recipient's token account rent from. */
export const ataPayerPda = (warp: PublicKey) => pda(warp, 'hyperlane_token', 'ata_payer');
export const dispatchAuthorityPda = (warp: PublicKey) => pda(warp, 'hyperlane_dispatcher', 'dispatch_authority');
export const mailboxOutboxPda = (mailbox: PublicKey) => pda(mailbox, 'hyperlane', 'outbox');
/** Holds a dispatched message; keyed by the transaction's one-off unique-message signer. */
export const dispatchedMessagePda = (mailbox: PublicKey, uniqueMessage: PublicKey) =>
  pda(mailbox, 'hyperlane', 'dispatched_message', uniqueMessage.toBytes());
export const igpProgramDataPda = (igpProgram: PublicKey) => pda(igpProgram, 'hyperlane_igp', 'program_data');
export const gasPaymentPda = (igpProgram: PublicKey, uniqueMessage: PublicKey) =>
  pda(igpProgram, 'hyperlane_igp', 'gas_payment', uniqueMessage.toBytes());
/** Exists on the destination mailbox once a message has been delivered. */
export const processedMessagePda = (mailbox: PublicKey, messageId: string | Uint8Array) =>
  pda(mailbox, 'hyperlane', 'processed_message', messageIdBytes(messageId));

/** The recipient's bridged-SOL account on Cookie Chain, where a delivery lands. */
export const bridgedSolAta = (owner: PublicKey) =>
  getAssociatedTokenAddressSync(SOL_COOKIE_BRIDGE.cookie.mint, owner, true, TOKEN_2022_PROGRAM_ID);

// ---------------------------------------------------------------------------
// The instruction
// ---------------------------------------------------------------------------

/** Hyperlane Sealevel's program-instruction discriminator: eight 1 bytes. */
const DISCRIMINATOR = Buffer.alloc(8, 1);
/** `Instruction::TransferRemote` in the token library's borsh enum. */
const TRANSFER_REMOTE = 1;
export const TRANSFER_REMOTE_DATA_LEN = 8 + 1 + 4 + 32 + 32;

/**
 * `TransferRemote { destination_domain: u32, recipient: H256, amount_or_id: U256 }`,
 * borsh, after the discriminator and the enum tag: 77 bytes, all little-endian.
 */
export function encodeTransferRemote(destinationDomain: number, recipient: PublicKey, amount: bigint): Buffer {
  if (!Number.isInteger(destinationDomain) || destinationDomain < 0 || destinationDomain > 0xffffffff) throw Error('Invalid destination domain');
  if (amount <= 0n || amount >= 1n << 64n) throw Error('Invalid bridge amount');
  const data = Buffer.alloc(TRANSFER_REMOTE_DATA_LEN);
  DISCRIMINATOR.copy(data, 0);
  data.writeUInt8(TRANSFER_REMOTE, 8);
  data.writeUInt32LE(destinationDomain, 9);
  recipient.toBuffer().copy(data, 13);
  data.writeBigUInt64LE(amount, 45); // the upper 24 bytes of the U256 stay zero
  return data;
}

/** The inverse, for checking a transaction before it is signed. */
export function decodeTransferRemote(data: Uint8Array): { destinationDomain: number; recipient: PublicKey; amount: bigint } {
  const buf = Buffer.from(data);
  if (buf.length !== TRANSFER_REMOTE_DATA_LEN || !buf.subarray(0, 8).equals(DISCRIMINATOR) || buf[8] !== TRANSFER_REMOTE) {
    throw Error('Not a TransferRemote instruction');
  }
  if (buf.subarray(53).some((byte) => byte !== 0)) throw Error('Bridge amount exceeds u64');
  return { destinationDomain: buf.readUInt32LE(9), recipient: new PublicKey(buf.subarray(13, 45)), amount: buf.readBigUInt64LE(45) };
}

const meta = (pubkey: PublicKey, isWritable: boolean, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable });

/**
 * `transfer_remote` on the Solana native-SOL warp, sending `lamports` to
 * `recipient` on Cookie Chain (the sender's own address unless given).
 *
 * Accounts, in the order the token library reads them:
 *   0 system program · 1 SPL noop · 2 token PDA · 3 mailbox · 4 outbox (w)
 *   · 5 dispatch authority · 6 sender (s) · 7 unique message (s)
 *   · 8 dispatched message PDA (w)
 *   · 9 IGP program · 10 IGP program data (w) · 11 gas payment PDA (w)
 *   · 12 overhead IGP · 13 IGP (w)
 *   · 14 system program · 15 native collateral PDA (w)   (native plugin)
 */
export function solToCookieTransferIx(args: {
  sender: PublicKey;
  uniqueMessage: PublicKey;
  lamports: bigint;
  recipient?: PublicKey;
}): TransactionInstruction {
  const { solana, cookie } = SOL_COOKIE_BRIDGE;
  const recipient = args.recipient ?? args.sender;
  if (args.uniqueMessage.equals(args.sender)) throw Error('The unique message account must be a fresh keypair');
  return new TransactionInstruction({
    programId: solana.warp,
    keys: [
      meta(SystemProgram.programId, false),
      meta(SPL_NOOP_PROGRAM_ID, false),
      meta(hyperlaneTokenPda(solana.warp), false),
      meta(solana.mailbox, false),
      meta(mailboxOutboxPda(solana.mailbox), true),
      meta(dispatchAuthorityPda(solana.warp), false),
      meta(args.sender, true, true),
      meta(args.uniqueMessage, false, true),
      meta(dispatchedMessagePda(solana.mailbox, args.uniqueMessage), true),
      meta(solana.igpProgram, false),
      meta(igpProgramDataPda(solana.igpProgram), true),
      meta(gasPaymentPda(solana.igpProgram, args.uniqueMessage), true),
      meta(solana.overheadIgp, false),
      meta(solana.igp, true),
      meta(SystemProgram.programId, false),
      meta(nativeCollateralPda(solana.warp), true),
    ],
    data: encodeTransferRemote(cookie.domain, recipient, args.lamports),
  });
}

/** Why an amount cannot be bridged, or null. */
export function bridgeAmountProblem(lamports: bigint): string | null {
  if (lamports < BRIDGE_MIN_LAMPORTS) return `The minimum is ${formatLamports(BRIDGE_MIN_LAMPORTS)} SOL.`;
  if (lamports > BRIDGE_MAX_LAMPORTS) return `The maximum per transfer is ${formatLamports(BRIDGE_MAX_LAMPORTS)} SOL.`;
  return null;
}

/**
 * The whole Solana transaction: a compute limit, an optional priority fee and
 * the transfer, partially signed by the one-off unique-message keypair. The
 * wallet adds the sender's signature; nothing here sends.
 */
export function buildSolToCookieTransaction(args: {
  sender: PublicKey;
  lamports: bigint;
  uniqueMessage: Keypair;
  recentBlockhash: string;
  lastValidBlockHeight?: number;
  recipient?: PublicKey;
  /** Priority fee, in micro-lamports per compute unit. 0 adds no instruction. */
  microLamportsPerUnit?: number;
}): Transaction {
  const problem = bridgeAmountProblem(args.lamports);
  if (problem) throw Error(problem);
  const tx = new Transaction({
    feePayer: args.sender,
    blockhash: args.recentBlockhash,
    lastValidBlockHeight: args.lastValidBlockHeight ?? 0,
  });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: BRIDGE_COMPUTE_UNITS }));
  const price = args.microLamportsPerUnit ?? 0;
  if (price > 0) tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.min(Math.floor(price), 5_000_000) }));
  tx.add(solToCookieTransferIx({ sender: args.sender, uniqueMessage: args.uniqueMessage.publicKey, lamports: args.lamports, recipient: args.recipient }));
  tx.partialSign(args.uniqueMessage);
  return tx;
}

/**
 * Checks a transaction about to be handed to (or returned by) a wallet: one
 * transfer to the pinned warp, to the intended recipient, for the intended
 * amount, with exactly the accounts `solToCookieTransferIx` produces.
 */
export function assertSolToCookieTransaction(tx: Transaction, expected: { sender: PublicKey; recipient: PublicKey; lamports: bigint; uniqueMessage: PublicKey }): void {
  if (!tx.feePayer?.equals(expected.sender)) throw Error('Bridge fee payer mismatch');
  const transfers = tx.instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId));
  if (transfers.length !== 1) throw Error('Unexpected instructions in the bridge transaction');
  const ix = transfers[0]!;
  const want = solToCookieTransferIx({ sender: expected.sender, uniqueMessage: expected.uniqueMessage, lamports: expected.lamports, recipient: expected.recipient });
  if (!ix.programId.equals(want.programId) || !Buffer.from(ix.data).equals(want.data)) throw Error('Bridge amount, route or recipient mismatch');
  if (ix.keys.length !== want.keys.length || ix.keys.some((key, i) => !key.pubkey.equals(want.keys[i]!.pubkey) || key.isSigner !== want.keys[i]!.isSigner)) {
    throw Error('Bridge account mismatch');
  }
}

// ---------------------------------------------------------------------------
// The warp's on-chain configuration
// ---------------------------------------------------------------------------

export type IgpKind = 'igp' | 'overheadIgp';

export interface HyperlaneTokenConfig {
  mailbox: PublicKey;
  decimals: number;
  remoteDecimals: number;
  owner: PublicKey | null;
  ism: PublicKey | null;
  igp: { program: PublicKey; kind: IgpKind; account: PublicKey } | null;
  destinationGas: Map<number, bigint>;
  remoteRouters: Map<number, PublicKey>;
  plugin: { type: 'native' } | { type: 'synthetic'; mint: PublicKey } | { type: 'collateral'; tokenProgram: PublicKey; mint: PublicKey; escrow: PublicKey };
}

/**
 * Decode a HyperlaneToken account: initialized u8 · bump u8 · mailbox
 * · mailbox_process_authority · dispatch_authority_bump u8 · decimals u8
 * · remote_decimals u8 · owner Option<Pubkey> · ism Option<Pubkey>
 * · igp Option<(Pubkey, enum { Igp(Pubkey), OverheadIgp(Pubkey) })>
 * · destination_gas HashMap<u32,u64> · remote_routers HashMap<u32,H256>
 * · plugin data (native 1 byte; synthetic 34; collateral 98).
 */
export function decodeHyperlaneToken(data: Uint8Array): HyperlaneTokenConfig {
  const buf = Buffer.from(data);
  let off = 0;
  const need = (n: number) => { if (off + n > buf.length) throw Error('HyperlaneToken account is truncated'); };
  const u8 = () => { need(1); return buf.readUInt8(off++); };
  const u32 = () => { need(4); const v = buf.readUInt32LE(off); off += 4; return v; };
  const u64 = () => { need(8); const v = buf.readBigUInt64LE(off); off += 8; return v; };
  const key = () => { need(32); const v = new PublicKey(buf.subarray(off, off + 32)); off += 32; return v; };
  const option = <T>(read: () => T): T | null => {
    const tag = u8();
    if (tag === 0) return null;
    if (tag !== 1) throw Error(`Bad Option tag ${tag}`);
    return read();
  };
  if (u8() !== 1) throw Error('HyperlaneToken account is not initialized');
  u8(); // bump
  const mailbox = key();
  key(); // mailbox process authority
  u8(); // dispatch authority bump
  const decimals = u8();
  const remoteDecimals = u8();
  const owner = option(key);
  const ism = option(key);
  const igp = option(() => {
    const program = key();
    const tag = u8();
    if (tag > 1) throw Error(`Unknown IGP type ${tag}`);
    return { program, kind: (tag === 0 ? 'igp' : 'overheadIgp') as IgpKind, account: key() };
  });
  const destinationGas = new Map<number, bigint>();
  for (let i = 0, n = u32(); i < n; i++) destinationGas.set(u32(), u64());
  const remoteRouters = new Map<number, PublicKey>();
  for (let i = 0, n = u32(); i < n; i++) remoteRouters.set(u32(), key());
  const rest = buf.length - off;
  let plugin: HyperlaneTokenConfig['plugin'];
  if (rest === 1) plugin = { type: 'native' };
  else if (rest === 34) plugin = { type: 'synthetic', mint: key() };
  else if (rest === 98) plugin = { type: 'collateral', tokenProgram: key(), mint: key(), escrow: key() };
  else throw Error(`Unrecognised warp plugin data (${rest} bytes)`);
  return { mailbox, decimals, remoteDecimals, owner, ism, igp, destinationGas, remoteRouters, plugin };
}

/**
 * What differs between the Solana warp's live configuration and the route
 * pinned here. Empty means the transaction built here is the one the program
 * expects. A non-empty list means the Cookie team changed the route, and
 * nothing should be signed until this module is updated.
 */
export function solanaWarpConfigProblems(config: HyperlaneTokenConfig): string[] {
  const { solana, cookie, decimals } = SOL_COOKIE_BRIDGE;
  const problems: string[] = [];
  if (!config.mailbox.equals(solana.mailbox)) problems.push('mailbox changed');
  if (config.plugin.type !== 'native') problems.push('not a native SOL route');
  if (config.decimals !== decimals || config.remoteDecimals !== decimals) problems.push('decimals changed');
  if (!config.remoteRouters.get(cookie.domain)?.equals(cookie.warp)) problems.push('Cookie router changed');
  const igp = config.igp;
  if (!igp || igp.kind !== 'overheadIgp' || !igp.program.equals(solana.igpProgram) || !igp.account.equals(solana.overheadIgp)) problems.push('gas paymaster changed');
  return problems;
}

/** Same check for the Cookie side: synthetic, pinned mint, routed back to the Solana warp. */
export function cookieWarpConfigProblems(config: HyperlaneTokenConfig): string[] {
  const { solana, cookie, decimals } = SOL_COOKIE_BRIDGE;
  const problems: string[] = [];
  if (!config.mailbox.equals(cookie.mailbox)) problems.push('mailbox changed');
  if (config.plugin.type !== 'synthetic' || !config.plugin.mint.equals(cookie.mint)) problems.push('bridged SOL mint changed');
  if (config.decimals !== decimals) problems.push('decimals changed');
  if (!config.remoteRouters.get(solana.domain)?.equals(solana.warp)) problems.push('Solana router changed');
  return problems;
}

/** The inner IGP an OverheadIgp account wraps: after initialized, discriminator, bump, salt and owner. */
export function overheadIgpInner(data: Uint8Array): PublicKey {
  const buf = Buffer.from(data);
  let off = 1 + 8 + 1 + 32;
  if (buf.length < off + 1) throw Error('OverheadIgp account is truncated');
  off += buf[off] === 1 ? 33 : 1;
  if (buf.length < off + 32) throw Error('OverheadIgp account is truncated');
  return new PublicKey(buf.subarray(off, off + 32));
}

/** Read the Solana warp and refuse to proceed if it no longer matches the pinned route. */
export async function checkSolanaWarp(solanaConnection: Connection): Promise<void> {
  const info = await solanaConnection.getAccountInfo(hyperlaneTokenPda(SOL_COOKIE_BRIDGE.solana.warp), 'confirmed');
  if (!info || !info.owner.equals(SOL_COOKIE_BRIDGE.solana.warp)) throw Error('The bridge route could not be read on Solana.');
  const problems = solanaWarpConfigProblems(decodeHyperlaneToken(info.data));
  if (problems.length) throw Error(`The bridge route changed (${problems.join(', ')}). Nothing was signed.`);
}

// ---------------------------------------------------------------------------
// Tracking a transfer
// ---------------------------------------------------------------------------

function messageIdBytes(messageId: string | Uint8Array): Buffer {
  if (typeof messageId !== 'string') {
    if (messageId.length !== 32) throw Error('A message id is 32 bytes');
    return Buffer.from(messageId);
  }
  const hex = messageId.startsWith('0x') ? messageId.slice(2) : messageId;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw Error('A message id is 32 bytes of hex');
  return Buffer.from(hex, 'hex');
}

/**
 * The Hyperlane message id from the dispatch transaction's logs. The mailbox
 * logs `Dispatched message to <domain>, ID 0x…`.
 */
export function messageIdFromLogs(logs: readonly string[] | null | undefined): string | null {
  for (const line of logs ?? []) {
    const m = /Dispatched message to \d+, ID (0x[0-9a-fA-F]{64})/.exec(line);
    if (m) return m[1]!.toLowerCase();
  }
  for (const line of logs ?? []) {
    const m = /\bID (0x[0-9a-fA-F]{64})/.exec(line);
    if (m) return m[1]!.toLowerCase();
  }
  return null;
}

export interface BridgeDelivery {
  delivered: boolean;
  /** The Cookie transaction that delivered it, when the RPC could say. */
  signature: string | null;
}

/** Has the Cookie mailbox processed this message? One account read, plus one for the delivery signature. */
export async function readBridgeDelivery(cookieConnection: Connection, messageId: string): Promise<BridgeDelivery> {
  const processed = processedMessagePda(SOL_COOKIE_BRIDGE.cookie.mailbox, messageId);
  const info = await cookieConnection.getAccountInfo(processed, 'confirmed');
  if (!info) return { delivered: false, signature: null };
  const sigs = await cookieConnection.getSignaturesForAddress(processed, { limit: 1 }, 'confirmed').catch(() => []);
  return { delivered: true, signature: sigs[0]?.signature ?? null };
}

/**
 * Lamports a funder is short of paying one account's rent, after keeping its
 * own reserve. 0n when it can pay.
 */
export function ataPayerShortfall(args: { payerLamports: bigint; payerReserve: bigint; ataRent: bigint }): bigint {
  const spendable = args.payerLamports - args.payerReserve;
  const short = args.ataRent - (spendable > 0n ? spendable : 0n);
  return short > 0n ? short : 0n;
}

/** Token-2022 associated accounts carry ImmutableOwner: 165 bytes plus 5. */
export const BRIDGED_SOL_ATA_LEN = 170;

export interface CookieArrival {
  /** The recipient's bridged-SOL account on Cookie Chain. */
  ata: PublicKey;
  ataExists: boolean;
  /** Bridged SOL held there, in lamports. */
  balance: bigint;
  /**
   * Whether a delivery to a recipient without the account can be completed:
   * the warp creates it, paying rent from its own ATA-payer PDA, which the
   * team funds by hand. If it is dry the relayer's delivery fails silently and
   * the transfer waits until the payer is topped up. True when the account
   * already exists.
   */
  receivable: boolean;
}

/** What a delivery to `owner` on Cookie Chain would find. */
export async function readCookieArrival(cookieConnection: Connection, owner: PublicKey): Promise<CookieArrival> {
  const ata = bridgedSolAta(owner);
  const [account, payer] = await cookieConnection.getMultipleAccountsInfo([ata, ataPayerPda(SOL_COOKIE_BRIDGE.cookie.warp)], 'confirmed');
  if (account) {
    const balance = account.data.length >= 72 ? Buffer.from(account.data).readBigUInt64LE(64) : 0n;
    return { ata, ataExists: true, balance, receivable: true };
  }
  const [ataRent, reserve] = await Promise.all([
    cookieConnection.getMinimumBalanceForRentExemption(BRIDGED_SOL_ATA_LEN),
    cookieConnection.getMinimumBalanceForRentExemption(0),
  ]);
  const short = ataPayerShortfall({ payerLamports: BigInt(payer?.lamports ?? 0), payerReserve: BigInt(reserve), ataRent: BigInt(ataRent) });
  return { ata, ataExists: false, balance: 0n, receivable: short === 0n };
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/** Lamports as SOL, trailing zeros trimmed: 10_000_000n → "0.01". */
export function formatLamports(lamports: bigint): string {
  const negative = lamports < 0n;
  const abs = negative ? -lamports : lamports;
  const whole = abs / 1_000_000_000n;
  const frac = (abs % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

export const solanaTxUrl = (signature: string) => `${SOL_COOKIE_BRIDGE.solana.explorer}/tx/${signature}`;
export const cookieTxUrl = (signature: string) => `${SOL_COOKIE_BRIDGE.cookie.explorer}/tx/${signature}`;
