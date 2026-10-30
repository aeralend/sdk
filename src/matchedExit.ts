/** Whole-fill, co-signed matched exits. No custody, allowances, order book or
 * unilateral fills. A recent blockhash bounds the lifetime of both signatures.
 */
import { PublicKey, SystemProgram, Transaction, TransactionInstruction, type Connection } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, unpackMint, unpackAccount, getExtensionTypes, ExtensionType,
} from '@solana/spl-token';
import { LAUNCH_CONFIG } from './params.js';
import { readReceiptPortfolio, receiptIdentity, receiptAmount, RECEIPT_QUOTE_TTL_MS, type ReceiptSymbol, type ReceiptPortfolio } from './receipts.js';
export interface MatchedExitTerms {
  version: 1; seller: string; buyer: string; symbol: ReceiptSymbol; receiptMint: string;
  shares: string; paymentMint: string; paymentAmount: string; invoice: string; expiresAt: number;
}
export interface MatchedExitPacket { version: 1; terms: MatchedExitTerms; transactionBase64: string; lastValidBlockHeight: number }
export async function createMatchedExitPacket(connection: Connection, terms: MatchedExitTerms): Promise<MatchedExitPacket> {
  const {transaction, lastValidBlockHeight} = await buildMatchedExit(connection, terms);
  return {version: 1, terms, lastValidBlockHeight, transactionBase64: transaction.serialize({requireAllSignatures: false, verifySignatures: false}).toString('base64')};
}
/** Validate the complete transaction against independently rebuilt terms before
 * either wallet signs. The bridge/lending programs are never invoked here. */
export async function validateMatchedExitPacket(connection: Connection, packet: MatchedExitPacket, signer: PublicKey): Promise<Transaction> {
  if (packet?.version !== 1 || !packet.terms || typeof packet.transactionBase64 !== 'string' ||
    packet.transactionBase64.length > 1644 || !/^[A-Za-z0-9+/]+={0,2}$/.test(packet.transactionBase64) ||
    !Number.isSafeInteger(packet.lastValidBlockHeight)) throw Error('Invalid matched exit packet');
  if (![packet.terms.seller, packet.terms.buyer].includes(signer.toBase58())) throw Error('Wallet is not a party to this exit');
  const tx = Transaction.from(Buffer.from(packet.transactionBase64, 'base64'));
  if (!tx.recentBlockhash || tx.serialize({requireAllSignatures: false, verifySignatures: false}).length > 1232) throw Error('Invalid exit transaction');
  const height = await connection.getBlockHeight('confirmed');
  if (packet.lastValidBlockHeight < height || packet.lastValidBlockHeight > height + 200 ||
    !(await connection.isBlockhashValid(tx.recentBlockhash, {commitment: 'confirmed'})).value) throw Error('Exit blockhash expired or invalid');
  const expected = (await buildMatchedExit(connection, packet.terms)).transaction;
  expected.recentBlockhash = tx.recentBlockhash;
  if (!expected.serializeMessage().equals(tx.serializeMessage()) || !tx.verifySignatures(false)) throw Error('Exit transaction differs from agreed terms or has an invalid signature');
  if (signer.toBase58() === packet.terms.buyer && !tx.signatures.some(s => s.publicKey.toBase58() === packet.terms.seller && s.signature)) throw Error('Seller must sign before the buyer');
  return tx;
}
export function attachMatchedExitSignature(packet: MatchedExitPacket, signed: Transaction): MatchedExitPacket {
  const original = Transaction.from(Buffer.from(packet.transactionBase64, 'base64'));
  if (!original.serializeMessage().equals(signed.serializeMessage()) || !signed.verifySignatures(false)) throw Error('Wallet changed the exit transaction');
  if (!signed.signatures.some(s => s.publicKey.toBase58() === packet.terms.seller && s.signature)) throw Error('Seller signature missing');
  return {...packet, transactionBase64: signed.serialize({requireAllSignatures: false, verifySignatures: true}).toString('base64')};
}
export function matchedExitTerms(portfolio: ReceiptPortfolio, input: { buyer: string; symbol: ReceiptSymbol; shares: bigint; paymentAmount: bigint; invoice: string }, now = Date.now()): MatchedExitTerms {
  receiptAmount(input.shares); receiptAmount(input.paymentAmount);
  const age = now - Date.parse(portfolio.observedAt), buyer = new PublicKey(input.buyer);
  if (portfolio.genesis !== LAUNCH_CONFIG.chain.genesis || !Number.isFinite(age) || age < 0 || age > RECEIPT_QUOTE_TTL_MS) throw Error('Refresh seller portfolio');
  if (!PublicKey.isOnCurve(buyer.toBytes()) || portfolio.owner === buyer.toBase58()) throw Error('Buyer must be a different wallet');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(input.invoice)) throw Error('Invalid invoice');
  const identity = receiptIdentity(input.symbol), r = portfolio.receipts.find(r => r.symbol === input.symbol);
  if (!r || r.mint !== identity.shareMint.toBase58() || BigInt(r.unlockedShares) < input.shares) throw Error('Insufficient unlocked receipts');
  return { version: 1, seller: portfolio.owner, buyer: buyer.toBase58(), symbol: input.symbol,
    receiptMint: r.mint, shares: input.shares.toString(), paymentMint: identity.mint,
    paymentAmount: input.paymentAmount.toString(), invoice: input.invoice, expiresAt: now + RECEIPT_QUOTE_TTL_MS };
}
export async function buildMatchedExit(connection: Connection, terms: MatchedExitTerms, now?: number): Promise<{ transaction: Transaction; lastValidBlockHeight: number }> {
  const start = now ?? Date.now();
  if (terms.version !== 1 || !Number.isSafeInteger(terms.expiresAt) || terms.expiresAt <= start || terms.expiresAt > start + RECEIPT_QUOTE_TTL_MS) throw Error('Matched exit expired');
  const seller = new PublicKey(terms.seller), buyer = new PublicKey(terms.buyer);
  const portfolio = await readReceiptPortfolio(connection, seller);
  const fresh = matchedExitTerms(portfolio, { buyer: terms.buyer, symbol: terms.symbol,
    shares: BigInt(terms.shares), paymentAmount: BigInt(terms.paymentAmount), invoice: terms.invoice }, now ?? Date.now());
  if (terms.receiptMint !== fresh.receiptMint || terms.paymentMint !== fresh.paymentMint) throw Error('Matched exit mint mismatch');
  const r = portfolio.receipts.find(r => r.symbol === terms.symbol)!;
  const mint = new PublicKey(terms.receiptMint);
  const from = getAssociatedTokenAddressSync(mint, seller, false, TOKEN_2022_PROGRAM_ID);
  const to = getAssociatedTokenAddressSync(mint, buyer, false, TOKEN_2022_PROGRAM_ID);
  const tx = new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(buyer, to, buyer, mint, TOKEN_2022_PROGRAM_ID));
  tx.add(new TransactionInstruction({ programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
    keys: [seller, buyer].map(pubkey => ({ pubkey, isSigner: true, isWritable: false })), data: Buffer.from(`aera:exit:v1:${terms.invoice}`) }));
  tx.add(createTransferCheckedInstruction(from, mint, to, seller, BigInt(terms.shares), r.decimals, [], TOKEN_2022_PROGRAM_ID));
  if (terms.symbol === 'aCOOK') {
    // COOK is Cookie's native asset; wrapped COOK and native COOK share units.
    tx.add(SystemProgram.transfer({ fromPubkey: buyer, toPubkey: seller, lamports: BigInt(terms.paymentAmount) }));
  } else {
    const paymentMint = new PublicKey(terms.paymentMint), info = await connection.getAccountInfo(paymentMint, 'confirmed');
    if (!info || (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID))) throw Error('Invalid payment mint');
    const payment = unpackMint(paymentMint, info, info.owner);
    if (!payment.isInitialized || payment.freezeAuthority || getExtensionTypes(payment.tlvData).some(type =>
      type !== ExtensionType.MetadataPointer && type !== ExtensionType.TokenMetadata)) throw Error('Unsupported payment mint extensions');
    const buyerAta = getAssociatedTokenAddressSync(paymentMint, buyer, false, info.owner);
    const sellerAta = getAssociatedTokenAddressSync(paymentMint, seller, false, info.owner);
    const balanceInfo = await connection.getAccountInfo(buyerAta, 'confirmed');
    if (!balanceInfo) throw Error('Buyer has insufficient payment balance');
    const balance = unpackAccount(buyerAta, balanceInfo, info.owner);
    if (!balance.owner.equals(buyer) || !balance.mint.equals(paymentMint) || balance.isFrozen || balance.amount < BigInt(terms.paymentAmount)) throw Error('Buyer has insufficient payment balance');
    tx.add(createAssociatedTokenAccountIdempotentInstruction(buyer, sellerAta, seller, paymentMint, info.owner),
      createTransferCheckedInstruction(buyerAta, paymentMint, sellerAta, buyer, BigInt(terms.paymentAmount), payment.decimals, [], info.owner));
  }
  const block = await connection.getLatestBlockhash('confirmed');
  if (terms.expiresAt <= (now ?? Date.now())) throw Error('Matched exit expired');
  tx.feePayer = buyer; tx.recentBlockhash = block.blockhash;
  if (tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length > 1232) throw Error('Matched exit exceeds transaction limit');
  return { transaction: tx, lastValidBlockHeight: block.lastValidBlockHeight };
}
