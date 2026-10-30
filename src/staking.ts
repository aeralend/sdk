import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  unpackMint,
} from "@solana/spl-token";
import { LAUNCH } from "./launch.generated.js";
import {
  BCOOK_STAKE_POOL,
  STAKE_POOL_PROGRAM_ID,
  decodeStakePool,
  depositSolIx,
  withdrawSolIx,
  poolTokensForDeposit,
  lamportsForWithdrawal,
  applyStakePoolFee,
  withdrawableLamports,
} from "./stakePool.js";

export const AERA_FEE_OWNER = new PublicKey(
  "22v7PjUXNu8t9JJhZYFhsS1TFgkqqTxJtq3ZQdy85CyR",
);
export type StakingDirection = "stake" | "unstake";
export interface StakingQuote {
  direction: StakingDirection;
  owner: string;
  input: string;
  output: string;
  minimumOutput: string;
  poolFeeBps: number;
  referralAmount: string;
  aeraFeeBps: 0;
  expiresAt: number;
  epoch: number;
}
/** The standard SPL instruction variants enforce the user's minimum ON CHAIN.
 * Never silently fall back to DepositSol/WithdrawSol when a deployment lacks them. */
export function withStakingMinimum(
  ix: TransactionInstruction,
  direction: StakingDirection,
  minimum: bigint,
) {
  if (
    (direction !== "stake" && direction !== "unstake") ||
    !ix.programId.equals(STAKE_POOL_PROGRAM_ID) ||
    ix.data.length !== 9 ||
    ix.data[0] !== (direction === "stake" ? 14 : 16)
  )
    throw Error("Unexpected staking instruction");
  if (minimum <= 0n || minimum > (1n << 64n) - 1n)
    throw Error("Invalid minimum received");
  const data = Buffer.alloc(17);
  data[0] = direction === "stake" ? 25 : 26;
  ix.data.copy(data, 1, 1, 9);
  data.writeBigUInt64LE(minimum, 9);
  return new TransactionInstruction({
    programId: ix.programId,
    keys: ix.keys,
    data,
  });
}
export async function prepareStaking(
  connection: Connection,
  owner: PublicKey,
  direction: StakingDirection,
  amount: bigint,
  slippageBps = 50,
): Promise<{ quote: StakingQuote; transaction: Transaction }> {
  if (direction !== "stake" && direction !== "unstake")
    throw Error("Invalid staking direction");
  if (
    amount <= 0n ||
    amount > (1n << 64n) - 1n ||
    !Number.isInteger(slippageBps) ||
    slippageBps < 1 ||
    slippageBps > 100
  )
    throw Error("Invalid staking amount or slippage");
  if ((await connection.getGenesisHash()) !== LAUNCH.chain.genesis)
    throw Error("Wrong chain");
  const account = await connection.getAccountInfo(
    BCOOK_STAKE_POOL,
    "confirmed",
  );
  if (!account?.owner.equals(STAKE_POOL_PROGRAM_ID))
    throw Error("Stake pool identity changed");
  const pool = decodeStakePool(BCOOK_STAKE_POOL, account.data, account.owner);
  if (
    pool.poolMint.toBase58() !== LAUNCH.chain.bcookMint ||
    !pool.tokenProgram.equals(TOKEN_PROGRAM_ID)
  )
    throw Error("Stake pool mint changed");
  const [epoch, reserve, mintInfo] = await Promise.all([
    connection.getEpochInfo("confirmed"),
    connection.getAccountInfo(pool.reserveStake, "confirmed"),
    connection.getAccountInfo(pool.poolMint, "confirmed"),
  ]);
  const mint = unpackMint(pool.poolMint, mintInfo, TOKEN_PROGRAM_ID);
  if (mint.decimals !== 9 || pool.lastUpdateEpoch !== BigInt(epoch.epoch))
    throw Error(
      "Staking pool is waiting for its epoch update. Try again shortly.",
    );
  const transaction = new Transaction();
  const destination = getAssociatedTokenAddressSync(
    pool.poolMint,
    owner,
    false,
    TOKEN_PROGRAM_ID,
  );
  const referral = getAssociatedTokenAddressSync(
    pool.poolMint,
    AERA_FEE_OWNER,
    false,
    TOKEN_PROGRAM_ID,
  );
  let output: bigint;
  let referralAmount = 0n;
  let instruction: TransactionInstruction;
  if (direction === "stake") {
    transaction.add(
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        destination,
        owner,
        pool.poolMint,
        TOKEN_PROGRAM_ID,
      ),
    );
    const minted = (amount * pool.poolTokenSupply) / pool.totalLamports;
    const fee = applyStakePoolFee(minted, pool.solDepositFee);
    referralAmount = (fee * BigInt(pool.solReferralFeePercent)) / 100n;
    output = poolTokensForDeposit(amount, pool) - referralAmount;
    instruction = depositSolIx({ pool, depositor: owner, lamports: amount });
    if (referralAmount > 0n) {
      transaction.add(
        createAssociatedTokenAccountIdempotentInstruction(
          owner,
          referral,
          AERA_FEE_OWNER,
          pool.poolMint,
          TOKEN_PROGRAM_ID,
        ),
      );
      instruction.keys[6] = {
        pubkey: referral,
        isSigner: false,
        isWritable: true,
      };
    }
  } else {
    output = lamportsForWithdrawal(amount, pool);
    if (!reserve || withdrawableLamports(reserve) < output)
      throw Error(
        "The staking reserve cannot redeem this amount now. Try a smaller amount.",
      );
    instruction = withdrawSolIx({ pool, owner, poolTokens: amount });
  }
  const minimum = (output * BigInt(10000 - slippageBps)) / 10000n;
  transaction.add(withStakingMinimum(instruction, direction, minimum));
  const fee =
    direction === "stake" ? pool.solDepositFee : pool.solWithdrawalFee;
  return {
    transaction,
    quote: {
      direction,
      owner: owner.toBase58(),
      input: amount.toString(),
      output: output.toString(),
      minimumOutput: minimum.toString(),
      poolFeeBps:
        fee.denominator === 0n
          ? 0
          : Number(
              (fee.numerator * 10000n + fee.denominator - 1n) / fee.denominator,
            ),
      referralAmount: referralAmount.toString(),
      aeraFeeBps: 0,
      expiresAt: Date.now() + 45_000,
      epoch: epoch.epoch,
    },
  };
}
