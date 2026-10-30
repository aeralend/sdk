import {
  Connection,
  PublicKey,
  SystemProgram,
  SystemInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  unpackMint,
} from "@solana/spl-token";
import { AERA_FEE_OWNER } from "./staking.js";
import { LAUNCH } from "./launch.generated.js";
import {
  assertQuotedMinimum,
  simulateWithinBudget,
  spendBudget,
} from "./swapGuard.js";
export const EXCHANGE_ASSETS = [
  {
    symbol: "COOK",
    mint: LAUNCH.chain.cookMint,
    decimals: 9,
    program: TOKEN_PROGRAM_ID.toBase58(),
    icon: "/tokens/cook.png",
  },
  {
    symbol: "SOL",
    mint: "6tL24Fn75uCMrBSZAvohAq57LSv6KrY6ceEq1wonvucb",
    decimals: 9,
    program: TOKEN_2022_PROGRAM_ID.toBase58(),
    icon: "/tokens/sol.svg",
  },
  {
    symbol: "bCOOK",
    mint: LAUNCH.chain.bcookMint,
    decimals: 9,
    program: TOKEN_PROGRAM_ID.toBase58(),
    icon: "/tokens/bcook.png",
  },
] as const;
export interface SwapQuote {
  inputMint: string;
  outputMint: string;
  inputAmount: string;
  routeInput: string;
  /** Expected output, net of the venue fee. */
  outputAmount: string;
  minimumOutput: string;
  aeraFee: string;
  /** Venue fee taken from the output. */
  venueFee: string;
  slippageBps: number;
  expiresAt: number;
  aeraFeeBps: number;
  hops: readonly unknown[];
}
/** What the user asked for; a quote must answer exactly this. */
export interface SwapRequest {
  inputMint: string;
  outputMint: string;
  /** Raw input amount in base units, Aera fee included. */
  amount: bigint | string;
  slippageBps: number;
}
/** Refuse a quote for another pair, amount or slippage than the user selected (pure). */
export function assertQuoteMatchesRequest(
  quote: Pick<SwapQuote, "inputMint" | "outputMint" | "inputAmount" | "slippageBps">,
  request: SwapRequest,
) {
  if (
    quote.inputMint !== request.inputMint ||
    quote.outputMint !== request.outputMint ||
    quote.inputAmount !== request.amount.toString() ||
    quote.slippageBps !== request.slippageBps
  )
    throw Error(
      "The quote does not match the pair, amount or slippage you chose. Refresh it.",
    );
}
/** Per-hop rounding allowance the API subtracts from its minimum (2 base units per hop). */
const HOP_ALLOWANCE = 2n;
/**
 * Refuse a quote whose minimum is below `slippageBps` of its own expected output, after the venue
 * fee and the per-hop allowance — the same floor the API computes (pure).
 */
export function assertSwapQuoteMinimum(
  quote: Pick<
    SwapQuote,
    "outputAmount" | "venueFee" | "minimumOutput" | "slippageBps" | "hops"
  >,
) {
  if (quote.hops.length < 1 || quote.hops.length > 8)
    throw Error("Unsupported route.");
  const venueFee = BigInt(quote.venueFee),
    allowance = HOP_ALLOWANCE * BigInt(quote.hops.length),
    minimum = BigInt(quote.minimumOutput);
  if (minimum <= 0n || minimum > BigInt(quote.outputAmount))
    throw Error("Quote minimum is outside its expected output.");
  assertQuotedMinimum(
    {
      totalOutAmount: (BigInt(quote.outputAmount) + venueFee).toString(),
      minOutAmount: (minimum + venueFee + allowance).toString(),
    },
    quote.slippageBps,
    "swap",
  );
}
const DAMM = "DAMMjDCEFTDkt7ywazZS8GoaLtjb3HaJo3pLbf64xrPY",
  XYBN = "xYBN2zddsqSy41tg1yD9nJScCmqquZnHUyzXBfLEqC8",
  COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
/** The runtime's per-transaction compute ceiling. */
export const MAX_SWAP_COMPUTE_UNITS = 1_400_000;
/** Priority price cap: 1 lamport per CU, so at most 0.0014 COOK of priority fee per swap. */
export const MAX_SWAP_MICRO_LAMPORTS = 1_000_000n;
const SUPPORT = new Set([
  DAMM,
  XYBN,
  SystemProgram.programId.toBase58(),
  TOKEN_PROGRAM_ID.toBase58(),
  TOKEN_2022_PROGRAM_ID.toBase58(),
  ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
  COMPUTE_BUDGET,
]);
/** Check the economic instruction fields, not only the API's quote JSON.
 * Currently supports direct DAMM/CPAMM routes. Other venues fail before signing. */
export function validateSwapInstructions(
  message: TransactionMessage,
  owner: PublicKey,
  quote: SwapQuote,
) {
  let input = 0n,
    minimum = 0n,
    outputFees = 0n;
  const owned = new Map<string, string>();
  const temporary = new Set<string>();
  for (const asset of EXCHANGE_ASSETS)
    owned.set(
      getAssociatedTokenAddressSync(
        new PublicKey(asset.mint),
        owner,
        false,
        new PublicKey(asset.program),
      ).toBase58(),
      asset.mint,
    );
  // Register only native temporary accounts explicitly initialized for this wallet.
  for (const ix of message.instructions) {
    if (ix.programId.equals(TOKEN_PROGRAM_ID) && ix.data[0] === 18) {
      if (
        ix.data.length !== 33 ||
        !new PublicKey(ix.data.subarray(1)).equals(owner) ||
        !ix.keys[1]?.pubkey.equals(NATIVE_MINT)
      )
        throw Error("Unexpected temporary token account.");
      const address = ix.keys[0]!.pubkey.toBase58();
      owned.set(address, NATIVE_MINT.toBase58());
      temporary.add(address);
    }
  }
  const budgetSeen = new Set<number>();
  for (const ix of message.instructions) {
    const pid = ix.programId.toBase58();
    if (!SUPPORT.has(pid))
      throw Error(
        "This route uses a venue that Aera has not verified yet. Choose another route.",
      );
    if (pid === COMPUTE_BUDGET) {
      // Only a compute-unit limit and a capped price, each at most once.
      const tag = ix.data[0] ?? -1;
      if (budgetSeen.has(tag)) throw Error("Repeated compute budget instruction.");
      budgetSeen.add(tag);
      if (tag === 2 && ix.data.length === 5) {
        if (ix.data.readUInt32LE(1) > MAX_SWAP_COMPUTE_UNITS)
          throw Error("Route asks for more compute than a transaction allows.");
      } else if (tag === 3 && ix.data.length === 9) {
        if (ix.data.readBigUInt64LE(1) > MAX_SWAP_MICRO_LAMPORTS)
          throw Error("Route sets an excessive priority fee.");
      } else throw Error("Unsupported compute budget instruction.");
      continue;
    }
    if (ix.programId.equals(SystemProgram.programId)) {
      const kind = SystemInstruction.decodeInstructionType(ix);
      if (kind === "CreateWithSeed") {
        const p = SystemInstruction.decodeCreateWithSeed(ix);
        if (
          !p.fromPubkey.equals(owner) ||
          !p.basePubkey.equals(owner) ||
          !temporary.has(p.newAccountPubkey.toBase58()) ||
          !p.programId.equals(TOKEN_PROGRAM_ID) ||
          p.space !== 165
        )
          throw Error("Unexpected account creation.");
      } else if (kind === "Transfer") {
        const p = SystemInstruction.decodeTransfer(ix);
        if (!p.fromPubkey.equals(owner))
          throw Error("Unexpected native transfer.");
        if (!owned.has(p.toPubkey.toBase58())) {
          if (quote.outputMint !== NATIVE_MINT.toBase58())
            throw Error("Unexpected native fee.");
          outputFees += BigInt(p.lamports);
        }
      } else throw Error("Unsupported system instruction.");
    }
    if (
      pid === TOKEN_PROGRAM_ID.toBase58() ||
      pid === TOKEN_2022_PROGRAM_ID.toBase58()
    ) {
      const tag = ix.data[0],
        source = ix.keys[0]?.pubkey.toBase58();
      if (tag === 3 || tag === 12) {
        const mint =
          tag === 12 ? ix.keys[1]?.pubkey.toBase58() : owned.get(source ?? "");
        const authority = ix.keys[tag === 12 ? 3 : 2]?.pubkey;
        if (
          ix.data.length !== (tag === 12 ? 10 : 9) ||
          !authority?.equals(owner) ||
          mint !== quote.outputMint ||
          owned.get(source ?? "") !== mint ||
          (tag === 12 && ix.data[9] !== 9)
        )
          throw Error("Unexpected token transfer.");
        outputFees += ix.data.readBigUInt64LE(1);
      } else if (tag === 9) {
        if (
          owned.get(source ?? "") !== NATIVE_MINT.toBase58() ||
          !ix.keys[1]?.pubkey.equals(owner) ||
          !ix.keys[2]?.pubkey.equals(owner)
        )
          throw Error("Unexpected account closure.");
      } else if (tag === 17) {
        if (owned.get(source ?? "") !== NATIVE_MINT.toBase58())
          throw Error("Unexpected native account.");
      } else if (tag !== 18) throw Error("Unsupported token instruction.");
    }
    if (pid === ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()) {
      const mint = ix.keys[3]?.pubkey,
        accountOwner = ix.keys[2]?.pubkey,
        program = ix.keys[5]?.pubkey;
      const asset = EXCHANGE_ASSETS.find((a) => a.mint === mint?.toBase58());
      // CPAMM (token-swap layout): keys[7] is the pool mint, keys[14] the optional host-fee account.
      const poolFeeRoutes = message.instructions.filter(
        (route) =>
          route.programId.toBase58() === XYBN &&
          route.keys[7]?.pubkey.equals(mint!),
      );
      const created = ix.keys[1]?.pubkey;
      // The wallet pays rent only for its own accounts, or for the host-fee account a CPAMM route
      // names explicitly.
      const forOwner = !!accountOwner?.equals(owner);
      const hostFee =
        !!created &&
        poolFeeRoutes.some((route) => route.keys[14]?.pubkey.equals(created));
      if (
        (!asset && !poolFeeRoutes.length) ||
        !(forOwner || hostFee) ||
        !accountOwner ||
        !program ||
        program.toBase58() !==
          (asset?.program ?? TOKEN_PROGRAM_ID.toBase58()) ||
        !ix.keys[0]?.pubkey.equals(owner) ||
        !created?.equals(
          getAssociatedTokenAddressSync(mint!, accountOwner, true, program),
        ) ||
        !(ix.data.length === 1 && ix.data[0] === 1)
      )
        throw Error("Unexpected token-account creation.");
    }
    if (pid !== DAMM && pid !== XYBN) continue;
    const offset = pid === DAMM ? 8 : 1;
    if (
      ix.data.length !== offset + 16 ||
      (pid === DAMM
        ? ix.data.subarray(0, 8).toString("hex") !== "f8c69e91e17587c8"
        : ix.data[0] !== 1)
    )
      throw Error("Unsupported venue instruction.");
    const signer = ix.keys[pid === DAMM ? 8 : 2];
    const source = ix.keys[pid === DAMM ? 2 : 3]?.pubkey.toBase58();
    const destination = ix.keys[pid === DAMM ? 3 : 6]?.pubkey.toBase58();
    const mints =
      pid === DAMM
        ? [ix.keys[6]?.pubkey.toBase58(), ix.keys[7]?.pubkey.toBase58()]
        : [ix.keys[9]?.pubkey.toBase58(), ix.keys[10]?.pubkey.toBase58()];
    if (
      !signer?.pubkey.equals(owner) ||
      !signer.isSigner ||
      !mints.includes(quote.inputMint) ||
      !mints.includes(quote.outputMint) ||
      owned.get(source ?? "") !== quote.inputMint ||
      owned.get(destination ?? "") !== quote.outputMint
    )
      throw Error("Route does not match the reviewed pair and wallet.");
    input += ix.data.readBigUInt64LE(offset);
    minimum += ix.data.readBigUInt64LE(offset + 8);
  }
  if (
    input !== BigInt(quote.routeInput) ||
    minimum - outputFees < BigInt(quote.minimumOutput)
  )
    throw Error(
      "Route changed its spend or minimum received. Refresh the quote.",
    );
}
// --- integrator referrals (docs/REFERRALS.md) --------------------------------------------

/** A referrer's share of Aera's swap fee: 20% of the 0.10% (0.02% of the input). */
export const SWAP_REFERRAL_SHARE_BPS = 2000n;
/** The referrer's part of Aera's fee, rounded down (Aera keeps the rest, rounding included). */
export const swapReferralShare = (fee: bigint): bigint => (fee * SWAP_REFERRAL_SHARE_BPS) / 10_000n;
/** A referral the swap transaction pays: `amount` of the input token, out of Aera's fee, to `destination`. */
export interface SwapReferral {
  referrer: PublicKey;
  /** The referrer's wallet (native COOK) or its associated token account for the input mint. */
  destination: PublicKey;
  amount: bigint;
}
/**
 * Whether `info` is an account a transfer of `mint` to `referrer` cannot
 * fail on (pure): the referrer's own initialized, unfrozen token account of
 * that mint, under `program`, and, on Token-2022, with no extension but
 * ImmutableOwner (a required-memo account would refuse the credit and with
 * it the whole swap).
 */
export function payableReferralAccount(
  info: { owner: PublicKey; data: Uint8Array } | null,
  mint: PublicKey,
  referrer: PublicKey,
  program: PublicKey,
): boolean {
  if (!info || !info.owner.equals(program) || info.data.length < 165) return false;
  const d = info.data;
  if (!new PublicKey(d.subarray(0, 32)).equals(mint) || !new PublicKey(d.subarray(32, 64)).equals(referrer) || d[108] !== 1) return false;
  if (d.length === 165) return true;
  if (!program.equals(TOKEN_2022_PROGRAM_ID) || d[165] !== 2) return false;
  for (let at = 166; at < d.length; ) {
    if (d.subarray(at).every((b) => b === 0)) break;
    if (at + 4 > d.length) return false;
    const kind = d[at]! | (d[at + 1]! << 8);
    const len = d[at + 2]! | (d[at + 3]! << 8);
    if (kind !== 7 || at + 4 + len > d.length) return false;
    at += 4 + len;
  }
  return true;
}
/**
 * The referral a swap paying `fee` of `asset` would carry, or null: no
 * referrer, the wallet itself or Aera's fee owner as referrer, a share that
 * rounds to zero, or no account to receive it. The user never pays more and
 * never pays rent for it: native COOK goes only to an existing wallet (a
 * credit below rent to a new account would fail the swap), a token only to
 * the referrer's existing associated account; otherwise all of the fee is
 * Aera's, as without a referrer.
 */
export async function swapReferral(
  connection: Pick<Connection, "getAccountInfo">,
  owner: PublicKey,
  referrer: PublicKey | null | undefined,
  asset: { mint: string; program: string },
  fee: bigint,
): Promise<SwapReferral | null> {
  if (!referrer || referrer.equals(owner) || referrer.equals(AERA_FEE_OWNER) || referrer.equals(PublicKey.default)) return null;
  const amount = swapReferralShare(fee);
  if (amount <= 0n) return null;
  if (asset.mint === NATIVE_MINT.toBase58()) {
    const info = await connection.getAccountInfo(referrer, "confirmed");
    if (!info || !info.owner.equals(SystemProgram.programId) || info.data.length !== 0 || info.lamports <= 0) return null;
    return { referrer, destination: referrer, amount };
  }
  const mint = new PublicKey(asset.mint),
    program = new PublicKey(asset.program);
  const destination = getAssociatedTokenAddressSync(mint, referrer, true, program);
  const info = await connection.getAccountInfo(destination, "confirmed");
  return payableReferralAccount(info, mint, referrer, program) ? { referrer, destination, amount } : null;
}

/**
 * Check a venue route against its quote and add Aera's 0.10% fee to it.
 * With `options.referrer` (a wallet or frontend that sent the user), 20% of
 * that fee goes to the referrer instead (see `swapReferral`); the user pays
 * exactly the same. If the referral would make the transaction too large,
 * it is dropped, never the swap.
 */
export async function prepareExchangeTransaction(
  connection: Connection,
  owner: PublicKey,
  base64: string,
  quote: SwapQuote,
  request: SwapRequest,
  options: { referrer?: PublicKey | null } = {},
) {
  if (quote.expiresAt <= Date.now())
    throw Error("Quote expired. Refresh before continuing.");
  // Both before anything touches the network: the quote answers the user's own request, and its
  // minimum (which the simulation below holds delivery to) respects that request's slippage.
  assertQuoteMatchesRequest(quote, request);
  assertSwapQuoteMinimum(quote);
  if (
    quote.aeraFeeBps !== 10 ||
    BigInt(quote.aeraFee) !==
      (BigInt(quote.inputAmount) * 10n + 9999n) / 10000n ||
    BigInt(quote.routeInput) + BigInt(quote.aeraFee) !==
      BigInt(quote.inputAmount)
  )
    throw Error("Quote fee does not match Aera’s published fee.");
  const asset = EXCHANGE_ASSETS.find((a) => a.mint === quote.inputMint);
  if (
    !asset ||
    !EXCHANGE_ASSETS.some((a) => a.mint === quote.outputMint) ||
    quote.inputMint === quote.outputMint
  )
    throw Error("Unsupported token pair.");
  if ((await connection.getGenesisHash()) !== LAUNCH.chain.genesis)
    throw Error("Wrong chain.");
  const tx = VersionedTransaction.deserialize(Buffer.from(base64, "base64"));
  if (
    tx.message.header.numRequiredSignatures !== 1 ||
    !tx.message.staticAccountKeys[0]?.equals(owner) ||
    tx.signatures.some((s) => s.some((x) => x !== 0))
  )
    throw Error("Unexpected transaction signer.");
  const tables: AddressLookupTableAccount[] = [];
  if (tx.message.version === 0)
    for (const lookup of tx.message.addressTableLookups) {
      const table = (await connection.getAddressLookupTable(lookup.accountKey))
        .value;
      if (!table) throw Error("Route lookup table is unavailable.");
      tables.push(table);
    }
  const message = TransactionMessage.decompile(tx.message, {
    addressLookupTableAccounts: tables,
  });
  validateSwapInstructions(message, owner, quote);
  const fee = BigInt(quote.aeraFee);
  const route = message.instructions.slice();
  let feeInstructions: (referral: SwapReferral | null) => typeof route;
  if (asset.mint === NATIVE_MINT.toBase58())
    feeInstructions = (referral) => [
      SystemProgram.transfer({
        fromPubkey: owner,
        toPubkey: AERA_FEE_OWNER,
        lamports: fee - (referral?.amount ?? 0n),
      }),
      ...(referral
        ? [SystemProgram.transfer({ fromPubkey: owner, toPubkey: referral.destination, lamports: referral.amount })]
        : []),
    ];
  else {
    const mint = new PublicKey(asset.mint),
      program = new PublicKey(asset.program);
    const info = unpackMint(
      mint,
      await connection.getAccountInfo(mint),
      program,
    );
    if (info.decimals !== 9) throw Error("Token decimals changed.");
    const source = getAssociatedTokenAddressSync(mint, owner, false, program),
      destination = getAssociatedTokenAddressSync(
        mint,
        AERA_FEE_OWNER,
        false,
        program,
      );
    // Creating the fee account happens in the same transaction and is shown by the wallet.
    feeInstructions = (referral) => [
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        destination,
        AERA_FEE_OWNER,
        mint,
        program,
      ),
      createTransferCheckedInstruction(
        source,
        mint,
        destination,
        owner,
        fee - (referral?.amount ?? 0n),
        9,
        [],
        program,
      ),
      // The referrer's account already exists (`swapReferral`): never created at the user's cost.
      ...(referral
        ? [createTransferCheckedInstruction(source, mint, referral.destination, owner, referral.amount, 9, [], program)]
        : []),
    ];
  }
  let referral = await swapReferral(connection, owner, options.referrer, asset, fee);
  const block = await connection.getLatestBlockhash("confirmed");
  message.recentBlockhash = block.blockhash;
  const compose = () => {
    message.instructions = [...route, ...feeInstructions(referral)];
    return new VersionedTransaction(message.compileToV0Message(tables));
  };
  let composed = compose();
  if (referral && composed.serialize().length > 1232) {
    // A referral never costs the user the swap.
    referral = null;
    composed = compose();
  }
  if (composed.serialize().length > 1232)
    throw Error(
      "This route is too large to include the fee atomically. Try a smaller or simpler route.",
    );
  const result = await simulateWithinBudget(
    connection,
    composed,
    owner,
    spendBudget(quote.inputMint, BigInt(quote.inputAmount), 0n, {
      mint: quote.outputMint,
      min: BigInt(quote.minimumOutput),
    }),
    {
      what: "swap",
      source: "venue",
      commitment: "confirmed",
      replaceRecentBlockhash: false,
    },
  );
  if (result.value.err)
    throw Error(
      "Cookie Chain refused this route. Check your balance and refresh the quote.",
    );
  return { transaction: composed, block, referral };
}
