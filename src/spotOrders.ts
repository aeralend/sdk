import {
  BorshAccountsCoder,
  BorshInstructionCoder,
  type Idl,
} from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  unpackMint,
} from "@solana/spl-token";
import { COOKIEBOX_IDL } from "./cookiebox-idl.js";
import { EXCHANGE_ASSETS } from "./exchange.js";
import { LAUNCH } from "./launch.generated.js";
export const SPOT_ORDER_PROGRAM = new PublicKey(COOKIEBOX_IDL.address);
const coder = new BorshInstructionCoder(COOKIEBOX_IDL as Idl),
  accounts = new BorshAccountsCoder(COOKIEBOX_IDL as Idl);
const feeAddress = PublicKey.findProgramAddressSync(
  [Buffer.from("fee")],
  SPOT_ORDER_PROGRAM,
)[0];
const reserveAddress = (order: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("reserve"), order.toBuffer()],
    SPOT_ORDER_PROGRAM,
  )[0];
const bn = (n: bigint | number) => new BN(n.toString());
const integer = (n: bigint) => {
  if (n <= 0n || n > (1n << 64n) - 1n)
    throw Error("Order amount is outside the supported range.");
};
function asset(mint: string) {
  const a = EXCHANGE_ASSETS.find((a) => a.mint === mint);
  if (!a) throw Error("Unsupported order asset.");
  return {
    ...a,
    key: new PublicKey(mint),
    tokenProgram: new PublicKey(a.program),
  };
}
async function chain(connection: Connection) {
  if ((await connection.getGenesisHash()) !== LAUNCH.chain.genesis)
    throw Error("Wrong chain.");
}
export async function readSpotFees(connection: Connection) {
  const info = await connection.getAccountInfo(feeAddress, "confirmed");
  if (!info?.owner.equals(SPOT_ORDER_PROGRAM))
    throw Error("Cookiebox fee configuration is unavailable.");
  const fee = accounts.decode("Fee", info.data),
    makerFeeBps = Number(fee.maker_fee.toString());
  if (
    !Number.isSafeInteger(makerFeeBps) ||
    makerFeeBps < 0 ||
    makerFeeBps >= 10000
  )
    throw Error("Cookiebox maker fee is unsupported.");
  return { makerFeeBps, aeraFeeBps: 0 as const };
}
export interface SpotOrder {
  address: string;
  inputMint: string;
  outputMint: string;
  makingAmount: string;
  takingAmount: string;
  originalInput: string;
  originalOutput: string;
  triggerOutput: string;
  kind: "limit" | "stop";
  expiresAt: number | null;
  createdAt: number;
  waiting: boolean;
  refund: string;
  reserve: string;
  maker: string;
  base: string;
}
function decodeOrder(address: PublicKey, data: Buffer): SpotOrder | null {
  const o = accounts.decode("Order", data);
  if (o.kind !== 0 && o.kind !== 1) return null;
  const result: SpotOrder = {
    address: address.toBase58(),
    inputMint: o.input_mint.toBase58(),
    outputMint: o.output_mint.toBase58(),
    makingAmount: o.making_amount.toString(),
    takingAmount: o.taking_amount.toString(),
    originalInput: o.ori_making_amount.toString(),
    originalOutput: o.ori_taking_amount.toString(),
    triggerOutput: o.trigger_taking_amount.toString(),
    kind: o.kind === 0 ? "limit" : "stop",
    expiresAt: o.expired_at === null ? null : Number(o.expired_at.toString()),
    createdAt: Number(o.created_at.toString()),
    waiting: o.waiting,
    refund: o.maker_input_account.toBase58(),
    reserve: o.reserve.toBase58(),
    maker: o.maker.toBase58(),
    base: o.base.toBase58(),
  };
  const derived = PublicKey.findProgramAddressSync(
    [Buffer.from("order"), o.base.toBuffer()],
    SPOT_ORDER_PROGRAM,
  )[0];
  if (!derived.equals(address) || !reserveAddress(address).equals(o.reserve))
    throw Error("Order account identity changed.");
  return result;
}
export async function readSpotOrders(
  connection: Connection,
  owner: PublicKey,
): Promise<SpotOrder[]> {
  await chain(connection);
  const rows = await connection.getProgramAccounts(SPOT_ORDER_PROGRAM, {
    commitment: "confirmed",
    filters: [{ memcmp: { offset: 8, bytes: owner.toBase58() } }],
  });
  return rows
    .map((r) => decodeOrder(r.pubkey, r.account.data))
    .filter((o): o is SpotOrder => o !== null && o.maker === owner.toBase58())
    .sort((a, b) => b.createdAt - a.createdAt);
}
export interface SpotOrderRequest {
  inputMint: string;
  outputMint: string;
  makingAmount: bigint;
  takingAmount: bigint;
  triggerOutput: bigint;
  kind: "limit" | "stop";
  lifetimeSeconds: number;
}
export function validateSpotRequest(request: SpotOrderRequest) {
  integer(request.makingAmount);
  integer(request.takingAmount);
  if (request.inputMint === request.outputMint)
    throw Error("Choose two different assets.");
  asset(request.inputMint);
  asset(request.outputMint);
  if (request.kind !== "limit" && request.kind !== "stop")
    throw Error("Invalid order type.");
  if (request.kind === "limit" && request.triggerOutput !== 0n)
    throw Error("Limit orders cannot carry a stop trigger.");
  if (request.kind === "stop") {
    integer(request.triggerOutput);
    if (request.triggerOutput < request.takingAmount)
      throw Error("The stop trigger must be at least the execution floor.");
  }
  if (
    !Number.isInteger(request.lifetimeSeconds) ||
    request.lifetimeSeconds < 3600 ||
    request.lifetimeSeconds > 30 * 86400
  )
    throw Error("Choose an order lifetime between one hour and 30 days.");
}
/** Built locally from the published IDL; no aggregator-supplied transaction or signer. */
export async function prepareSpotOrder(
  connection: Connection,
  owner: PublicKey,
  request: SpotOrderRequest,
) {
  validateSpotRequest(request);
  await chain(connection);
  const input = asset(request.inputMint),
    output = asset(request.outputMint);
  const [fees, inputInfo, outputInfo] = await Promise.all([
    readSpotFees(connection),
    connection.getAccountInfo(input.key),
    connection.getAccountInfo(output.key),
  ]);
  if (
    unpackMint(input.key, inputInfo, input.tokenProgram).decimals !== 9 ||
    unpackMint(output.key, outputInfo, output.tokenProgram).decimals !== 9
  )
    throw Error("Token identity changed.");
  const base = Keypair.generate(),
    order = PublicKey.findProgramAddressSync(
      [Buffer.from("order"), base.publicKey.toBuffer()],
      SPOT_ORDER_PROGRAM,
    )[0],
    reserve = reserveAddress(order);
  const inputAta = getAssociatedTokenAddressSync(
      input.key,
      owner,
      false,
      input.tokenProgram,
    ),
    outputAta = getAssociatedTokenAddressSync(
      output.key,
      owner,
      false,
      output.tokenProgram,
    );
  const tx = new Transaction(),
    nativeInput = input.key.equals(NATIVE_MINT),
    nativeOutput = output.key.equals(NATIVE_MINT);
  if (nativeInput)
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        inputAta,
        owner,
        input.key,
        input.tokenProgram,
      ),
      SystemProgram.transfer({
        fromPubkey: owner,
        toPubkey: inputAta,
        lamports: request.makingAmount,
      }),
      createSyncNativeInstruction(inputAta, input.tokenProgram),
    );
  if (!nativeOutput)
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        outputAta,
        owner,
        output.key,
        output.tokenProgram,
      ),
    );
  const expiredAt = Math.floor(Date.now() / 1000) + request.lifetimeSeconds;
  const data = coder.encode("initialize_order", {
    making_amount: bn(request.makingAmount),
    taking_amount: bn(request.takingAmount),
    expired_at: bn(expiredAt),
    kind: request.kind === "limit" ? 0 : 1,
    refund_native: nativeInput,
    trigger_taking_amount: bn(request.triggerOutput),
  });
  const key = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({
    pubkey,
    isWritable,
    isSigner,
  });
  tx.add(
    new TransactionInstruction({
      programId: SPOT_ORDER_PROGRAM,
      data,
      keys: [
        key(base.publicKey, false, true),
        key(owner, true, true),
        key(order, true),
        key(reserve, true),
        key(inputAta, true),
        key(nativeOutput ? owner : outputAta),
        key(input.key),
        key(output.key),
        key(input.tokenProgram),
        key(output.tokenProgram),
        key(SystemProgram.programId),
        key(SPOT_ORDER_PROGRAM),
      ],
    }),
  );
  const block = await connection.getLatestBlockhash("confirmed");
  tx.feePayer = owner;
  tx.recentBlockhash = block.blockhash;
  tx.partialSign(base);
  return {
    transaction: tx,
    block,
    quote: {
      ...fees,
      order: order.toBase58(),
      inputAmount: request.makingAmount.toString(),
      grossOutput: request.takingAmount.toString(),
      netOutput: (
        request.takingAmount -
        (request.takingAmount * BigInt(fees.makerFeeBps)) / 10000n
      ).toString(),
      triggerOutput: request.triggerOutput.toString(),
      expiredAt,
      expiresAt: Date.now() + 45000,
      kind: request.kind,
    },
  };
}
export async function prepareCancelSpotOrder(
  connection: Connection,
  owner: PublicKey,
  address: string,
) {
  await chain(connection);
  const orderKey = new PublicKey(address),
    info = await connection.getAccountInfo(orderKey, "confirmed");
  if (!info?.owner.equals(SPOT_ORDER_PROGRAM))
    throw Error("Order no longer exists. Refresh open orders.");
  const order = decodeOrder(orderKey, info.data);
  if (!order || order.maker !== owner.toBase58() || order.waiting)
    throw Error("This order cannot be cancelled by this wallet now.");
  const input = asset(order.inputMint),
    refund = new PublicKey(order.refund),
    ata = getAssociatedTokenAddressSync(
      input.key,
      owner,
      false,
      input.tokenProgram,
    );
  if (
    !refund.equals(ata) &&
    !(input.key.equals(NATIVE_MINT) && refund.equals(owner))
  )
    throw Error("Unexpected refund destination.");
  const tx = new Transaction();
  if (refund.equals(ata))
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        ata,
        owner,
        input.key,
        input.tokenProgram,
      ),
    );
  tx.add(
    new TransactionInstruction({
      programId: SPOT_ORDER_PROGRAM,
      data: coder.encode("cancel_order", {}),
      keys: [
        { pubkey: orderKey, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: reserveAddress(orderKey), isSigner: false, isWritable: true },
        { pubkey: refund, isSigner: false, isWritable: true },
        { pubkey: input.key, isSigner: false, isWritable: false },
        { pubkey: input.tokenProgram, isSigner: false, isWritable: false },
      ],
    }),
  );
  return {
    transaction: tx,
    quote: {
      order: address,
      refundAmount: order.makingAmount,
      inputMint: order.inputMint,
      expiresAt: Date.now() + 45000,
    },
  };
}
