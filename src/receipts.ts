/** Working-capital receipts. All values are base-unit strings at one RPC slot.
 * A book claim is not a promise of immediate cash. Builders never sign or send.
 */
import { PublicKey, Transaction, TransactionInstruction, type Connection, type AccountInfo } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, ExtensionType, getExtensionTypes,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction, unpackAccount, unpackMint } from '@solana/spl-token';
import { AeraClient } from './client.js';
import { AERA_PROGRAM_ID } from './constants.js';
import { decodeGlobal, decodeObligation, decodeReserve } from './decode.js';
import { globalPda, marketPda, reservePda, shareMintPda, obligationPda, liquidityVaultPda } from './pda.js';
import { LAUNCH_CONFIG } from './params.js';
import { accrueReserve, totalLiquidityOf } from './projection.js';
import { supplyRateBps } from './math.js';
import { ensureAtaIx, isNativeMint, unwrapNativeIx } from './native.js';

export const RECEIPT_ASSETS = [
  { symbol: 'aCOOK', underlying: 'COOK', marketId: 0, mint: 'So11111111111111111111111111111111111111112' },
  { symbol: 'abCOOK', underlying: 'bCOOK', marketId: 0, mint: 'EkPafx58mgwkEnGwo62jXhXDAdJ37Z8G8MFBRPsr9uhz' },
  { symbol: 'aSOL', underlying: 'SOL', marketId: 1, mint: '6tL24Fn75uCMrBSZAvohAq57LSv6KrY6ceEq1wonvucb' },
] as const;
export type ReceiptSymbol = typeof RECEIPT_ASSETS[number]['symbol'];
export interface ReceiptBalance {
  symbol: ReceiptSymbol; underlying: string; marketId: number; reserve: string; mint: string; underlyingMint: string;
  decimals: number; underlyingDecimals: number; unlockedShares: string; lockedShares: string;
  unlockedClaim: string; lockedClaim: string; redeemableShares: string; redeemableUnderlying: string;
  reserveAvailable: string; reserveTotal: string; shareSupply: string; supplyAprBps: number;
  collateralEnabled: boolean; redemptionPaused: boolean;
}
export interface ReceiptPortfolio {
  owner: string; slot: string; observedAt: string; genesis: string; receipts: ReceiptBalance[];
}
export const RECEIPT_QUOTE_TTL_MS = 60_000;
const U64_MAX = (1n << 64n) - 1n;
export function receiptAmount(value: bigint): bigint {
  if (value <= 0n || value > U64_MAX) throw Error('Amount must be a positive u64');
  return value;
}
export function receiptAsset(symbol: ReceiptSymbol) {
  const asset = RECEIPT_ASSETS.find(a => a.symbol === symbol);
  if (!asset) throw Error('Unsupported receipt');
  return asset;
}
export function receiptIdentity(symbol: ReceiptSymbol) {
  const asset = receiptAsset(symbol), underlying = new PublicKey(asset.mint);
  const reserve = reservePda(marketPda(asset.marketId), underlying);
  return { ...asset, underlying, reserve, shareMint: shareMintPda(reserve) };
}
/** Greatest number of shares whose rounded-down redemption fits available cash. */
export function redeemableReceiptShares(shares: bigint, total: bigint, supply: bigint, cash: bigint): bigint {
  if ([shares, total, supply, cash].some(x => x < 0n) || shares > supply) throw Error('Invalid reserve accounting');
  if (shares === 0n || total === 0n || supply === 0n || cash === 0n) return 0n;
  const fit = ((cash + 1n) * supply - 1n) / total;
  const result = shares < fit ? shares : fit;
  return result * total / supply === 0n ? 0n : result;
}
export async function readReceiptPortfolio(connection: Connection, owner: PublicKey): Promise<ReceiptPortfolio> {
  const genesis = await connection.getGenesisHash();
  if (genesis !== LAUNCH_CONFIG.chain.genesis) throw Error('Wrong chain');
  const client = new AeraClient({ connection });
  const assets = RECEIPT_ASSETS.map(a => receiptIdentity(a.symbol));
  const keys = [AERA_PROGRAM_ID, globalPda(), ...assets.flatMap(a => [a.reserve, a.shareMint,
    getAssociatedTokenAddressSync(a.shareMint, owner, true, TOKEN_2022_PROGRAM_ID),
    obligationPda(marketPda(a.marketId), owner), liquidityVaultPda(a.reserve)])];
  const { context, value } = await connection.getMultipleAccountsInfoAndContext(keys, { commitment: 'confirmed' });
  if (!value[0]?.executable) throw Error('Aera program is unavailable');
  const programAccount = (index: number): AccountInfo<Buffer> => {
    const info = value[index];
    if (!info || !info.owner.equals(AERA_PROGRAM_ID) || info.executable) throw Error('Invalid Aera account owner');
    return info;
  };
  const global = decodeGlobal(keys[1]!, client.decodeAccountData('Global', programAccount(1).data));
  const receipts = assets.map((a, index): ReceiptBalance => {
    const at = 2 + index * 5;
    const stored = decodeReserve(a.reserve, client.decodeAccountData('Reserve', programAccount(at).data));
    if (!stored.market.equals(marketPda(a.marketId)) || !stored.liquidityMint.equals(a.underlying) ||
      !stored.shareMint.equals(a.shareMint) || !stored.liquidityVault.equals(keys[at + 4]!)) throw Error('Receipt identity mismatch');
    const mintInfo = value[at + 1];
    if (!mintInfo) throw Error('Receipt mint is unavailable');
    const mint = unpackMint(a.shareMint, mintInfo, TOKEN_2022_PROGRAM_ID);
    // Direct burns may reduce actual supply. Aera's mirrored supply remains
    // authoritative for redemption; never reprice the remaining holders upward.
    if (!mint.mintAuthority?.equals(a.reserve) || mint.freezeAuthority || !mint.isInitialized || mint.supply > stored.shareMintSupply) throw Error('Invalid receipt mint');
    const allowed = [ExtensionType.MetadataPointer, ExtensionType.TokenMetadata];
    if (getExtensionTypes(mint.tlvData).some(t => !allowed.includes(t))) throw Error('Unsupported receipt mint extension');
    const walletInfo = value[at + 2];
    let shares = 0n;
    if (walletInfo) {
      const token = unpackAccount(keys[at + 2]!, walletInfo, TOKEN_2022_PROGRAM_ID);
      if (!token.mint.equals(a.shareMint) || !token.owner.equals(owner) || token.isFrozen) throw Error('Invalid receipt token account');
      shares = token.amount;
    }
    const obligationInfo = value[at + 3];
    let locked = 0n;
    if (obligationInfo) {
      programAccount(at + 3);
      const obligation = decodeObligation(keys[at + 3]!, client.decodeAccountData('Obligation', obligationInfo.data));
      if (!obligation.owner.equals(owner) || !obligation.market.equals(stored.market)) throw Error('Invalid obligation');
      locked = obligation.deposits.find(d => d.reserve.equals(a.reserve))?.depositedShares ?? 0n;
    }
    const vaultInfo = value[at + 4];
    if (!vaultInfo || (!vaultInfo.owner.equals(TOKEN_PROGRAM_ID) && !vaultInfo.owner.equals(TOKEN_2022_PROGRAM_ID))) throw Error('Invalid liquidity vault');
    const vault = unpackAccount(keys[at + 4]!, vaultInfo, vaultInfo.owner);
    if (!vault.mint.equals(a.underlying) || !vault.owner.equals(a.reserve) || vault.amount < stored.availableLiquidity || vault.isFrozen) throw Error('Invalid reserve cash');
    const reserve = accrueReserve(stored, BigInt(context.slot)), total = totalLiquidityOf(reserve), supply = reserve.shareMintSupply;
    if (shares + locked > supply || total < 0n) throw Error('Invalid share accounting');
    const claim = (amount: bigint) => supply === 0n ? 0n : amount * total / supply;
    const redeemable = global.paused ? 0n : redeemableReceiptShares(shares, total, supply, reserve.availableLiquidity);
    return { symbol: a.symbol, underlying: receiptAsset(a.symbol).underlying,
      marketId: a.marketId, reserve: a.reserve.toBase58(), mint: a.shareMint.toBase58(), underlyingMint: a.mint,
      decimals: mint.decimals, underlyingDecimals: reserve.liquidityDecimals, unlockedShares: shares.toString(), lockedShares: locked.toString(),
      unlockedClaim: claim(shares).toString(), lockedClaim: claim(locked).toString(), redeemableShares: redeemable.toString(),
      redeemableUnderlying: claim(redeemable).toString(), reserveAvailable: reserve.availableLiquidity.toString(), reserveTotal: total.toString(),
      shareSupply: supply.toString(), supplyAprBps: Number(supplyRateBps(reserve)), collateralEnabled: reserve.config.collateralEnabled, redemptionPaused: global.paused };
  });
  return { owner: owner.toBase58(), slot: String(context.slot), observedAt: new Date().toISOString(), genesis, receipts };
}
export interface ReceiptPaymentQuote {
  version: 1; genesis: string; sender: string; recipient: string; symbol: ReceiptSymbol; mint: string;
  shares: string; decimals: number; underlying: string; indicativeUnderlying: string;
  invoice: string; expiresAt: number; observedSlot: string; serviceFeeShares: '0';
}
export function quoteReceiptPayment(portfolio: ReceiptPortfolio, input: { symbol: ReceiptSymbol; recipient: string; shares: bigint; invoice: string }, now = Date.now()): ReceiptPaymentQuote {
  receiptAmount(input.shares);
  const recipient = new PublicKey(input.recipient), sender = new PublicKey(portfolio.owner);
  if (!PublicKey.isOnCurve(recipient.toBytes()) || sender.equals(recipient)) throw Error('Choose a different recipient wallet');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(input.invoice)) throw Error('Invoice must be 1–64 letters, numbers, dots, underscores, colons or hyphens');
  const age = now - Date.parse(portfolio.observedAt);
  if (!Number.isSafeInteger(now) || !Number.isFinite(age) || age < 0 || age > RECEIPT_QUOTE_TTL_MS || portfolio.genesis !== LAUNCH_CONFIG.chain.genesis) throw Error('Refresh receipt balances');
  const r = portfolio.receipts.find(r => r.symbol === input.symbol);
  if (!r || r.mint !== receiptIdentity(input.symbol).shareMint.toBase58() || input.shares > BigInt(r.unlockedShares)) throw Error('Insufficient unlocked receipts');
  const value = BigInt(r.shareSupply) === 0n ? 0n : input.shares * BigInt(r.reserveTotal) / BigInt(r.shareSupply);
  return { version: 1, genesis: portfolio.genesis, sender: portfolio.owner, recipient: recipient.toBase58(), symbol: input.symbol,
    mint: r.mint, shares: input.shares.toString(), decimals: r.decimals, underlying: r.underlying, indicativeUnderlying: value.toString(),
    invoice: input.invoice, expiresAt: now + RECEIPT_QUOTE_TTL_MS, observedSlot: portfolio.slot, serviceFeeShares: '0' };
}
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
/** Re-read balance/identities before building. The final wallet approves exact shares, never a floating underlying amount. */
export async function buildReceiptPayment(connection: Connection, quote: ReceiptPaymentQuote, now?: number): Promise<Transaction> {
  const start = now ?? Date.now();
  if (quote.version !== 1 || !Number.isSafeInteger(quote.expiresAt) || quote.expiresAt <= start || quote.expiresAt > start + RECEIPT_QUOTE_TTL_MS) throw Error('Payment quote expired');
  const owner = new PublicKey(quote.sender), portfolio = await readReceiptPortfolio(connection, owner);
  const checkedAt = now ?? Date.now();
  if (quote.expiresAt <= checkedAt) throw Error('Payment quote expired');
  const fresh = quoteReceiptPayment(portfolio, { symbol: quote.symbol, recipient: quote.recipient, shares: BigInt(quote.shares), invoice: quote.invoice }, checkedAt);
  if (fresh.mint !== quote.mint || fresh.genesis !== quote.genesis || fresh.decimals !== quote.decimals || quote.serviceFeeShares !== '0') throw Error('Payment quote identity changed');
  const mint = new PublicKey(quote.mint), recipient = new PublicKey(quote.recipient);
  const source = getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
  const destination = getAssociatedTokenAddressSync(mint, recipient, false, TOKEN_2022_PROGRAM_ID);
  return new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(owner, destination, recipient, mint, TOKEN_2022_PROGRAM_ID),
    new TransactionInstruction({ programId: MEMO, keys: [{ pubkey: owner, isSigner: true, isWritable: false }], data: Buffer.from(`aera:invoice:v1:${quote.invoice}`, 'utf8') }),
    createTransferCheckedInstruction(source, mint, destination, owner, BigInt(quote.shares), quote.decimals, [], TOKEN_2022_PROGRAM_ID));
}
export async function buildReceiptRedemption(connection: Connection, owner: PublicKey, symbol: ReceiptSymbol, shares: bigint): Promise<Transaction> {
  receiptAmount(shares);
  const portfolio = await readReceiptPortfolio(connection, owner), r = portfolio.receipts.find(r => r.symbol === symbol);
  if (!r || shares > BigInt(r.redeemableShares) || r.redemptionPaused) throw Error('Requested receipts cannot be redeemed from available liquidity');
  const client = new AeraClient({ connection, marketId: r.marketId }), mint = new PublicKey(r.underlyingMint);
  const program = await client.liquidityTokenProgram(mint);
  const tx = new Transaction().add(ensureAtaIx(owner, mint, program));
  tx.add(...(await client.withdraw(owner, mint, shares)).instructions);
  if (isNativeMint(mint)) tx.add(unwrapNativeIx(owner));
  return tx;
}
/** Snapshot export, not a transaction history or tax report. Asset columns never mix COOK, bCOOK and SOL. */
export function receiptPortfolioCsv(portfolio: ReceiptPortfolio): string {
  const header = ['observed_at', 'slot', 'owner', 'receipt', 'mint', 'underlying', 'unlocked_shares_base_units', 'locked_shares_base_units', 'unlocked_claim_base_units', 'available_redemption_base_units', 'share_decimals', 'underlying_decimals'];
  const cell = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const rows = portfolio.receipts.map(r => [portfolio.observedAt, portfolio.slot, portfolio.owner, r.symbol, r.mint, r.underlying,
    r.unlockedShares, r.lockedShares, r.unlockedClaim, r.redeemableUnderlying, String(r.decimals), String(r.underlyingDecimals)]);
  return [header, ...rows].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
