/** Finalized Solana inventory reader for strategy due diligence. This is RPC
 * evidence, not an on-chain authenticated NAV report or proof of custody policy.
 * The owner is supplied explicitly; no current aSOL backing enters this view.
 */
import { PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY, type Connection } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, unpackAccount, unpackMint } from '@solana/spl-token';
import { decodeStakePool, lamportsForWithdrawal } from './stakePool.js';
import { SOLANA_MAINNET_GENESIS } from './strategyBridge.js';
export const JITO_STRATEGY_POOL = new PublicKey('Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb');
export const JITO_STRATEGY_MINT = new PublicKey('J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn');
export const JITO_STRATEGY_PROGRAM = new PublicKey('SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy');
export interface SolanaStrategyInventory {owner: string; genesis: string; slot: string; epoch: string; observedAt: string;
  nativeLamports: string; reservedOperatorGas: string; claimableNativeLamports: string; jitoTokens: string;
  jitoNetRedemptionClaim: string; conservativeNav: string; immediateCash: string; custodyPolicyVerified: false}
export async function readSolanaStrategyInventory(connection: Connection, owner: PublicKey, reservedOperatorGas: bigint): Promise<SolanaStrategyInventory> {
  if (reservedOperatorGas < 0n || reservedOperatorGas > (1n << 64n) - 1n) throw Error('Invalid operator gas reserve');
  if (await connection.getGenesisHash() !== SOLANA_MAINNET_GENESIS) throw Error('Wrong Solana inventory chain');
  const ata = getAssociatedTokenAddressSync(JITO_STRATEGY_MINT, owner, true, TOKEN_PROGRAM_ID);
  const result = await connection.getMultipleAccountsInfoAndContext([owner, ata, JITO_STRATEGY_POOL, JITO_STRATEGY_MINT, SYSVAR_CLOCK_PUBKEY], {commitment: 'finalized'});
  const [native, token, poolAccount, mintAccount, clock] = result.value;
  if (!poolAccount?.owner.equals(JITO_STRATEGY_PROGRAM) || !mintAccount?.owner.equals(TOKEN_PROGRAM_ID) ||
    !clock || clock.data.length < 40 || clock.owner.toBase58() !== 'Sysvar1111111111111111111111111111111111111') throw Error('Invalid finalized Jito inventory accounts');
  const pool = decodeStakePool(JITO_STRATEGY_POOL, poolAccount.data, JITO_STRATEGY_PROGRAM);
  const epoch = clock.data.readBigUInt64LE(16);
  const clockAge = BigInt(Math.floor(Date.now() / 1000)) - clock.data.readBigInt64LE(32);
  if (clockAge < -30n || clockAge > 120n || BigInt(result.context.slot) < clock.data.readBigUInt64LE(0)) throw Error('Finalized inventory checkpoint is stale');
  if (!pool.poolMint.equals(JITO_STRATEGY_MINT) || !pool.tokenProgram.equals(TOKEN_PROGRAM_ID) || pool.lastUpdateEpoch !== epoch || pool.solWithdrawAuthority) throw Error('Jito pool is stale or restricted');
  const mint = unpackMint(JITO_STRATEGY_MINT, mintAccount, TOKEN_PROGRAM_ID);
  if (!mint.isInitialized || mint.freezeAuthority || !mint.mintAuthority?.equals(pool.withdrawAuthority) || mint.supply > pool.poolTokenSupply || mint.decimals !== 9) throw Error('Invalid Jito mint');
  if (native && (!native.owner.equals(SystemProgram.programId) || native.executable || native.data.length !== 0 || !Number.isSafeInteger(native.lamports))) throw Error('Custody cash is not a native SOL balance');
  let jitoTokens = 0n;
  if (token) { const t = unpackAccount(ata, token, TOKEN_PROGRAM_ID);
    if (!t.owner.equals(owner) || !t.mint.equals(JITO_STRATEGY_MINT) || t.isFrozen || t.delegate) throw Error('Invalid Jito custody account'); jitoTokens = t.amount; }
  const nativeLamports = BigInt(native?.lamports ?? 0), claimable = nativeLamports > reservedOperatorGas ? nativeLamports - reservedOperatorGas : 0n;
  // A scheduled fee increase is included in the conservative queue valuation.
  const currentClaim = lamportsForWithdrawal(jitoTokens, pool), futureClaim = pool.nextSolWithdrawalFee
    ? lamportsForWithdrawal(jitoTokens, {...pool, solWithdrawalFee: pool.nextSolWithdrawalFee}) : currentClaim;
  const netClaim = currentClaim < futureClaim ? currentClaim : futureClaim;
  return {owner: owner.toBase58(), genesis: SOLANA_MAINNET_GENESIS, slot: String(result.context.slot), epoch: epoch.toString(), observedAt: new Date().toISOString(),
    nativeLamports: nativeLamports.toString(), reservedOperatorGas: reservedOperatorGas.toString(), claimableNativeLamports: claimable.toString(),
    jitoTokens: jitoTokens.toString(), jitoNetRedemptionClaim: netClaim.toString(), conservativeNav: (claimable + netClaim).toString(),
    immediateCash: claimable.toString(), custodyPolicyVerified: false};
}
