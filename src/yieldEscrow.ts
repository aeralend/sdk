/** Isolated yield-paid services. Every builder returns an unsigned transaction. */
import { AnchorProvider, Program } from '@coral-xyz/anchor';
import BNModule from 'bn.js';
import { PublicKey, SystemProgram, Transaction, type Connection } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import idl from '../idl/yield_escrow.json' with { type: 'json' };
import { AeraClient } from './client.js';
import { AERA_PROGRAM_ID } from './constants.js';
import { LAUNCH_CONFIG } from './params.js';
import { globalPda, liquidityVaultPda, supplyPositionPda } from './pda.js';
import { RECEIPT_ASSETS, readReceiptPortfolio, receiptIdentity, receiptAmount, type ReceiptSymbol } from './receipts.js';
const BN = ((BNModule as unknown as {default?: typeof BNModule}).default ?? BNModule) as typeof BNModule;
export const YIELD_ESCROW_PROGRAM_ID = new PublicKey(idl.address);
export interface YieldEscrowState {
  address: string; owner: string; merchant: string; reserve: string; shareMint: string; symbol: ReceiptSymbol;
  principal: string; maxPayment: string; paid: string; entitledShares: string; expiry: number; nonce: string; closed: boolean;
}
export function yieldEscrowAddress(owner: PublicKey, nonce: bigint): PublicKey {
  if (nonce < 0n || nonce > (1n << 64n) - 1n) throw Error('Invalid escrow nonce');
  const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(nonce);
  return PublicKey.findProgramAddressSync([Buffer.from('yield_escrow'), owner.toBytes(), bytes], YIELD_ESCROW_PROGRAM_ID)[0];
}
const program = (connection: Connection) => new Program(idl as never, new AnchorProvider(connection, {} as never, {commitment: 'confirmed'}));
async function ready(connection: Connection): Promise<void> {
  if (await connection.getGenesisHash() !== LAUNCH_CONFIG.chain.genesis) throw Error('Wrong escrow chain');
  if (!(await connection.getAccountInfo(YIELD_ESCROW_PROGRAM_ID, 'confirmed'))?.executable) throw Error('Yield escrow program unavailable');
}
function decode(connection: Connection, address: PublicKey, data: Buffer): YieldEscrowState {
  const s = program(connection).coder.accounts.decode('yieldEscrow', data) as any;
  if (!yieldEscrowAddress(s.owner, BigInt(s.nonce.toString())).equals(address)) throw Error('Escrow PDA mismatch');
  const asset = RECEIPT_ASSETS.find(a => receiptIdentity(a.symbol).reserve.equals(s.reserve) && receiptIdentity(a.symbol).shareMint.equals(s.shareMint));
  if (!asset) throw Error('Unsupported escrow reserve');
  const expiry = Number(s.expiry.toString()); if (!Number.isSafeInteger(expiry)) throw Error('Invalid escrow expiry');
  return { address: address.toBase58(), owner: s.owner.toBase58(), merchant: s.merchant.toBase58(), reserve: s.reserve.toBase58(),
    shareMint: s.shareMint.toBase58(), symbol: asset.symbol, principal: s.principal.toString(), maxPayment: s.maxPayment.toString(),
    paid: s.paid.toString(), entitledShares: s.entitledShares.toString(), expiry, nonce: s.nonce.toString(), closed: s.closed };
}
export async function readYieldEscrow(connection: Connection, address: PublicKey): Promise<YieldEscrowState> {
  await ready(connection); const account = await connection.getAccountInfo(address, 'confirmed');
  if (!account?.owner.equals(YIELD_ESCROW_PROGRAM_ID)) throw Error('Escrow account unavailable');
  return decode(connection, address, account.data);
}
export async function listYieldEscrows(connection: Connection, owner: PublicKey): Promise<YieldEscrowState[]> {
  await ready(connection);
  const accounts = await connection.getProgramAccounts(YIELD_ESCROW_PROGRAM_ID, {commitment: 'confirmed', filters: [
    {dataSize: 186}, {memcmp: {offset: 8, bytes: owner.toBase58()}}]});
  return accounts.map(a => decode(connection, a.pubkey, a.account.data)).filter(a => a.owner === owner.toBase58());
}
export async function buildOpenYieldEscrow(connection: Connection, owner: PublicKey, input: {
  symbol: ReceiptSymbol; merchant: PublicKey; nonce: bigint; shares: bigint; expiry: number; maxPayment: bigint;
}): Promise<{transaction: Transaction; address: PublicKey; principalPreview: bigint}> {
  await ready(connection); receiptAmount(input.shares); receiptAmount(input.maxPayment);
  const now = Math.floor(Date.now() / 1000);
  if (!PublicKey.isOnCurve(input.merchant.toBytes()) || input.merchant.equals(owner) || !Number.isSafeInteger(input.expiry) ||
    input.expiry <= now || input.expiry > now + 365 * 86400) throw Error('Invalid escrow terms');
  const p = await readReceiptPortfolio(connection, owner), r = p.receipts.find(r => r.symbol === input.symbol)!;
  if (r.redemptionPaused || input.shares > BigInt(r.unlockedShares)) throw Error('Insufficient unlocked receipts or reserve paused');
  const a = receiptIdentity(input.symbol), address = yieldEscrowAddress(owner, input.nonce);
  if (await connection.getAccountInfo(address, 'confirmed')) throw Error('Escrow nonce already used');
  const accounts = {owner, merchant: input.merchant, global: globalPda(), reserve: a.reserve, shareMint: a.shareMint,
    ownerShares: getAssociatedTokenAddressSync(a.shareMint, owner, false, TOKEN_2022_PROGRAM_ID), escrow: address,
    escrowShares: getAssociatedTokenAddressSync(a.shareMint, address, true, TOKEN_2022_PROGRAM_ID),
    supplyPosition: supplyPositionPda(a.reserve, address), shareTokenProgram: TOKEN_2022_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId};
  const instruction = await (program(connection).methods as any).open(new BN(input.nonce.toString()), new BN(input.shares.toString()),
    new BN(input.expiry), new BN(input.maxPayment.toString())).accountsStrict(accounts).instruction();
  const client = new AeraClient({connection, marketId: a.marketId});
  return { transaction: new Transaction().add(await client.accrueIx(a.reserve), instruction), address,
    principalPreview: input.shares * BigInt(r.reserveTotal) / BigInt(r.shareSupply) };
}
export async function buildSettleYieldEscrow(connection: Connection, payer: PublicKey, address: PublicKey): Promise<Transaction> {
  const s = await readYieldEscrow(connection, address);
  if (s.closed || s.expiry <= Math.floor(Date.now() / 1000)) throw Error('Escrow closed or expired');
  const a = receiptIdentity(s.symbol), client = new AeraClient({connection, marketId: a.marketId});
  const token = await client.liquidityTokenProgram(a.underlying), merchant = new PublicKey(s.merchant);
  const liquidity = getAssociatedTokenAddressSync(a.underlying, address, true, token), destination = getAssociatedTokenAddressSync(a.underlying, merchant, false, token);
  const tx = new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(payer, liquidity, address, a.underlying, token),
    createAssociatedTokenAccountIdempotentInstruction(payer, destination, merchant, a.underlying, token), await client.accrueIx(a.reserve));
  return tx.add(await (program(connection).methods as any).settle().accountsStrict({escrow: address, global: globalPda(), reserve: a.reserve,
    shareMint: a.shareMint, liquidityMint: a.underlying, liquidityVault: liquidityVaultPda(a.reserve),
    escrowShares: getAssociatedTokenAddressSync(a.shareMint, address, true, TOKEN_2022_PROGRAM_ID), escrowLiquidity: liquidity,
    merchantLiquidity: destination, supplyPosition: supplyPositionPda(a.reserve, address), aeraProgram: AERA_PROGRAM_ID,
    liquidityTokenProgram: token, shareTokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId}).instruction());
}
export async function buildCancelYieldEscrow(connection: Connection, owner: PublicKey, address: PublicKey): Promise<Transaction> {
  const s = await readYieldEscrow(connection, address);
  if (s.owner !== owner.toBase58() || s.closed) throw Error('Only the active escrow owner can cancel');
  const mint = new PublicKey(s.shareMint), destination = getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);
  return new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(owner, destination, owner, mint, TOKEN_2022_PROGRAM_ID),
    await (program(connection).methods as any).cancel().accountsStrict({owner, escrow: address, shareMint: mint,
      escrowShares: getAssociatedTokenAddressSync(mint, address, true, TOKEN_2022_PROGRAM_ID), ownerShares: destination,
      shareTokenProgram: TOKEN_2022_PROGRAM_ID}).instruction());
}
export async function buildRecoverEscrowLiquidity(connection: Connection, owner: PublicKey, address: PublicKey): Promise<Transaction> {
  const s = await readYieldEscrow(connection, address); if (s.owner !== owner.toBase58()) throw Error('Only owner can recover donations');
  const a = receiptIdentity(s.symbol), token = await new AeraClient({connection, marketId: a.marketId}).liquidityTokenProgram(a.underlying);
  const destination = getAssociatedTokenAddressSync(a.underlying, owner, false, token);
  return new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(owner, destination, owner, a.underlying, token),
    await (program(connection).methods as any).recoverLiquidity().accountsStrict({owner, escrow: address, reserve: a.reserve,
      liquidityMint: a.underlying, escrowLiquidity: getAssociatedTokenAddressSync(a.underlying, address, true, token), ownerLiquidity: destination,
      liquidityTokenProgram: token}).instruction());
}
