import { PublicKey, type Connection, type ParsedInstruction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { LAUNCH_CONFIG } from './params.js';
import { receiptIdentity, receiptAmount, type ReceiptSymbol } from './receipts.js';
export interface ReceiptInvoice {
  signature: string; payer: string; recipient: string; symbol: ReceiptSymbol; shares: bigint; decimals: number; invoice: string;
}
/** A public memo alone never proves payment. Merchant must additionally enforce
 * durable uniqueness of invoice AND signature in its own settlement database. */
export async function verifyReceiptInvoice(connection: Connection, invoice: ReceiptInvoice): Promise<{ signature: string; slot: number; mint: string; shares: string; finalized: true }> {
  receiptAmount(invoice.shares);
  if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(invoice.signature) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(invoice.invoice)) throw Error('Invalid invoice identity');
  if (await connection.getGenesisHash() !== LAUNCH_CONFIG.chain.genesis) throw Error('Wrong chain');
  const payer = new PublicKey(invoice.payer), recipient = new PublicKey(invoice.recipient), identity = receiptIdentity(invoice.symbol);
  const source = getAssociatedTokenAddressSync(identity.shareMint, payer, false, TOKEN_2022_PROGRAM_ID).toBase58();
  const destination = getAssociatedTokenAddressSync(identity.shareMint, recipient, false, TOKEN_2022_PROGRAM_ID).toBase58();
  const tx = await connection.getParsedTransaction(invoice.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
  if (!tx?.meta || tx.meta.err || !tx.transaction.message.accountKeys.some(k => k.signer && k.pubkey.equals(payer))) throw Error('Finalized successful payer transaction is required');
  const instructions = [...tx.transaction.message.instructions, ...(tx.meta.innerInstructions ?? []).flatMap(g => g.instructions)];
  const memos = instructions.filter(ix => ix.programId.toBase58() === 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr' && 'parsed' in ix &&
    typeof ix.parsed === 'string' && ix.parsed.startsWith('aera:invoice:')).map(ix => (ix as ParsedInstruction).parsed as string);
  if (memos.length !== 1 || memos[0] !== `aera:invoice:v1:${invoice.invoice}`) throw Error('Invoice memo does not match');
  const matched = instructions.filter(ix => {
    if (!ix.programId.equals(TOKEN_2022_PROGRAM_ID) || !('parsed' in ix)) return false;
    const p = ix.parsed;
    return p?.type === 'transferChecked' && p.info?.authority === payer.toBase58() && p.info?.source === source && p.info?.destination === destination &&
      p.info?.mint === identity.shareMint.toBase58() && p.info?.tokenAmount?.amount === invoice.shares.toString() && p.info?.tokenAmount?.decimals === invoice.decimals;
  });
  if (matched.length !== 1) throw Error('Exact receipt transfer does not match');
  const accountIndex = tx.transaction.message.accountKeys.findIndex(k => k.pubkey.toBase58() === destination);
  const post = tx.meta.postTokenBalances?.find(b => b.accountIndex === accountIndex && b.mint === identity.shareMint.toBase58() && b.owner === recipient.toBase58());
  const pre = tx.meta.preTokenBalances?.find(b => b.accountIndex === accountIndex && b.mint === identity.shareMint.toBase58() && b.owner === recipient.toBase58());
  if (!post || BigInt(post.uiTokenAmount.amount) - BigInt(pre?.uiTokenAmount.amount ?? '0') !== invoice.shares || post.uiTokenAmount.decimals !== invoice.decimals) throw Error('Recipient net receipt balance does not match');
  return { signature: invoice.signature, slot: tx.slot, mint: identity.shareMint.toBase58(), shares: invoice.shares.toString(), finalized: true };
}
