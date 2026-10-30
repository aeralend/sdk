import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
} from "@solana/spl-token";
import {
  validateSwapInstructions,
  prepareExchangeTransaction,
  assertQuoteMatchesRequest,
  EXCHANGE_ASSETS,
  type SwapQuote,
  type SwapRequest,
} from "../src/exchange.js";
import {
  assessSpend,
  minOutFloor,
  spendBudget,
  type AccountState,
} from "../src/swapGuard.js";
import { LAUNCH } from "../src/launch.generated.js";
const NATIVE = "So11111111111111111111111111111111111111112";
import { withStakingMinimum } from "../src/staking.js";
import { STAKE_POOL_PROGRAM_ID } from "../src/stakePool.js";
function fixture() {
  const owner = Keypair.generate().publicKey,
    inputMint = new PublicKey(EXCHANGE_ASSETS[0].mint),
    outputMint = new PublicKey(EXCHANGE_ASSETS[1].mint);
  const source = getAssociatedTokenAddressSync(inputMint, owner),
    destination = getAssociatedTokenAddressSync(
      outputMint,
      owner,
      false,
      TOKEN_2022_PROGRAM_ID,
    );
  const keys = Array.from({ length: 14 }, () => ({
    pubkey: Keypair.generate().publicKey,
    isSigner: false,
    isWritable: true,
  }));
  keys[2] = { pubkey: source, isSigner: false, isWritable: true };
  keys[3] = { pubkey: destination, isSigner: false, isWritable: true };
  keys[6] = { pubkey: inputMint, isSigner: false, isWritable: false };
  keys[7] = { pubkey: outputMint, isSigner: false, isWritable: false };
  keys[8] = { pubkey: owner, isSigner: true, isWritable: false };
  const data = Buffer.alloc(24);
  Buffer.from("f8c69e91e17587c8", "hex").copy(data);
  data.writeBigUInt64LE(999n, 8);
  data.writeBigUInt64LE(500n, 16);
  const swap = new TransactionInstruction({
    programId: new PublicKey("DAMMjDCEFTDkt7ywazZS8GoaLtjb3HaJo3pLbf64xrPY"),
    keys,
    data,
  });
  const fee = createTransferCheckedInstruction(
    destination,
    outputMint,
    Keypair.generate().publicKey,
    owner,
    10n,
    9,
    [],
    TOKEN_2022_PROGRAM_ID,
  );
  const message = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [swap, fee],
  });
  const quote = {
    inputMint: inputMint.toBase58(),
    outputMint: outputMint.toBase58(),
    routeInput: "999",
    inputAmount: "1000",
    outputAmount: "492",
    minimumOutput: "490",
    aeraFee: "1",
    venueFee: "0",
    slippageBps: 0,
    aeraFeeBps: 10,
    expiresAt: Date.now() + 10000,
    hops: [{ venue: "cookiebox-damm", pool: "" }],
  };
  return { owner, swap, fee, message, quote };
}
const request = (q: SwapQuote): SwapRequest => ({
  inputMint: q.inputMint,
  outputMint: q.outputMint,
  amount: BigInt(q.inputAmount),
  slippageBps: q.slippageBps,
});
/** A chain stub that records how far prepareExchangeTransaction got. */
function chain(slot = 500) {
  const calls: string[] = [];
  let simulateConfig: any = null;
  const connection = {
    async getGenesisHash() {
      calls.push("genesis");
      return LAUNCH.chain.genesis;
    },
    async getAccountInfo() {
      calls.push("account");
      const data = Buffer.alloc(82);
      data[44] = 9;
      data[45] = 1;
      return { data, owner: TOKEN_PROGRAM_ID, lamports: 1, executable: false };
    },
    async getLatestBlockhash() {
      calls.push("blockhash");
      return {
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 1,
      };
    },
    async getMultipleAccountsInfoAndContext(keys: PublicKey[]) {
      calls.push("pre");
      return { context: { slot }, value: keys.map(() => null) };
    },
    async simulateTransaction(_tx: unknown, config: any) {
      calls.push("simulate");
      simulateConfig = config;
      return {
        context: { slot },
        value: { err: "AccountNotFound", logs: [], accounts: null },
      };
    },
  };
  return {
    connection: connection as unknown as Connection,
    calls,
    config: () => simulateConfig,
  };
}
/** A serialized DAMM-only swap spending 999 and promising `minOut` on chain. */
function damm(minOut: bigint) {
  const f = fixture();
  f.swap.data.writeBigUInt64LE(minOut, 16);
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: f.owner,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [f.swap],
    }).compileToV0Message(),
  );
  return { ...f, base64: Buffer.from(tx.serialize()).toString("base64") };
}
function tokenAccount(
  mint: PublicKey,
  owner: PublicKey,
  delegate: PublicKey | null,
  delegated: bigint,
): AccountState {
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data, 0);
  owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(1000n, 64);
  if (delegate) {
    data.writeUInt32LE(1, 72);
    delegate.toBuffer().copy(data, 76);
  }
  data[108] = 1;
  data.writeBigUInt64LE(delegated, 121);
  return { lamports: 2039280n, program: TOKEN_PROGRAM_ID.toBase58(), data };
}
function mintAccount(authority: PublicKey, freeze: PublicKey | null = null): AccountState {
  const data = Buffer.alloc(82);
  data.writeUInt32LE(1, 0);
  authority.toBuffer().copy(data, 4);
  data[44] = 9;
  data[45] = 1;
  if (freeze) {
    data.writeUInt32LE(1, 46);
    freeze.toBuffer().copy(data, 50);
  }
  return { lamports: 1461600n, program: TOKEN_PROGRAM_ID.toBase58(), data };
}
const systemWallet = (): AccountState => ({
  lamports: 1_000_000_000n,
  program: SystemProgram.programId.toBase58(),
  data: Buffer.alloc(0),
});
test("checks on-chain output after venue fees and refuses recipient, amount or minimum changes", () => {
  const valid = fixture();
  assert.doesNotThrow(() =>
    validateSwapInstructions(valid.message, valid.owner, valid.quote),
  );
  for (const fault of [
    "recipient",
    "amount",
    "minimum",
    "fee",
    "authority",
    "program",
  ]) {
    const f = fixture();
    if (fault === "recipient")
      f.swap.keys[3]!.pubkey = Keypair.generate().publicKey;
    if (fault === "amount") f.swap.data.writeBigUInt64LE(1000n, 8);
    if (fault === "minimum") f.swap.data.writeBigUInt64LE(499n, 16);
    if (fault === "fee") f.fee.data.writeBigUInt64LE(11n, 1);
    if (fault === "authority")
      f.fee.keys[3]!.pubkey = Keypair.generate().publicKey;
    if (fault === "program") f.swap.programId = Keypair.generate().publicKey;
    assert.throws(
      () => validateSwapInstructions(f.message, f.owner, f.quote),
      Error,
      fault,
    );
  }
});
test("staking minimum is encoded exactly and rejects wrong source instructions", () => {
  for (const direction of ["stake", "unstake"] as const) {
    const data = Buffer.alloc(9);
    data[0] = direction === "stake" ? 14 : 16;
    data.writeBigUInt64LE(123456n, 1);
    const ix = new TransactionInstruction({
      programId: STAKE_POOL_PROGRAM_ID,
      keys: [],
      data,
    });
    const checked = withStakingMinimum(ix, direction, 120000n);
    assert.equal(checked.data[0], direction === "stake" ? 25 : 26);
    assert.equal(checked.data.readBigUInt64LE(1), 123456n);
    assert.equal(checked.data.readBigUInt64LE(9), 120000n);
    assert.throws(() => withStakingMinimum(ix, direction, 0n));
    ix.programId = TOKEN_PROGRAM_ID;
    assert.throws(() => withStakingMinimum(ix, direction, 120000n));
  }
});
test("H1: a quote whose minimum collapsed to 1 is refused before simulating, even when the route matches it", async () => {
  const f = damm(1n);
  const quote = {
    ...f.quote,
    outputAmount: "100000",
    slippageBps: 50,
    minimumOutput: "1",
  };
  // The DAMM instruction honours the quote exactly; only the quote's own floor is wrong.
  assert.doesNotThrow(() =>
    validateSwapInstructions(
      TransactionMessage.decompile(
        VersionedTransaction.deserialize(Buffer.from(f.base64, "base64")).message,
      ),
      f.owner,
      quote,
    ),
  );
  const stub = chain();
  await assert.rejects(
    prepareExchangeTransaction(stub.connection, f.owner, f.base64, quote, request(quote)),
    /minimum output 3 is below the 99500/,
  );
  assert.ok(!stub.calls.includes("simulate"));
  // 100000 × 0.995 − 2 (one hop) = 99498 is the lowest minimum the slippage allows; it proceeds.
  const ok = damm(99498n);
  const fair = { ...quote, minimumOutput: "99498" };
  const reached = chain(500);
  await assert.rejects(
    prepareExchangeTransaction(reached.connection, ok.owner, ok.base64, fair, request(fair)),
    /Cookie Chain refused/,
  );
  assert.ok(reached.calls.includes("simulate"));
  // L4: the simulation may not run on a bank older than the pre-state it is compared against.
  assert.equal(reached.config().minContextSlot, 500);
  // Net of the venue fee: 99800 out + 200 fee → 99500 floor − 200 − 2 = 99298.
  const withFee = { ...fair, outputAmount: "99800", venueFee: "200", minimumOutput: "99297" };
  await assert.rejects(
    prepareExchangeTransaction(chain().connection, ok.owner, ok.base64, withFee, request(withFee)),
    /below the/,
  );
});
test("H2: a quote for another pair, amount or slippage than requested is refused", async () => {
  const { quote } = fixture();
  assert.doesNotThrow(() => assertQuoteMatchesRequest(quote, request(quote)));
  assert.doesNotThrow(() =>
    assertQuoteMatchesRequest(quote, { ...request(quote), amount: "1000" }),
  );
  const faults: Partial<SwapRequest>[] = [
    { inputMint: EXCHANGE_ASSETS[2].mint },
    { outputMint: EXCHANGE_ASSETS[2].mint },
    { amount: 1001n },
    { slippageBps: 100 },
  ];
  for (const fault of faults) {
    const label = Object.keys(fault)[0]!;
    assert.throws(
      () => assertQuoteMatchesRequest(quote, { ...request(quote), ...fault }),
      /does not match/,
      label,
    );
    const f = damm(490n);
    const stub = chain();
    await assert.rejects(
      prepareExchangeTransaction(stub.connection, f.owner, f.base64, f.quote, {
        ...request(f.quote),
        ...fault,
      }),
      /does not match/,
      label,
    );
    assert.deepEqual(stub.calls, []);
  }
});
test("L1: compute budget is limited to a CU limit up to 1.4M and a capped price", () => {
  const cases: [TransactionInstruction, boolean][] = [
    [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), true],
    [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 }), true],
    [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1e12 }), false],
    [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_001 }), false],
    [ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }), false],
  ];
  for (const [ix, allowed] of cases) {
    const f = fixture();
    f.message.instructions.unshift(ix);
    const run = () => validateSwapInstructions(f.message, f.owner, f.quote);
    if (allowed) assert.doesNotThrow(run);
    else assert.throws(run, /compute|priority/i);
  }
  const f = fixture();
  f.message.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
  );
  assert.throws(() => validateSwapInstructions(f.message, f.owner, f.quote), /Repeated/);
});
test("L2: a route may only create idempotent token accounts for the wallet or the named host-fee account", () => {
  const sol = new PublicKey(EXCHANGE_ASSETS[1].mint);
  const create = (owner: PublicKey, payer: PublicKey, idempotent = true) =>
    (idempotent
      ? createAssociatedTokenAccountIdempotentInstruction
      : createAssociatedTokenAccountInstruction)(
      payer,
      getAssociatedTokenAddressSync(sol, owner, true, TOKEN_2022_PROGRAM_ID),
      owner,
      sol,
      TOKEN_2022_PROGRAM_ID,
    );
  const ok = fixture();
  ok.message.instructions.unshift(create(ok.owner, ok.owner));
  assert.doesNotThrow(() => validateSwapInstructions(ok.message, ok.owner, ok.quote));
  const stranger = fixture();
  stranger.message.instructions.unshift(
    create(Keypair.generate().publicKey, stranger.owner),
  );
  assert.throws(
    () => validateSwapInstructions(stranger.message, stranger.owner, stranger.quote),
    /token-account creation/,
  );
  const plain = fixture();
  plain.message.instructions.unshift(create(plain.owner, plain.owner, false));
  assert.throws(
    () => validateSwapInstructions(plain.message, plain.owner, plain.quote),
    /token-account creation/,
  );
  // CPAMM host-fee case: a pool-mint ATA for another owner, named as the route's keys[14].
  const f = fixture();
  const poolMint = Keypair.generate().publicKey,
    host = Keypair.generate().publicKey,
    hostAccount = getAssociatedTokenAddressSync(poolMint, host, true);
  const keys = Array.from({ length: 15 }, () => ({
    pubkey: Keypair.generate().publicKey,
    isSigner: false,
    isWritable: true,
  }));
  keys[2] = { pubkey: f.owner, isSigner: true, isWritable: false };
  keys[3] = f.swap.keys[2]!;
  keys[6] = f.swap.keys[3]!;
  keys[7] = { pubkey: poolMint, isSigner: false, isWritable: true };
  keys[9] = f.swap.keys[6]!;
  keys[10] = f.swap.keys[7]!;
  keys[14] = { pubkey: hostAccount, isSigner: false, isWritable: true };
  const data = Buffer.alloc(17);
  data[0] = 1;
  data.writeBigUInt64LE(999n, 1);
  data.writeBigUInt64LE(500n, 9);
  const cpamm = new TransactionInstruction({
    programId: new PublicKey("xYBN2zddsqSy41tg1yD9nJScCmqquZnHUyzXBfLEqC8"),
    keys,
    data,
  });
  const hostCreate = createAssociatedTokenAccountIdempotentInstruction(
    f.owner,
    hostAccount,
    host,
    poolMint,
  );
  f.message.instructions.splice(0, 1, hostCreate, cpamm);
  assert.doesNotThrow(() => validateSwapInstructions(f.message, f.owner, f.quote));
  keys[14] = { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true };
  assert.throws(
    () => validateSwapInstructions(f.message, f.owner, f.quote),
    /token-account creation/,
  );
});
test("M7: moving an authority the wallet holds on a non-token account is refused", () => {
  const wallet = Keypair.generate().publicKey,
    other = Keypair.generate().publicKey,
    mint = Keypair.generate().publicKey.toBase58();
  const check = (before: AccountState | null, after: AccountState | null) =>
    assessSpend(
      wallet.toBase58(),
      new Map([[wallet.toBase58(), systemWallet()], [mint, before]]),
      new Map([[wallet.toBase58(), systemWallet()], [mint, after]]),
      spendBudget(NATIVE, 0n),
    );
  assert.equal(check(mintAccount(wallet), mintAccount(wallet)), null);
  assert.match(check(mintAccount(wallet), mintAccount(other)) ?? "", /mint authority/);
  assert.match(
    check(mintAccount(other, wallet), mintAccount(other, other)) ?? "",
    /freeze authority/,
  );
  // Authority dropped to None (the tag alone changes) is a change too.
  const dropped = mintAccount(wallet);
  dropped.data.writeUInt32LE(0, 0);
  assert.match(check(mintAccount(wallet), dropped) ?? "", /mint authority/);
  // Unknown layouts (nonce, lookup table, metadata): any field naming the wallet must keep it.
  const nonce = (authority: PublicKey): AccountState => {
    const data = Buffer.alloc(80);
    data.writeUInt32LE(1, 4);
    authority.toBuffer().copy(data, 8);
    return { lamports: 1447680n, program: SystemProgram.programId.toBase58(), data };
  };
  assert.equal(check(nonce(wallet), nonce(wallet)), null);
  assert.match(check(nonce(wallet), nonce(other)) ?? "", /authority this wallet holds/);
  assert.match(check(nonce(wallet), null) ?? "", /authority this wallet holds/);
  assert.equal(check(nonce(other), nonce(Keypair.generate().publicKey)), null);
});
test("L3: a larger allowance to an existing delegate is refused", () => {
  const wallet = Keypair.generate().publicKey,
    delegate = Keypair.generate().publicKey,
    mint = Keypair.generate().publicKey,
    account = Keypair.generate().publicKey.toBase58();
  const check = (before: bigint, after: bigint) =>
    assessSpend(
      wallet.toBase58(),
      new Map([
        [wallet.toBase58(), systemWallet()],
        [account, tokenAccount(mint, wallet, delegate, before)],
      ]),
      new Map([
        [wallet.toBase58(), systemWallet()],
        [account, tokenAccount(mint, wallet, delegate, after)],
      ]),
      spendBudget(NATIVE, 0n),
    );
  assert.equal(check(10n, 10n), null);
  assert.equal(check(10n, 5n), null);
  assert.match(check(10n, 1_000_000n) ?? "", /allowance/);
});
test("L4: minOutFloor accepts only whole slippage from 0 to 10000 bps", () => {
  assert.equal(minOutFloor(100000n, 50), 99500n);
  assert.equal(minOutFloor(100000n, 0), 100000n);
  assert.equal(minOutFloor(100000n, 10000), 0n);
  for (const bad of [-1, 10001, 1.5, Number.NaN])
    assert.throws(() => minOutFloor(100000n, bad), /slippage/);
});
test("L4: a simulation older than the pre-state read is refused", async () => {
  const f = damm(99498n);
  const quote = { ...f.quote, outputAmount: "100000", slippageBps: 50, minimumOutput: "99498" };
  const stale = chain(500);
  // Let the simulation succeed so the slot comparison is what decides.
  const conn = stale.connection as any;
  conn.simulateTransaction = async (_tx: unknown, config: any) => ({
    context: { slot: 499 },
    value: {
      err: null,
      logs: [],
      accounts: config.accounts.addresses.map(() => null),
    },
  });
  await assert.rejects(
    prepareExchangeTransaction(conn, f.owner, f.base64, quote, request(quote)),
    /simulated at slot 499, before the slot 500/,
  );
});
