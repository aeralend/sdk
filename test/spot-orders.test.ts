import { test } from "node:test";
import assert from "node:assert/strict";
import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import BN from "bn.js";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { COOKIEBOX_IDL } from "../src/cookiebox-idl.js";
import {
  SPOT_ORDER_PROGRAM,
  prepareCancelSpotOrder,
  readSpotFees,
  validateSpotRequest,
} from "../src/spotOrders.js";
const sol = "6tL24Fn75uCMrBSZAvohAq57LSv6KrY6ceEq1wonvucb",
  cook = "So11111111111111111111111111111111111111112";
const request = {
  inputMint: sol,
  outputMint: cook,
  makingAmount: 1n,
  takingAmount: 10n,
  triggerOutput: 0n,
  kind: "limit" as const,
  lifetimeSeconds: 3600,
};
test("spot orders reject overflow, same asset, wrong stop floor and unbounded lifetimes", () => {
  assert.doesNotThrow(() => validateSpotRequest(request));
  for (const change of [
    { makingAmount: 0n },
    { makingAmount: 1n << 64n },
    { outputMint: sol },
    { triggerOutput: 1n },
    { lifetimeSeconds: 0 },
    { lifetimeSeconds: 31536000 },
    { kind: "stop" as const, triggerOutput: 9n },
  ])
    assert.throws(() => validateSpotRequest({ ...request, ...change }));
  assert.doesNotThrow(() =>
    validateSpotRequest({ ...request, kind: "stop", triggerOutput: 11n }),
  );
});
test("cancellation verifies maker, refund address, program owner and order PDA from on-chain state", async () => {
  const coder = new BorshAccountsCoder(COOKIEBOX_IDL as Idl),
    owner = Keypair.generate().publicKey,
    base = Keypair.generate().publicKey;
  const order = PublicKey.findProgramAddressSync(
      [Buffer.from("order"), base.toBuffer()],
      SPOT_ORDER_PROGRAM,
    )[0],
    reserve = PublicKey.findProgramAddressSync(
      [Buffer.from("reserve"), order.toBuffer()],
      SPOT_ORDER_PROGRAM,
    )[0];
  const state = {
    maker: owner,
    input_mint: new PublicKey(sol),
    output_mint: new PublicKey(cook),
    waiting: false,
    ori_making_amount: new BN(100),
    ori_taking_amount: new BN(200),
    making_amount: new BN(100),
    taking_amount: new BN(200),
    maker_input_account: getAssociatedTokenAddressSync(
      new PublicKey(sol),
      owner,
      false,
      TOKEN_2022_PROGRAM_ID,
    ),
    maker_output_account: owner,
    reserve,
    borrow_making_amount: new BN(0),
    expired_at: null,
    base,
    referral: null,
    kind: 0,
    created_at: new BN(100),
    trigger_taking_amount: new BN(0),
    curve_pool: PublicKey.default,
    curve_shares_before: new BN(0),
  };
  for (const failure of [
    "none",
    "maker",
    "refund",
    "pda",
    "program",
    "waiting",
  ]) {
    const copy = { ...state };
    if (failure === "maker") copy.maker = Keypair.generate().publicKey;
    if (failure === "refund")
      copy.maker_input_account = Keypair.generate().publicKey;
    if (failure === "pda") copy.base = Keypair.generate().publicKey;
    if (failure === "waiting") copy.waiting = true;
    const data = await coder.encode("Order", copy),
      connection = new Connection("http://localhost:8899");
    connection.getGenesisHash = async () =>
      "9wDaBRDgArEUpvhHxGguNkwozsZh4UpGZB9o2EoEcBB2";
    connection.getAccountInfo = async () => ({
      data,
      owner:
        failure === "program" ? SystemProgram.programId : SPOT_ORDER_PROGRAM,
      lamports: 1,
      executable: false,
      rentEpoch: 1,
    });
    if (failure === "none") {
      const tx = await prepareCancelSpotOrder(
        connection,
        owner,
        order.toBase58(),
      );
      assert.equal(tx.quote.refundAmount, "100");
      assert.ok(
        tx.transaction.instructions
          .at(-1)!
          .keys[3]!.pubkey.equals(state.maker_input_account),
      );
    } else
      await assert.rejects(
        prepareCancelSpotOrder(connection, owner, order.toBase58()),
        Error,
        failure,
      );
  }
});
test("maker fee is read from the owned on-chain singleton", async () => {
  const coder = new BorshAccountsCoder(COOKIEBOX_IDL as Idl),
    connection = new Connection("http://localhost:8899");
  const data = await coder.encode("Fee", {
    maker_fee: new BN(20),
    maker_stable_fee: new BN(3),
    taker_fee: new BN(0),
    taker_stable_fee: new BN(0),
  });
  connection.getAccountInfo = async () => ({
    data,
    owner: SPOT_ORDER_PROGRAM,
    lamports: 1,
    executable: false,
    rentEpoch: 1,
  });
  assert.deepEqual(await readSpotFees(connection), {
    makerFeeBps: 20,
    aeraFeeBps: 0,
  });
  connection.getAccountInfo = async () => ({
    data,
    owner: SystemProgram.programId,
    lamports: 1,
    executable: false,
    rentEpoch: 1,
  });
  await assert.rejects(readSpotFees(connection));
});
