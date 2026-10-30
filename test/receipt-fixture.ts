import { Program } from '@coral-xyz/anchor';
import BN from 'bn.js';
import { Connection, PublicKey, Keypair, SystemProgram, type AccountInfo } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import idl from '../idl/aera.json' with { type: 'json' };
import { AERA_PROGRAM_ID, COOK_RESERVE_CONFIG, LAUNCH_CONFIG } from '../src/index.js';
import { RECEIPT_ASSETS, receiptIdentity } from '../src/receipts.js';
import { globalPda, marketPda, liquidityVaultPda } from '../src/pda.js';
export const owner = Keypair.generate(), recipient = Keypair.generate();
export const info = (data: Buffer, program: PublicKey): AccountInfo<Buffer> => ({ data, owner: program, lamports: 10000000, executable: false });
const bn = (x: unknown): any => typeof x === 'bigint' ? new BN(x.toString()) :
  x && typeof x === 'object' && !(x instanceof PublicKey) ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, bn(v)])) : x;
export async function receiptFixture() {
  const connection = new Connection('http://localhost:8899');
  const coder = new Program(idl as never, { connection } as never).coder.accounts;
  const accounts = new Map<string, AccountInfo<Buffer>>();
  accounts.set(AERA_PROGRAM_ID.toBase58(), { ...info(Buffer.alloc(0), SystemProgram.programId), executable: true });
  const global = { admin: owner.publicKey, feeDestination: owner.publicKey, paused: false, borrowPaused: false, paramTimelockSeconds: new BN(86400), bump: 1, version: 2 };
  accounts.set(globalPda().toBase58(), info(await coder.encode('global', global), AERA_PROGRAM_ID));
  for (const asset of RECEIPT_ASSETS) {
    const a = receiptIdentity(asset.symbol), vault = liquidityVaultPda(a.reserve);
    const reserve = { market: marketPda(a.marketId), liquidityMint: a.underlying, liquidityVault: vault, shareMint: a.shareMint,
      oracle: owner.publicKey, liquidityDecimals: 9, availableLiquidity: 500n, shareMintSupply: 1000n, borrowedPrincipal: 500n,
      borrowIndex: 1000000000000000000n, lastUpdateSlot: 1n, accruedFees: 0n, config: COOK_RESERVE_CONFIG,
      pending: { config: COOK_RESERVE_CONFIG, eta: 0n }, bump: 1 };
    accounts.set(a.reserve.toBase58(), info(await coder.encode('reserve', bn(reserve)), AERA_PROGRAM_ID));
    const mint = Buffer.alloc(82); mint.writeUInt32LE(1); a.reserve.toBuffer().copy(mint, 4);
    mint.writeBigUInt64LE(1000n, 36); mint[44] = 9; mint[45] = 1;
    accounts.set(a.shareMint.toBase58(), info(mint, TOKEN_2022_PROGRAM_ID));
    const token = (mint: PublicKey, authority: PublicKey, amount: bigint) => {
      const data = Buffer.alloc(165); mint.toBuffer().copy(data); authority.toBuffer().copy(data, 32);
      data.writeBigUInt64LE(amount, 64); data[108] = 1; return data;
    };
    accounts.set(getAssociatedTokenAddressSync(a.shareMint, owner.publicKey, false, TOKEN_2022_PROGRAM_ID).toBase58(), info(token(a.shareMint, owner.publicKey, 100n), TOKEN_2022_PROGRAM_ID));
    accounts.set(vault.toBase58(), info(token(a.underlying, a.reserve, 500n), TOKEN_PROGRAM_ID));
  }
  connection.getGenesisHash = async () => LAUNCH_CONFIG.chain.genesis;
  connection.getMultipleAccountsInfoAndContext = async keys => ({ context: { slot: 1 }, value: keys.map(k => accounts.get(k.toBase58()) ?? null) });
  connection.getAccountInfo = async key => accounts.get(key.toBase58()) ?? null;
  connection.getLatestBlockhash = async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 });
  return { connection, accounts, coder, global, owner };
}
