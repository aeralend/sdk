/**
 * Wrapping and unwrapping Cookie Chain's native token.
 *
 * COOK is native - a wallet holds it as lamports, exactly the way SOL works on
 * Solana - but Aera's COOK reserve is an SPL reserve over the native-mint
 * wrapper `So111...112`. So every action that moves COOK between a wallet and
 * the vault has to cross that boundary:
 *
 *   supply, repay     lamports must become wCOOK first
 *   withdraw, borrow  wCOOK must become lamports afterwards
 *
 * Without this a first-time supplier's transaction fails on a missing token
 * account, and a borrower receives a wCOOK balance they cannot spend on gas and
 * probably cannot see.
 *
 * The wrapped account is the owner's associated token account, created
 * idempotently so a second supply does not fail on an account that already
 * exists. Unwrapping closes it, which returns both the wrapped amount and the
 * account's own rent to the owner.
 */

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
} from '@solana/web3.js';

/** The native-mint wrapper. On Cookie this is wCOOK, not wrapped SOL. */
export const NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112');

export const isNativeMint = (mint: PublicKey): boolean => mint.equals(NATIVE_MINT);

/**
 * Move `lamports` of native COOK into the owner's wrapped account.
 *
 * `syncNative` is what makes the token program recognise the transferred
 * lamports as a balance; without it the account's `amount` stays at whatever it
 * was and the transfer looks like it did nothing.
 */
export function wrapNativeIxs(owner: PublicKey, lamports: bigint): TransactionInstruction[] {
  const account = getAssociatedTokenAddressSync(NATIVE_MINT, owner, true);

  return [
    createAssociatedTokenAccountIdempotentInstruction(
      owner,
      account,
      owner,
      NATIVE_MINT,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
    SystemProgram.transfer({
      fromPubkey: owner,
      toPubkey: account,
      lamports,
    }),
    createSyncNativeInstruction(account, TOKEN_PROGRAM_ID),
  ];
}

/**
 * Close the wrapped account, returning its balance and rent as lamports.
 *
 * Safe to append even when the account holds nothing: closing an empty wrapped
 * account still refunds its rent, and the alternative - leaving a dust wCOOK
 * account behind after every withdrawal - is worse.
 */
export function unwrapNativeIx(owner: PublicKey): TransactionInstruction {
  const account = getAssociatedTokenAddressSync(NATIVE_MINT, owner, true);
  return createCloseAccountInstruction(account, owner, owner, [], TOKEN_PROGRAM_ID);
}

/** Create a token account for `mint` if it is missing. */
export function ensureAtaIx(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram = TOKEN_PROGRAM_ID,
): TransactionInstruction {
  const account = getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
  return createAssociatedTokenAccountIdempotentInstruction(
    owner,
    account,
    owner,
    mint,
    tokenProgram,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}
