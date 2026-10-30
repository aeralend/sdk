/** Existing SOL route only. Operator planning adapter, NOT a custody/NAV oracle.
 * Fixed route and fee/account pins deliberately refuse configuration changes.
 * There is no signing, submission, balance sweep or claim issuance here.
 */
import { PublicKey, Transaction, SystemProgram, ComputeBudgetProgram, type Connection } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { LAUNCH_CONFIG } from './params.js';
import { receiptAmount } from './receipts.js';
export type SolBridgeDirection = 'cookie-to-solana' | 'solana-to-cookie';
export const SOLANA_MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const SOL_BRIDGE = {
  mint: '6tL24Fn75uCMrBSZAvohAq57LSv6KrY6ceEq1wonvucb', feeRecipient: 'Fqtq6oNvrAYbAGbjcQniPm2wcNVH1SKHt1595fQ2npNi',
  'cookie-to-solana': {router: 'E9zKioziEnQkc3v4pU9zVmVHi9dg6gKoD2qSnzY5sASi', mailbox: 'DhiHgUY8Y6mJ4D3MoRnZWAjTBEtSaFFn4CYgc6eDzZ8r',
    destinationDomain: 1399811149, genesis: LAUNCH_CONFIG.chain.genesis, fee: 15_000_000_000_000n, feeSymbol: 'COOK',
    fixed: ['11111111111111111111111111111111', 'noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV', '7JXU2QwmoKaxScJxA4pjjQb5jjey2x9cAUCRPrzFDgL6',
      'DhiHgUY8Y6mJ4D3MoRnZWAjTBEtSaFFn4CYgc6eDzZ8r', 'F3uKdYoZevdQ1H78eFHsbEU3fkxheWBdihCSYpfF8APb', '4mQWUcqE3SoRY3MAb3NoV4mh9AUAPUiwp1GrXnnA9CY1',
      null, null, null, 'F93J1LCWZVZGtiv2yWu1mZeyCbFJNUh9aWEonWN6eSRp', '3ZhiMX6sbxibLBM6yN3yDJ1KapbxKMbUwZfwknAF9uWU', null,
      'B47yFLwnEGxp3oFHyy2LdGCmAe6kTbFmzSjkVoFaod9q', '3ToZ5xv9Ge46Vj1WeJgeVdwDFhjk2ER8Hqt4GX8tu3pR',
      'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', '6tL24Fn75uCMrBSZAvohAq57LSv6KrY6ceEq1wonvucb', null]},
  'solana-to-cookie': {router: 'DWxkDF63gF5pMoAiACjkkYgr4onz4WPZi9wq59gctU6T', mailbox: 'E588QtVUvresuXq2KoNEwAmoifCzYGpRBdHByN9KQMbi',
    destinationDomain: 420042004, genesis: SOLANA_MAINNET_GENESIS, fee: 10_000_000n, feeSymbol: 'SOL',
    fixed: ['11111111111111111111111111111111', 'noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV', '3nHqTGhJXQ49PfsTtnn4yqyyVmQvWbzJ2rHmMTihvUnn',
      'E588QtVUvresuXq2KoNEwAmoifCzYGpRBdHByN9KQMbi', 'BvZpTuYLAR77mPhH4GtvwEWUTs53GQqkgBNuXpCePVNk', '9M1ircvTk5iqPmz3WFNxusSTin64F41Z84Bj8t1zmigu',
      null, null, null, 'BhNcatUDC2D5JTyeaqrdSukiVFsEHK7e3hVmKMztwefv', '8Cv4PHJ6Cf3xY7dse7wYeZKtuQv9SAN6ujt5w22a2uho', null,
      'Dg5FAhqNaRfQPc3HwW9fXr7Bj4nrnszoQspoSLgysqfY', '3RbtjzzdhmthkQ1akmbe41SbGXS3e96AqupPt6VtxHEe',
      '11111111111111111111111111111111', 'ADLE5sXddiFWpAfExBqjoHNfG8ALRJEhDAtLd5wd6eXe']},
} as const;
export interface SolBridgeIntent {direction: SolBridgeDirection; sender: PublicKey; recipient: PublicKey; amount: bigint}
export interface SolBridgePlan {transaction: Transaction; uniqueMessageAccount: PublicKey; dispatchedMessage: PublicKey;
  destinationDomain: number; amount: bigint; bridgeFee: bigint; feeSymbol: string; expiresAt: number}
export function validateSolBridgeTransaction(tx: Transaction, input: SolBridgeIntent, unique: PublicKey): SolBridgePlan {
  receiptAmount(input.amount); const route = SOL_BRIDGE[input.direction]; if (!route) throw Error('Unsupported SOL bridge direction');
  if (!tx.feePayer?.equals(input.sender) || !PublicKey.isOnCurve(input.sender.toBytes()) || !PublicKey.isOnCurve(input.recipient.toBytes()) ||
    unique.equals(input.sender) || !PublicKey.isOnCurve(unique.toBytes())) throw Error('Bridge participant mismatch');
  // This operator adapter supports signing wallets only. PDA custody requires
  // a separate restricted CPI adapter and authenticated cross-chain accounting.
  if (tx.instructions.length !== 3 || !tx.instructions[0]!.programId.equals(ComputeBudgetProgram.programId) ||
    tx.instructions[0]!.keys.length || tx.instructions[0]!.data.length !== 5 || tx.instructions[0]!.data[0] !== 2 ||
    tx.instructions[0]!.data.readUInt32LE(1) > 1_400_000) throw Error('Unexpected bridge compute budget');
  const fee = tx.instructions[1]!, transfer = tx.instructions[2]!;
  if (!fee.programId.equals(SystemProgram.programId) || fee.data.length !== 12 || fee.data.readUInt32LE(0) !== 2 || fee.data.readBigUInt64LE(4) !== route.fee ||
    fee.keys.length !== 2 || !fee.keys[0]!.pubkey.equals(input.sender) || fee.keys[1]!.pubkey.toBase58() !== SOL_BRIDGE.feeRecipient) throw Error('Bridge fee mismatch');
  const data = transfer.data;
  if (transfer.programId.toBase58() !== route.router || data.length !== 77 || !data.subarray(0, 9).equals(Buffer.alloc(9, 1)) ||
    data.readUInt32LE(9) !== route.destinationDomain || !new PublicKey(data.subarray(13, 45)).equals(input.recipient) ||
    data.readBigUInt64LE(45) !== input.amount || data.subarray(53).some(v => v !== 0)) throw Error('Bridge amount, route or recipient mismatch');
  const keys = transfer.keys;
  const dispatched = PublicKey.findProgramAddressSync([Buffer.from('hyperlane'), Buffer.from('-'), Buffer.from('dispatched_message'), Buffer.from('-'), unique.toBytes()], new PublicKey(route.mailbox))[0];
  if (keys.length !== route.fixed.length || !keys[6]!.pubkey.equals(input.sender) || !keys[7]!.pubkey.equals(unique) || !keys[8]!.pubkey.equals(dispatched)) throw Error('Bridge message account mismatch');
  for (let i = 0; i < route.fixed.length; i++) {
    const expected = route.fixed[i]; if (expected && keys[i]!.pubkey.toBase58() !== expected) throw Error(`Bridge account ${i} mismatch`);
    if (keys[i]!.isSigner !== (i === 6 || i === 7)) throw Error('Unexpected bridge signer');
  }
  if (input.direction === 'cookie-to-solana' && !keys[16]!.pubkey.equals(getAssociatedTokenAddressSync(new PublicKey(SOL_BRIDGE.mint), input.sender, false, TOKEN_2022_PROGRAM_ID))) throw Error('Bridge source token account mismatch');
  if (!tx.verifySignatures(false) || !tx.signatures.find(s => s.publicKey.equals(unique))?.signature || tx.signatures.filter(s => !s.publicKey.equals(unique) && !s.publicKey.equals(input.sender)).length) throw Error('Bridge unique signature missing or invalid');
  if (tx.serialize({requireAllSignatures: false, verifySignatures: false}).length > 1232) throw Error('Bridge transaction too large');
  return {transaction: tx, uniqueMessageAccount: unique, dispatchedMessage: dispatched, destinationDomain: route.destinationDomain,
    amount: input.amount, bridgeFee: route.fee, feeSymbol: route.feeSymbol, expiresAt: Date.now() + 60000};
}
export async function buildExistingSolBridgePlan(connection: Connection, input: SolBridgeIntent, fetcher: typeof fetch = fetch): Promise<SolBridgePlan> {
  const route = SOL_BRIDGE[input.direction]; receiptAmount(input.amount);
  if (!route || await connection.getGenesisHash() !== route.genesis) throw Error('Wrong SOL bridge source chain');
  const amount = `${input.amount / 1_000_000_000n}.${(input.amount % 1_000_000_000n).toString().padStart(9, '0')}`;
  const response = await fetcher('https://hyperlane.cookiescan.io/api/bridge/build-tx', {method: 'POST', headers: {'content-type': 'application/json'},
    signal: AbortSignal.timeout(15000), body: JSON.stringify({direction: input.direction, fromAddress: input.sender.toBase58(), toAddress: input.recipient.toBase58(), amount, token: 'SOL'})});
  if (!response.ok) throw Error('Existing SOL bridge could not build the transaction');
  const data = await response.json() as any;
  if (data.token !== 'SOL' || data.destinationDomain !== route.destinationDomain || typeof data.txBase64 !== 'string' || data.txBase64.length > 1644) throw Error('Invalid SOL bridge response');
  const tx = Transaction.from(Buffer.from(data.txBase64, 'base64'));
  const plan = validateSolBridgeTransaction(tx, input, new PublicKey(data.uniqueMessageAccount));
  const accounts = await connection.getMultipleAccountsInfo([new PublicKey(route.router), new PublicKey(route.mailbox)], 'finalized');
  if (accounts.length !== 2 || accounts.some(a => !a?.executable) || !tx.recentBlockhash || !(await connection.isBlockhashValid(tx.recentBlockhash, {commitment: 'confirmed'})).value) throw Error('Bridge program or blockhash unavailable');
  return plan;
}
