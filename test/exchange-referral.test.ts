/**
 * Integrator referrals on Swap (docs/REFERRALS.md): 20% of Aera's 0.10% fee
 * goes to the referrer, inside the same transaction, out of Aera's fee only.
 * The user's total never changes; the referrer is paid only into an account
 * that already exists and can take the credit (no rent at the user's cost, no
 * way for a referrer's account to fail the swap); otherwise everything is
 * Aera's, exactly as without a referrer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Keypair,
  PublicKey,
  SystemInstruction,
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
} from "@solana/spl-token";
import {
  EXCHANGE_ASSETS,
  SWAP_REFERRAL_SHARE_BPS,
  payableReferralAccount,
  prepareExchangeTransaction,
  swapReferral,
  swapReferralShare,
  type SwapQuote,
} from "../src/exchange.js";
import { AERA_FEE_OWNER } from "../src/staking.js";
import { LAUNCH } from "../src/launch.generated.js";

const COOK = EXCHANGE_ASSETS[0];
const SOL = EXCHANGE_ASSETS[1];
const BCOOK = EXCHANGE_ASSETS[2];

function tokenData(mint: PublicKey, owner: PublicKey, extra: number[] = [], state = 1): Buffer {
  const d = Buffer.alloc(165);
  mint.toBuffer().copy(d, 0);
  owner.toBuffer().copy(d, 32);
  d[108] = state;
  return Buffer.concat([d, Buffer.from(extra)]);
}
const IMMUTABLE_OWNER = [2, 7, 0, 0, 0];
const MEMO_REQUIRED = [2, 7, 0, 0, 0, 8, 0, 1, 0, 1];

test("the referrer's share is 20% of Aera's fee, rounded down", () => {
  assert.equal(SWAP_REFERRAL_SHARE_BPS, 2000n);
  for (const [fee, share] of [[0n, 0n], [4n, 0n], [5n, 1n], [1_000n, 200n], [1_000_001n, 200_000n]] as const)
    assert.equal(swapReferralShare(fee), share);
  // 0.10% of the input, of which 0.02%.
  const input = 10_000_000_000n;
  const fee = (input * 10n + 9999n) / 10000n;
  assert.equal(swapReferralShare(fee), input / 5000n);
});

test("only an account that can take the credit is payable", () => {
  const referrer = Keypair.generate().publicKey;
  const mint = new PublicKey(SOL.mint);
  const ok = (data: Buffer, owner = TOKEN_2022_PROGRAM_ID, program = TOKEN_2022_PROGRAM_ID, m = mint) =>
    payableReferralAccount({ owner, data }, m, referrer, program);
  assert.equal(ok(tokenData(mint, referrer)), true, "a plain account");
  assert.equal(ok(tokenData(mint, referrer, IMMUTABLE_OWNER)), true, "an ATA (ImmutableOwner)");
  assert.equal(ok(tokenData(mint, referrer, MEMO_REQUIRED)), false, "incoming memos required");
  assert.equal(ok(tokenData(mint, referrer, IMMUTABLE_OWNER, 2)), false, "frozen");
  assert.equal(ok(tokenData(mint, Keypair.generate().publicKey)), false, "someone else's");
  assert.equal(ok(tokenData(new PublicKey(BCOOK.mint), referrer)), false, "another mint");
  assert.equal(ok(tokenData(mint, referrer), TOKEN_PROGRAM_ID), false, "another program");
  assert.equal(payableReferralAccount(null, mint, referrer, TOKEN_2022_PROGRAM_ID), false, "missing");
});

test("swapReferral: none, self, Aera, dust, missing accounts — and the payable cases", async () => {
  const owner = Keypair.generate().publicKey;
  const referrer = Keypair.generate().publicKey;
  const accounts = new Map<string, { owner: PublicKey; data: Buffer; lamports: number; executable: boolean }>();
  const connection = { async getAccountInfo(key: PublicKey) { return accounts.get(key.toBase58()) ?? null; } };
  assert.equal(await swapReferral(connection, owner, null, COOK, 1_000n), null);
  assert.equal(await swapReferral(connection, owner, owner, COOK, 1_000n), null, "no self-referral");
  assert.equal(await swapReferral(connection, owner, AERA_FEE_OWNER, COOK, 1_000n), null);
  // Native COOK: only an existing wallet (a new account would need rent).
  assert.equal(await swapReferral(connection, owner, referrer, COOK, 1_000n), null, "no such wallet yet");
  accounts.set(referrer.toBase58(), { owner: SystemProgram.programId, data: Buffer.alloc(0), lamports: 1, executable: false });
  assert.deepEqual(await swapReferral(connection, owner, referrer, COOK, 1_000n), { referrer, destination: referrer, amount: 200n });
  assert.equal(await swapReferral(connection, owner, referrer, COOK, 4n), null, "a share that rounds to zero");
  // A token: only the referrer's existing associated account.
  const ata = getAssociatedTokenAddressSync(new PublicKey(SOL.mint), referrer, true, TOKEN_2022_PROGRAM_ID);
  assert.equal(await swapReferral(connection, owner, referrer, SOL, 1_000n), null, "no SOL account");
  accounts.set(ata.toBase58(), { owner: TOKEN_2022_PROGRAM_ID, data: tokenData(new PublicKey(SOL.mint), referrer, MEMO_REQUIRED), lamports: 1, executable: false });
  assert.equal(await swapReferral(connection, owner, referrer, SOL, 1_000n), null, "memo-required");
  accounts.set(ata.toBase58(), { owner: TOKEN_2022_PROGRAM_ID, data: tokenData(new PublicKey(SOL.mint), referrer, IMMUTABLE_OWNER), lamports: 1, executable: false });
  assert.deepEqual(await swapReferral(connection, owner, referrer, SOL, 1_000n), { referrer, destination: ata, amount: 200n });
});

/** A direct DAMM route spending 999,000 of `input` for at least 499,998 of `output`. */
function route(input: (typeof EXCHANGE_ASSETS)[number], output: (typeof EXCHANGE_ASSETS)[number]) {
  const owner = Keypair.generate().publicKey;
  const inputMint = new PublicKey(input.mint),
    outputMint = new PublicKey(output.mint);
  const keys = Array.from({ length: 14 }, () => ({ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }));
  keys[2] = { pubkey: getAssociatedTokenAddressSync(inputMint, owner, false, new PublicKey(input.program)), isSigner: false, isWritable: true };
  keys[3] = { pubkey: getAssociatedTokenAddressSync(outputMint, owner, false, new PublicKey(output.program)), isSigner: false, isWritable: true };
  keys[6] = { pubkey: inputMint, isSigner: false, isWritable: false };
  keys[7] = { pubkey: outputMint, isSigner: false, isWritable: false };
  keys[8] = { pubkey: owner, isSigner: true, isWritable: false };
  const data = Buffer.alloc(24);
  Buffer.from("f8c69e91e17587c8", "hex").copy(data);
  data.writeBigUInt64LE(999_000n, 8);
  data.writeBigUInt64LE(499_998n, 16);
  const swap = new TransactionInstruction({ programId: new PublicKey("DAMMjDCEFTDkt7ywazZS8GoaLtjb3HaJo3pLbf64xrPY"), keys, data });
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [swap] }).compileToV0Message());
  const quote: SwapQuote = {
    inputMint: input.mint, outputMint: output.mint, inputAmount: "1000000", routeInput: "999000",
    outputAmount: "500000", minimumOutput: "499998", aeraFee: "1000", venueFee: "0", slippageBps: 0,
    aeraFeeBps: 10, expiresAt: Date.now() + 10_000, hops: [{ venue: "cookiebox-damm", pool: "" }],
  };
  return { owner, base64: Buffer.from(tx.serialize()).toString("base64"), quote };
}
/** A chain stub that hands back the transaction the SDK simulated (and then refuses it). */
function chain(accounts: Map<string, { owner: PublicKey; data: Buffer; lamports: number; executable: boolean }>) {
  let simulated: VersionedTransaction | null = null;
  const connection = {
    async getGenesisHash() { return LAUNCH.chain.genesis; },
    async getAccountInfo(key: PublicKey) {
      const a = accounts.get(key.toBase58());
      if (a) return a;
      const mint = Buffer.alloc(82);
      mint[44] = 9;
      mint[45] = 1;
      return EXCHANGE_ASSETS.some((x) => x.mint === key.toBase58()) ? { data: mint, owner: new PublicKey(EXCHANGE_ASSETS.find((x) => x.mint === key.toBase58())!.program), lamports: 1, executable: false } : null;
    },
    async getLatestBlockhash() { return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 }; },
    async getMultipleAccountsInfoAndContext(keys: PublicKey[]) { return { context: { slot: 1 }, value: keys.map(() => null) }; },
    async simulateTransaction(tx: VersionedTransaction) {
      simulated = tx;
      return { context: { slot: 1 }, value: { err: "stub", logs: [], accounts: null } };
    },
  };
  return { connection: connection as unknown as Connection, simulated: () => TransactionMessage.decompile(simulated!.message) };
}
const nativeFees = (m: TransactionMessage) =>
  m.instructions.filter((ix) => ix.programId.equals(SystemProgram.programId)).map((ix) => SystemInstruction.decodeTransfer(ix)).map((t) => [t.toPubkey.toBase58(), t.lamports] as const);
const tokenFees = (m: TransactionMessage, program: PublicKey) =>
  m.instructions.filter((ix) => ix.programId.equals(program) && ix.data[0] === 12).map((ix) => [ix.keys[2]!.pubkey.toBase58(), ix.data.readBigUInt64LE(1)] as const);

test("a native COOK swap splits Aera's fee 80/20 with an existing referrer wallet; the total is unchanged", async () => {
  const r = route(COOK, SOL);
  const referrer = Keypair.generate().publicKey;
  const accounts = new Map([[referrer.toBase58(), { owner: SystemProgram.programId, data: Buffer.alloc(0), lamports: 1_000_000, executable: false }]]);
  const req = { inputMint: r.quote.inputMint, outputMint: r.quote.outputMint, amount: 1_000_000n, slippageBps: 0 };
  // Without a referrer: one transfer of the whole fee to Aera.
  let c = chain(accounts);
  await assert.rejects(prepareExchangeTransaction(c.connection, r.owner, r.base64, r.quote, req), /Cookie Chain refused/);
  assert.deepEqual(nativeFees(c.simulated()), [[AERA_FEE_OWNER.toBase58(), 1000n]]);
  // With one: 800 to Aera, 200 to the referrer, 1,000 in all.
  c = chain(accounts);
  await assert.rejects(prepareExchangeTransaction(c.connection, r.owner, r.base64, r.quote, req, { referrer }), /Cookie Chain refused/);
  assert.deepEqual(nativeFees(c.simulated()), [[AERA_FEE_OWNER.toBase58(), 800n], [referrer.toBase58(), 200n]]);
  // A referrer wallet that does not exist yet: all of it to Aera, no rent asked of the user.
  c = chain(new Map());
  await assert.rejects(prepareExchangeTransaction(c.connection, r.owner, r.base64, r.quote, req, { referrer }), /Cookie Chain refused/);
  assert.deepEqual(nativeFees(c.simulated()), [[AERA_FEE_OWNER.toBase58(), 1000n]]);
});

test("a token swap pays the referrer only into its existing account, and never creates one", async () => {
  const r = route(BCOOK, COOK);
  const referrer = Keypair.generate().publicKey;
  const mint = new PublicKey(BCOOK.mint);
  const ata = getAssociatedTokenAddressSync(mint, referrer, true, TOKEN_PROGRAM_ID);
  const req = { inputMint: r.quote.inputMint, outputMint: r.quote.outputMint, amount: 1_000_000n, slippageBps: 0 };
  const aera = getAssociatedTokenAddressSync(mint, AERA_FEE_OWNER, false, TOKEN_PROGRAM_ID);
  let c = chain(new Map([[ata.toBase58(), { owner: TOKEN_PROGRAM_ID, data: tokenData(mint, referrer), lamports: 2_039_280, executable: false }]]));
  await assert.rejects(prepareExchangeTransaction(c.connection, r.owner, r.base64, r.quote, req, { referrer }), /Cookie Chain refused/);
  const m = c.simulated();
  assert.deepEqual(tokenFees(m, TOKEN_PROGRAM_ID), [[aera.toBase58(), 800n], [ata.toBase58(), 200n]]);
  // The only account the fee step may create is Aera's own, as before.
  const created = m.instructions.filter((ix) => ix.programId.toBase58() === "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL").map((ix) => ix.keys[1]!.pubkey.toBase58());
  assert.deepEqual(created, [aera.toBase58()]);
  // No referrer account: the fee is Aera's alone.
  c = chain(new Map());
  await assert.rejects(prepareExchangeTransaction(c.connection, r.owner, r.base64, r.quote, req, { referrer }), /Cookie Chain refused/);
  assert.deepEqual(tokenFees(c.simulated(), TOKEN_PROGRAM_ID), [[aera.toBase58(), 1000n]]);
});
