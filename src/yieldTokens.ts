/**
 * Yield Tokens (`protocol/yield-program`, docs/YIELD_TOKENS.md): lock aSOL for
 * an epoch, split it into a fixed rate (PT) and the epoch's whole yield (YT),
 * and sell the YT in a falling-price auction.
 *
 * Harvest and maturity are permissionless, so a claim carries them itself:
 * `yieldClaimIxs` puts a harvest (or, past maturity, the maturing) in front of
 * the claim, and no keeper is needed.
 */
import { PublicKey, SystemProgram, TransactionInstruction, type AccountMeta, type Connection } from '@solana/web3.js';
import {
  ASOL_STAKE_PROGRAM_ID,
  asolRewardVault,
  asolStakePool,
  asolStakePosition,
  asolStakeVault,
} from './asolStaking.js';

export const YIELD_PROGRAM_ID = new PublicKey('9HxtpgBhkfmZvHRh643YSpM5tiRGci5uXQSduEYwMvzq');
const ASOL = new PublicKey('FHv5bDrikq9sA4ckNNTsvqZHGoWYSnPMFJC8xHszKwbq');
const SOL = new PublicKey('6tL24Fn75uCMrBSZAvohAq57LSv6KrY6ceEq1wonvucb');
const RESERVE = new PublicKey('HEr4uwrN7Cz1uegzYRP7GiHPXN2GjMK6tvQCTm12phjT');
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const E18 = 1_000_000_000_000_000_000n;
const BPS = 10_000n;

const hex = (h: string): number[] => h.match(/../g)!.map((b) => parseInt(b, 16));
export const YIELD_DISC = Object.freeze({
  open_epoch: hex('4b39da21adfecf88'),
  deposit: hex('f223c68952e1f2b6'),
  buy_yt: hex('38401add2fbd33f5'),
  harvest: hex('e4f11fb635a93bc7'),
  mature: hex('a5b374986ff052cb'),
  claim: hex('3ec6d6c1d59f6cd2'),
  Epoch: hex('5d537859978a986c'),
  Receipt: hex('279a496a50669199'),
});

// --- addresses --------------------------------------------------------------------

const enc = (s: string) => new TextEncoder().encode(s);
const le64 = (v: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); return b; };
const pda = (...seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, YIELD_PROGRAM_ID)[0];
export const yieldEpoch = (id: bigint): PublicKey => pda(enc('epoch'), le64(id));
export const yieldVault = (epoch: PublicKey): PublicKey => pda(enc('vault'), epoch.toBytes());
export const yieldAsolVault = (epoch: PublicKey): PublicKey => pda(enc('asol'), epoch.toBytes());
export const yieldSolVault = (epoch: PublicKey): PublicKey => pda(enc('sol'), epoch.toBytes());
export const yieldReceipt = (epoch: PublicKey, owner: PublicKey): PublicKey => pda(enc('receipt'), epoch.toBytes(), owner.toBytes());
const ata = (owner: PublicKey, mint: PublicKey) =>
  PublicKey.findProgramAddressSync([owner.toBytes(), TOKEN_2022.toBytes(), mint.toBytes()], ATA_PROGRAM)[0];

// --- accounts ---------------------------------------------------------------------

export interface YieldEpoch {
  address: PublicKey;
  id: bigint;
  depositStart: number;
  auctionStart: number;
  auctionEnd: number;
  maturity: number;
  capValue: bigint;
  startPriceBps: number;
  endPriceBps: number;
  totalAsol: bigint;
  /** SOL value deposited: the PT principal, and the number of YT units. */
  totalValue: bigint;
  soldUnits: bigint;
  proceeds: bigint;
  rewardPerUnit: bigint;
  harvested: bigint;
  matured: boolean;
  maturityRate: bigint;
  ptAsol: bigint;
  appreciationPerUnit: bigint;
}
export interface YieldReceipt {
  address: PublicKey;
  epoch: PublicKey;
  owner: PublicKey;
  value: bigint;
  bought: bigint;
  units: bigint;
  settled: boolean;
  rewardPaid: bigint;
  proceedsClaimed: boolean;
  ptClaimed: boolean;
  appreciationClaimed: boolean;
}

class R {
  o = 8;
  constructor(private d: Uint8Array) {}
  private v() { return new DataView(this.d.buffer, this.d.byteOffset + this.o); }
  bool() { const x = this.d[this.o] !== 0; this.o += 1; return x; }
  u8() { const x = this.d[this.o]!; this.o += 1; return x; }
  u16() { const x = this.v().getUint16(0, true); this.o += 2; return x; }
  u64() { const x = this.v().getBigUint64(0, true); this.o += 8; return x; }
  i64() { const x = this.v().getBigInt64(0, true); this.o += 8; return Number(x); }
  u128() { const lo = this.u64(); const hi = this.u64(); return (hi << 64n) | lo; }
  key() { const k = new PublicKey(this.d.subarray(this.o, this.o + 32)); this.o += 32; return k; }
}
const is = (d: Uint8Array, disc: readonly number[]) => d.length >= 8 && disc.every((b, i) => d[i] === b);

export function decodeYieldEpoch(address: PublicKey, d: Uint8Array): YieldEpoch {
  if (!is(d, YIELD_DISC.Epoch)) throw new Error('not a yield Epoch');
  const r = new R(d);
  return {
    address, id: r.u64(), depositStart: r.i64(), auctionStart: r.i64(), auctionEnd: r.i64(), maturity: r.i64(),
    capValue: r.u64(), startPriceBps: r.u16(), endPriceBps: r.u16(), totalAsol: r.u64(), totalValue: r.u64(),
    soldUnits: r.u64(), proceeds: r.u64(), rewardPerUnit: r.u128(), harvested: r.u64(), matured: r.bool(),
    maturityRate: r.u64(), ptAsol: r.u64(), appreciationPerUnit: r.u128(),
  };
}
export function decodeYieldReceipt(address: PublicKey, d: Uint8Array): YieldReceipt {
  if (!is(d, YIELD_DISC.Receipt)) throw new Error('not a yield Receipt');
  const r = new R(d);
  return {
    address, epoch: r.key(), owner: r.key(), value: r.u64(), bought: r.u64(), units: r.u64(), settled: r.bool(),
    rewardPaid: r.u128(), proceedsClaimed: r.bool(), ptClaimed: r.bool(), appreciationClaimed: r.bool(),
  };
}

/** Every epoch on chain, newest first, with the wallet's receipt in each. */
export async function fetchYieldEpochs(connection: Connection, owner?: PublicKey): Promise<Array<{ epoch: YieldEpoch; receipt: YieldReceipt | null }>> {
  const raw = await connection.getProgramAccounts(YIELD_PROGRAM_ID, {
    commitment: 'confirmed',
    filters: [{ memcmp: { offset: 0, bytes: Buffer.from(YIELD_DISC.Epoch).toString('base64'), encoding: 'base64' } }],
  });
  const epochs = raw.map((a) => decodeYieldEpoch(a.pubkey, a.account.data)).sort((a, b) => Number(b.id - a.id));
  if (!owner) return epochs.map((epoch) => ({ epoch, receipt: null }));
  const receipts = await connection.getMultipleAccountsInfo(epochs.map((e) => yieldReceipt(e.address, owner)), 'confirmed');
  return epochs.map((epoch, i) => {
    const info = receipts[i];
    return { epoch, receipt: info ? decodeYieldReceipt(yieldReceipt(epoch.address, owner), info.data) : null };
  });
}

// --- the arithmetic (mirrors the program) -------------------------------------------

export type YieldPhase = 'upcoming' | 'deposits' | 'auction' | 'running' | 'maturing' | 'matured';
export function yieldPhase(e: YieldEpoch, now: number): YieldPhase {
  if (e.matured) return 'matured';
  if (now < e.depositStart) return 'upcoming';
  if (now < e.auctionStart) return 'deposits';
  if (now < e.auctionEnd) return 'auction';
  return now < e.maturity ? 'running' : 'maturing';
}

/** The auction price at `now`, in bps of a YT unit's value (one lamport of principal). */
export function yieldAuctionPrice(e: YieldEpoch, now: number): number {
  const span = Math.max(1, e.auctionEnd - e.auctionStart);
  const gone = Math.min(Math.max(now - e.auctionStart, 0), span);
  return e.startPriceBps - Math.floor(((e.startPriceBps - e.endPriceBps) * gone) / span);
}
/** SOL a YT purchase costs, rounded up as the program does. */
export const yieldCost = (units: bigint, priceBps: number): bigint => (units * BigInt(priceBps) + BPS - 1n) / BPS;

/**
 * What a price means for each side. For the depositor it is a fixed rate for
 * the epoch, annualized simply. For the YT buyer it is how many SOL of
 * principal's yield one SOL controls.
 */
export function yieldTerms(e: YieldEpoch, priceBps: number) {
  const days = Math.max(1, (e.maturity - e.auctionEnd) / 86_400);
  return {
    epochRate: priceBps / 10_000,
    fixedApr: (priceBps / 10_000) * (365 / days),
    leverage: priceBps > 0 ? 10_000 / priceBps : Infinity,
    days,
  };
}

/** YT units a receipt holds once the auction is over (bought, plus a depositor's share of the unsold). */
export function receiptUnits(e: YieldEpoch, r: YieldReceipt): bigint {
  if (r.settled) return r.units;
  const unsold = e.totalValue - e.soldUnits;
  return r.bought + (e.totalValue === 0n ? 0n : (r.value * unsold) / e.totalValue);
}

/**
 * What a claim would pay now from rewards already harvested. A claim harvests
 * first, so it can pay more than this.
 */
export function yieldOwed(e: YieldEpoch, r: YieldReceipt) {
  const units = receiptUnits(e, r);
  const proceeds = r.value > 0n && !r.proceedsClaimed && e.totalValue > 0n ? (e.proceeds * r.value) / e.totalValue : 0n;
  const rewards = (units * (e.rewardPerUnit - r.rewardPaid)) / E18;
  const principal = e.matured && !r.ptClaimed && e.totalValue > 0n ? (r.value * e.ptAsol) / e.totalValue : 0n;
  const appreciation = e.matured && !r.appreciationClaimed ? (units * e.appreciationPerUnit) / E18 : 0n;
  return { units, proceeds, rewards, principal, appreciation, sol: proceeds + rewards, asol: principal + appreciation };
}

// --- instructions -------------------------------------------------------------------

const w = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });
const ro = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });

/** Deposit aSOL during the deposit window. Aera's SOL reserve must be accrued in the same transaction first. */
export function yieldDepositIx(epoch: PublicKey, owner: PublicKey, amount: bigint): TransactionInstruction {
  const vault = yieldVault(epoch);
  return new TransactionInstruction({
    programId: YIELD_PROGRAM_ID,
    keys: [
      w(owner, true), w(epoch), w(yieldReceipt(epoch, owner)), w(ata(owner, ASOL)), w(vault), w(yieldAsolVault(epoch)),
      ro(RESERVE), w(asolStakePool()), w(asolStakePosition(vault)), w(asolStakeVault()), ro(ASOL), ro(TOKEN_2022),
      ro(SystemProgram.programId), ro(ASOL_STAKE_PROGRAM_ID),
    ],
    data: Buffer.from([...YIELD_DISC.deposit, ...le64(amount)]),
  });
}

/** Buy YT units at the current auction price, refusing a price above `maxPriceBps`. */
export function yieldBuyIx(epoch: PublicKey, buyer: PublicKey, units: bigint, maxPriceBps: number): TransactionInstruction {
  const max = new Uint8Array(2);
  new DataView(max.buffer).setUint16(0, maxPriceBps, true);
  return new TransactionInstruction({
    programId: YIELD_PROGRAM_ID,
    keys: [w(buyer, true), w(epoch), w(yieldReceipt(epoch, buyer)), w(ata(buyer, SOL)), w(yieldSolVault(epoch)), ro(SOL), ro(TOKEN_2022), ro(SystemProgram.programId)],
    data: Buffer.from([...YIELD_DISC.buy_yt, ...le64(units), ...max]),
  });
}

export function yieldHarvestIx(epoch: PublicKey): TransactionInstruction {
  const vault = yieldVault(epoch);
  return new TransactionInstruction({
    programId: YIELD_PROGRAM_ID,
    keys: [w(epoch), w(vault), w(yieldSolVault(epoch)), w(asolStakePool()), w(asolStakePosition(vault)), w(asolRewardVault()), ro(SOL), ro(TOKEN_2022), ro(ASOL_STAKE_PROGRAM_ID)],
    data: Buffer.from(YIELD_DISC.harvest),
  });
}

/** Mature an epoch. Aera's SOL reserve must be accrued in the same transaction first. */
export function yieldMatureIx(epoch: PublicKey): TransactionInstruction {
  const vault = yieldVault(epoch);
  return new TransactionInstruction({
    programId: YIELD_PROGRAM_ID,
    keys: [
      w(epoch), w(vault), w(yieldSolVault(epoch)), w(yieldAsolVault(epoch)), ro(RESERVE), w(asolStakePool()),
      w(asolStakePosition(vault)), w(asolStakeVault()), w(asolRewardVault()), ro(ASOL), ro(SOL), ro(TOKEN_2022), ro(ASOL_STAKE_PROGRAM_ID),
    ],
    data: Buffer.from(YIELD_DISC.mature),
  });
}

export function yieldClaimIx(epoch: PublicKey, owner: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: YIELD_PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false }, ro(epoch), w(yieldReceipt(epoch, owner)), ro(yieldVault(epoch)),
      w(yieldSolVault(epoch)), w(yieldAsolVault(epoch)), w(ata(owner, SOL)), w(ata(owner, ASOL)), ro(SOL), ro(ASOL), ro(TOKEN_2022),
    ],
    data: Buffer.from(YIELD_DISC.claim),
  });
}

/**
 * A claim with what it needs in front of it: a harvest while the epoch runs,
 * or the maturing once it is due (the caller adds Aera's accrue before a
 * maturing, which reads aSOL's rate). The owner's SOL and aSOL token accounts
 * must exist; the app creates them idempotently.
 */
export function yieldClaimIxs(e: YieldEpoch, owner: PublicKey, now: number): TransactionInstruction[] {
  const before = e.matured ? [] : now >= e.maturity ? [yieldMatureIx(e.address)] : [yieldHarvestIx(e.address)];
  return [...before, yieldClaimIx(e.address, owner)];
}

/** Admin: open an epoch. */
export function yieldOpenEpochIx(admin: PublicKey, id: bigint, s: { depositStart: number; auctionStart: number; auctionEnd: number; maturity: number; capValue: bigint; startPriceBps: number; endPriceBps: number }): TransactionInstruction {
  const epoch = yieldEpoch(id);
  const data = new Uint8Array(8 + 8 + 8 * 4 + 8 + 2 + 2);
  const v = new DataView(data.buffer);
  data.set(YIELD_DISC.open_epoch, 0);
  v.setBigUint64(8, id, true);
  v.setBigInt64(16, BigInt(s.depositStart), true);
  v.setBigInt64(24, BigInt(s.auctionStart), true);
  v.setBigInt64(32, BigInt(s.auctionEnd), true);
  v.setBigInt64(40, BigInt(s.maturity), true);
  v.setBigUint64(48, s.capValue, true);
  v.setUint16(56, s.startPriceBps, true);
  v.setUint16(58, s.endPriceBps, true);
  return new TransactionInstruction({
    programId: YIELD_PROGRAM_ID,
    keys: [w(admin, true), w(epoch), w(yieldVault(epoch)), w(yieldAsolVault(epoch)), w(yieldSolVault(epoch)), ro(ASOL), ro(SOL), ro(TOKEN_2022), ro(SystemProgram.programId)],
    data: Buffer.from(data),
  });
}
