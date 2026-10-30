/**
 * Permissionless creator markets (`instructions::isolated` in the Aera program,
 * docs/ISOLATED_MARKETS.md).
 *
 * Any token project can open an isolated Aera market for its token, quoted in
 * bridged SOL. The creator chooses a tier, one or two pools on AMMs Aera has
 * allowed, and a bond; the tier table in the program chooses everything else.
 * Lenders are insured first-loss by the bond: no market may lend more than 80%
 * of it.
 *
 * Everything here mirrors the program byte for byte -- account order, borsh
 * layouts, PDA seeds -- and the discriminators are fixed constants so this
 * module runs in the browser without a hasher. `test/isolated-markets.test.ts`
 * checks them against Anchor's derivation and decodes account bytes the
 * program itself wrote.
 */
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';

import { AERA_PROGRAM_ID, FIXED_POINT_SCALE } from './constants.js';
import {
  globalPda,
  liquidityVaultPda,
  marketOraclePda,
  marketPda,
  obligationShareVaultPda,
  oraclePda,
  reservePda,
  riskConfigPda,
  shareMintPda,
} from './pda.js';

// --- protocol constants (constants.rs) ---------------------------------------

/** Creator markets take ids from here up; `init_market` refuses this range. */
export const ISOLATED_MARKET_ID_BASE = 1n << 32n;
export const ISOLATED_BOND_COVERAGE_BPS = 8_000n;
export const ISOLATED_MIN_BOND = 100_000_000n; // 0.1 SOL
export const ISOLATED_MAX_CREATION_FEE = 1_000_000_000n; // 1 SOL
/** The creator's cut of lender gains; 10% of gross interest at a 20% reserve factor. */
export const ISOLATED_CREATOR_FEE_BPS = 1_250n;
export const ISOLATED_RESERVE_FACTOR_BPS = 2_000n;
export const ISOLATED_ORIGINATION_FEE_BPS = 25n;
export const ISOLATED_ORACLE_DEAD_SECONDS = 7n * 24n * 60n * 60n;
export const ISOLATED_ADMIN_TIMELOCK_SECONDS = 24n * 60n * 60n;

export const STAGE_CREATING = 0;
export const STAGE_ACTIVE = 1;

/** `cover_isolated_debt` cases, as emitted in `IsolatedDebtCovered.case`. */
export const COVER_CASE = { noCollateral: 0, underwater: 1, oracleDead: 2 } as const;

const SOL = 1_000_000_000n;

/** The tier table (`state::isolated::tier`). Informational: the program is the authority. */
export interface IsolatedTier {
  index: number;
  name: string;
  ltvBps: number;
  liquidationThresholdBps: number;
  liquidationBonusBps: number;
  collateralHaircutBps: number;
  /** Minimum SOL in EACH oracle pool, in base units. */
  minPoolQuoteDepth: bigint;
  requiresTwoPools: boolean;
  borrowCapDepthBps: number;
  walletCapDepthBps: number;
  maxStepBps: number;
  twapWindowSeconds: number;
  minSpacingSeconds: number;
}

export const ISOLATED_TIERS: readonly IsolatedTier[] = [
  {
    index: 0, name: 'Seed', ltvBps: 2_000, liquidationThresholdBps: 3_000, liquidationBonusBps: 1_500,
    collateralHaircutBps: 500, minPoolQuoteDepth: SOL / 4n, requiresTwoPools: false,
    borrowCapDepthBps: 1_000, walletCapDepthBps: 250, maxStepBps: 2_000, twapWindowSeconds: 3_600, minSpacingSeconds: 300,
  },
  {
    index: 1, name: 'Standard', ltvBps: 3_000, liquidationThresholdBps: 4_000, liquidationBonusBps: 1_200,
    collateralHaircutBps: 500, minPoolQuoteDepth: SOL, requiresTwoPools: true,
    borrowCapDepthBps: 1_500, walletCapDepthBps: 300, maxStepBps: 1_500, twapWindowSeconds: 1_800, minSpacingSeconds: 180,
  },
  {
    index: 2, name: 'Deep', ltvBps: 4_000, liquidationThresholdBps: 5_000, liquidationBonusBps: 1_000,
    collateralHaircutBps: 300, minPoolQuoteDepth: 5n * SOL, requiresTwoPools: true,
    borrowCapDepthBps: 2_000, walletCapDepthBps: 400, maxStepBps: 1_000, twapWindowSeconds: 1_800, minSpacingSeconds: 120,
  },
];

// --- discriminators -----------------------------------------------------------

export const ISOLATED_DISCRIMINATOR = {
  initIsolatedConfig: [88, 116, 216, 115, 47, 105, 47, 229],
  setIsolatedConfig: [248, 98, 217, 5, 147, 152, 243, 204],
  applyIsolatedAmms: [106, 147, 17, 129, 191, 96, 112, 104],
  refreshIsolatedOracle: [81, 114, 154, 103, 220, 68, 72, 37],
  createIsolatedMarket: [149, 18, 169, 63, 26, 210, 250, 124],
  initIsolatedCollateralReserve: [32, 117, 100, 8, 119, 96, 147, 215],
  initIsolatedQuoteReserve: [55, 192, 212, 34, 230, 62, 94, 23],
  harvestCreatorFees: [41, 165, 15, 47, 52, 192, 122, 187],
  freezeIsolatedMarket: [0, 244, 49, 14, 137, 125, 7, 156],
  retireIsolatedMarket: [214, 14, 224, 61, 179, 233, 151, 234],
  topUpBond: [110, 37, 8, 119, 210, 231, 202, 197],
  withdrawBond: [222, 199, 141, 31, 188, 93, 155, 40],
  syncIsolatedCaps: [68, 34, 93, 242, 88, 27, 197, 18],
  syncIsolatedAmmPins: [243, 170, 158, 80, 217, 144, 93, 111],
  coverIsolatedDebt: [197, 13, 54, 138, 220, 25, 63, 40],
  IsolatedConfig: [16, 248, 230, 49, 163, 147, 49, 214],
  IsolatedMarket: [252, 62, 181, 26, 38, 165, 179, 160],
  IsolatedOracle: [200, 121, 9, 187, 102, 169, 183, 40],
} as const;

export const INSTRUCTIONS_SYSVAR = new PublicKey('Sysvar1nstructions1111111111111111111111111');
export const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey('ComputeBudget111111111111111111111111111111');

// --- addresses ----------------------------------------------------------------

const utf8 = (s: string) => new TextEncoder().encode(s);
const derive = (seeds: Uint8Array[], programId = AERA_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync(seeds, programId)[0];

export const isolatedConfigPda = (programId?: PublicKey) => derive([utf8('isolated_config')], programId);
export const isolatedMarketPda = (market: PublicKey, programId?: PublicKey) =>
  derive([utf8('isolated_market'), market.toBytes()], programId);
export const isolatedBondVaultPda = (market: PublicKey, programId?: PublicKey) =>
  derive([utf8('isolated_bond'), market.toBytes()], programId);
/** The token oracle's history. It lives where a `MarketOracle` would, by design. */
export const isolatedOraclePda = (tokenOracle: PublicKey, programId?: PublicKey) =>
  marketOraclePda(tokenOracle, programId);

/** Every address a creator market is made of, from its id and its two mints. */
export function isolatedMarketAddresses(
  marketId: bigint,
  tokenMint: PublicKey,
  quoteMint: PublicKey,
  programId?: PublicKey,
) {
  const market = marketPda(marketId, programId);
  const tokenOracle = oraclePda(market, tokenMint, programId);
  const quoteOracle = oraclePda(market, quoteMint, programId);
  const tokenReserve = reservePda(market, tokenMint, programId);
  const quoteReserve = reservePda(market, quoteMint, programId);
  return {
    market,
    isolatedMarket: isolatedMarketPda(market, programId),
    bondVault: isolatedBondVaultPda(market, programId),
    tokenOracle,
    quoteOracle,
    isolatedOracle: isolatedOraclePda(tokenOracle, programId),
    tokenReserve,
    tokenVault: liquidityVaultPda(tokenReserve, programId),
    tokenShareMint: shareMintPda(tokenReserve, programId),
    quoteReserve,
    quoteVault: liquidityVaultPda(quoteReserve, programId),
    quoteShareMint: shareMintPda(quoteReserve, programId),
    quoteRiskConfig: riskConfigPda(quoteReserve, programId),
  };
}

// --- borsh --------------------------------------------------------------------

class Writer {
  private bytes: number[] = [];
  u8(v: number) { this.bytes.push(v & 0xff); return this; }
  bool(v: boolean) { return this.u8(v ? 1 : 0); }
  u64(v: bigint) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, v, true);
    this.bytes.push(...b);
    return this;
  }
  key(k: PublicKey) { this.bytes.push(...k.toBytes()); return this; }
  raw(b: readonly number[]) { this.bytes.push(...b); return this; }
  done() { return Uint8Array.from(this.bytes); }
}

class Reader {
  private at = 0;
  private view: DataView;
  constructor(private data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  u8() { return this.view.getUint8(this.at++); }
  bool() { return this.u8() !== 0; }
  u16() { const v = this.view.getUint16(this.at, true); this.at += 2; return v; }
  u32() { const v = this.view.getUint32(this.at, true); this.at += 4; return v; }
  u64() { const v = this.view.getBigUint64(this.at, true); this.at += 8; return v; }
  i64() { const v = this.view.getBigInt64(this.at, true); this.at += 8; return v; }
  u128() { const lo = this.u64(); const hi = this.u64(); return (hi << 64n) | lo; }
  key() { const k = new PublicKey(this.data.subarray(this.at, this.at + 32)); this.at += 32; return k; }
}

function expectDiscriminator(data: Uint8Array, expected: readonly number[], name: string) {
  if (data.length < 8 || expected.some((b, i) => data[i] !== b)) {
    throw new Error(`not an Aera ${name} account`);
  }
}

// --- types ----------------------------------------------------------------------

export interface AmmPin {
  ammKind: number;
  ammProgram: PublicKey;
  ammProgramData: PublicKey;
  expectedDeploySlot: bigint;
  enabled: boolean;
}

export interface IsolatedConfigArgs {
  creationFee: bigint;
  creationEnabled: boolean;
  amms: [AmmPin, AmmPin];
}

export interface PoolChoice {
  pool: PublicKey;
  collateralVault: PublicKey;
  quoteVault: PublicKey;
  /** Index into `IsolatedConfig.amms`. */
  ammIndex: number;
}

const writePin = (w: Writer, p: AmmPin) =>
  w.u8(p.ammKind).key(p.ammProgram).key(p.ammProgramData).u64(p.expectedDeploySlot).bool(p.enabled);
const readPin = (r: Reader): AmmPin => ({
  ammKind: r.u8(),
  ammProgram: r.key(),
  ammProgramData: r.key(),
  expectedDeploySlot: r.u64(),
  enabled: r.bool(),
});

export function encodeIsolatedConfigArgs(args: IsolatedConfigArgs): Uint8Array {
  const w = new Writer().u64(args.creationFee).bool(args.creationEnabled);
  args.amms.forEach((p) => writePin(w, p));
  return w.done();
}

export interface IsolatedConfigAccount {
  global: PublicKey;
  quoteMint: PublicKey;
  quoteDecimals: number;
  creationFee: bigint;
  creationEnabled: boolean;
  nextMarketId: bigint;
  marketsCreated: bigint;
  amms: [AmmPin, AmmPin];
  pendingAmms: [AmmPin, AmmPin];
  pendingAmmsEta: bigint;
}

export function decodeIsolatedConfig(data: Uint8Array): IsolatedConfigAccount {
  expectDiscriminator(data, ISOLATED_DISCRIMINATOR.IsolatedConfig, 'IsolatedConfig');
  const r = new Reader(data.subarray(8));
  return {
    global: r.key(),
    quoteMint: r.key(),
    quoteDecimals: r.u8(),
    creationFee: r.u64(),
    creationEnabled: r.bool(),
    nextMarketId: r.u64(),
    marketsCreated: r.u64(),
    amms: [readPin(r), readPin(r)],
    pendingAmms: [readPin(r), readPin(r)],
    pendingAmmsEta: r.i64(),
  };
}

export interface IsolatedMarketAccount {
  market: PublicKey;
  marketId: bigint;
  creator: PublicKey;
  tokenMint: PublicKey;
  tokenDecimals: number;
  quoteMint: PublicKey;
  tier: number;
  stage: number;
  tokenReserve: PublicKey;
  quoteReserve: PublicKey;
  tokenOracle: PublicKey;
  quoteOracle: PublicKey;
  isolatedOracle: PublicKey;
  singlePool: boolean;
  bondVault: PublicKey;
  bondAmount: bigint;
  bondUsed: bigint;
  depthBorrowCap: bigint;
  depthWalletCap: bigint;
  measuredQuoteDepth: bigint;
  creatorFeeHwm: bigint;
  creatorFeeShares: bigint;
  frozen: boolean;
  unfreezeEta: bigint;
  retired: boolean;
  createdAt: bigint;
}

export function decodeIsolatedMarket(data: Uint8Array): IsolatedMarketAccount {
  expectDiscriminator(data, ISOLATED_DISCRIMINATOR.IsolatedMarket, 'IsolatedMarket');
  const r = new Reader(data.subarray(8));
  return {
    market: r.key(),
    marketId: r.u64(),
    creator: r.key(),
    tokenMint: r.key(),
    tokenDecimals: r.u8(),
    quoteMint: r.key(),
    tier: r.u8(),
    stage: r.u8(),
    tokenReserve: r.key(),
    quoteReserve: r.key(),
    tokenOracle: r.key(),
    quoteOracle: r.key(),
    isolatedOracle: r.key(),
    singlePool: r.bool(),
    bondVault: r.key(),
    bondAmount: r.u64(),
    bondUsed: r.u64(),
    depthBorrowCap: r.u64(),
    depthWalletCap: r.u64(),
    measuredQuoteDepth: r.u64(),
    creatorFeeHwm: r.u128(),
    creatorFeeShares: r.u64(),
    frozen: r.bool(),
    unfreezeEta: r.i64(),
    retired: r.bool(),
    createdAt: r.i64(),
  };
}

export interface IsolatedObservation {
  price: bigint;
  slot: bigint;
  unixTimestamp: bigint;
  quoteDepth: bigint;
}

export interface IsolatedPoolRef {
  pool: PublicKey;
  collateralVault: PublicKey;
  quoteVault: PublicKey;
  ammKind: number;
  ammProgram: PublicKey;
  ammProgramData: PublicKey;
  expectedDeploySlot: bigint;
}

export interface IsolatedOracleAccount {
  oracle: PublicKey;
  isolatedMarket: PublicKey;
  collateralMint: PublicKey;
  quoteMint: PublicKey;
  collateralDecimals: number;
  quoteDecimals: number;
  config: {
    twapWindowSeconds: number;
    minObservations: number;
    minSpanSeconds: number;
    minSpacingSeconds: number;
    maxObservationAgeSeconds: number;
    warnAgeSeconds: number;
    maxCrossPoolDeviationBps: number;
    minPoolQuoteDepth: bigint;
    maxRiseBpsPerWindow: number;
  };
  maxStepBps: number;
  pools: [IsolatedPoolRef, IsolatedPoolRef];
  observations: IsolatedObservation[];
  nextIndex: number;
  lastGoodRead: bigint;
  degradedReads: bigint;
}

export function decodeIsolatedOracle(data: Uint8Array): IsolatedOracleAccount {
  expectDiscriminator(data, ISOLATED_DISCRIMINATOR.IsolatedOracle, 'IsolatedOracle');
  const r = new Reader(data.subarray(8));
  const head = {
    oracle: r.key(),
    isolatedMarket: r.key(),
    collateralMint: r.key(),
    quoteMint: r.key(),
    collateralDecimals: r.u8(),
    quoteDecimals: r.u8(),
    config: {
      twapWindowSeconds: r.u32(),
      minObservations: r.u8(),
      minSpanSeconds: r.u32(),
      minSpacingSeconds: r.u32(),
      maxObservationAgeSeconds: r.u32(),
      warnAgeSeconds: r.u32(),
      maxCrossPoolDeviationBps: r.u16(),
      minPoolQuoteDepth: r.u64(),
      maxRiseBpsPerWindow: r.u16(),
    },
    maxStepBps: r.u16(),
  };
  const pool = (): IsolatedPoolRef => ({
    pool: r.key(),
    collateralVault: r.key(),
    quoteVault: r.key(),
    ammKind: r.u8(),
    ammProgram: r.key(),
    ammProgramData: r.key(),
    expectedDeploySlot: r.u64(),
  });
  const pools: [IsolatedPoolRef, IsolatedPoolRef] = [pool(), pool()];
  const count = r.u32();
  const observations: IsolatedObservation[] = [];
  for (let i = 0; i < count; i++) {
    observations.push({ price: r.u128(), slot: r.u64(), unixTimestamp: r.i64(), quoteDepth: r.u64() });
  }
  return { ...head, pools, observations, nextIndex: r.u8(), lastGoodRead: r.i64(), degradedReads: r.u64() };
}

// --- arithmetic the app shows ---------------------------------------------------

/** What the bond alone lets the market lend. */
export const bondCap = (bond: bigint) => (bond * ISOLATED_BOND_COVERAGE_BPS) / 10_000n;

/** The market's borrow cap: never more than depth allows, never more than the bond insures. */
export function isolatedBorrowCap(m: Pick<IsolatedMarketAccount, 'depthBorrowCap' | 'bondAmount'>): bigint {
  const byBond = bondCap(m.bondAmount);
  return m.depthBorrowCap < byBond ? m.depthBorrowCap : byBond;
}

/** The smallest bond that lets a market reach its full depth cap. */
export const bondForFullDepth = (depthBorrowCap: bigint) =>
  (depthBorrowCap * 10_000n + ISOLATED_BOND_COVERAGE_BPS - 1n) / ISOLATED_BOND_COVERAGE_BPS;

/** Bond the creator may withdraw now, given the market's live debt. */
export function withdrawableBond(bond: bigint, outstandingDebt: bigint): bigint {
  const needed = (outstandingDebt * 10_000n + ISOLATED_BOND_COVERAGE_BPS - 1n) / ISOLATED_BOND_COVERAGE_BPS;
  return bond > needed ? bond - needed : 0n;
}

/** Split of gross borrow interest: Aera's reserve factor, the creator's cut, lenders. */
export function isolatedInterestSplit(grossInterest: bigint) {
  const aera = (grossInterest * ISOLATED_RESERVE_FACTOR_BPS) / 10_000n;
  const creator = ((grossInterest - aera) * ISOLATED_CREATOR_FEE_BPS) / 10_000n;
  return { aera, creator, lenders: grossInterest - aera - creator };
}

/** Share price, 1e18-scaled, from reserve totals. */
export const sharePrice = (totalLiquidity: bigint, shareSupply: bigint) =>
  shareSupply === 0n ? FIXED_POINT_SCALE : (totalLiquidity * FIXED_POINT_SCALE) / shareSupply;

// --- instructions ---------------------------------------------------------------

const meta = (pubkey: PublicKey, isWritable = false, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable });
const ix = (keys: AccountMeta[], data: Uint8Array, programId = AERA_PROGRAM_ID) =>
  new TransactionInstruction({ programId, keys, data: Buffer.from(data) });
const discriminated = (d: readonly number[], body: Uint8Array = new Uint8Array()) => {
  const out = new Uint8Array(8 + body.length);
  out.set(d, 0);
  out.set(body, 8);
  return out;
};

export interface IsolatedProgramAccounts {
  programId?: PublicKey;
  global: PublicKey;
}

export function initIsolatedConfigIx(p: IsolatedProgramAccounts & { admin: PublicKey; quoteMint: PublicKey; args: IsolatedConfigArgs }) {
  return ix(
    [
      meta(p.global),
      meta(p.admin, true, true),
      meta(isolatedConfigPda(p.programId), true),
      meta(p.quoteMint),
      meta(SystemProgram.programId),
    ],
    discriminated(ISOLATED_DISCRIMINATOR.initIsolatedConfig, encodeIsolatedConfigArgs(p.args)),
    p.programId,
  );
}

/** Fee and on/off apply now; a changed AMM list is queued for 24 h. */
export function setIsolatedConfigIx(p: IsolatedProgramAccounts & { admin: PublicKey; args: IsolatedConfigArgs }) {
  return ix(
    [meta(p.global), meta(p.admin, false, true), meta(isolatedConfigPda(p.programId), true)],
    discriminated(ISOLATED_DISCRIMINATOR.setIsolatedConfig, encodeIsolatedConfigArgs(p.args)),
    p.programId,
  );
}

export function applyIsolatedAmmsIx(programId?: PublicKey) {
  return ix([meta(isolatedConfigPda(programId), true)], discriminated(ISOLATED_DISCRIMINATOR.applyIsolatedAmms), programId);
}

export interface PoolAccounts {
  pool: PublicKey;
  collateralVault: PublicKey;
  quoteVault: PublicKey;
  /** The AMM's ProgramData, as pinned in `IsolatedConfig`. */
  ammProgramData: PublicKey;
}

/**
 * Step 1 of 3: create the market, oracles, history and bond vault; take the
 * bond and the creation fee. For a single-pool market pass the same pool twice.
 * Needs ~400k compute units; add a ComputeBudget limit.
 */
export function createIsolatedMarketIx(p: IsolatedProgramAccounts & {
  creator: PublicKey;
  nextMarketId: bigint;
  tokenMint: PublicKey;
  quoteMint: PublicKey;
  creatorQuote: PublicKey;
  feeDestinationQuote: PublicKey;
  tier: number;
  bond: bigint;
  pools: [PoolAccounts & { ammIndex: number }, PoolAccounts & { ammIndex: number }];
  quoteTokenProgram?: PublicKey;
}) {
  const a = isolatedMarketAddresses(p.nextMarketId, p.tokenMint, p.quoteMint, p.programId);
  const body = new Writer().u8(p.tier).u64(p.bond);
  for (const pool of p.pools) {
    body.key(pool.pool).key(pool.collateralVault).key(pool.quoteVault).u8(pool.ammIndex);
  }
  const [pa, pb] = p.pools;
  return ix(
    [
      meta(p.creator, true, true),
      meta(p.global),
      meta(isolatedConfigPda(p.programId), true),
      meta(a.market, true),
      meta(a.isolatedMarket, true),
      meta(p.tokenMint),
      meta(p.quoteMint),
      meta(a.tokenOracle, true),
      meta(a.quoteOracle, true),
      meta(a.isolatedOracle, true),
      meta(a.bondVault, true),
      meta(p.creatorQuote, true),
      meta(p.feeDestinationQuote, true),
      meta(pa.pool),
      meta(pa.collateralVault),
      meta(pa.quoteVault),
      meta(pa.ammProgramData),
      meta(pb.pool),
      meta(pb.collateralVault),
      meta(pb.quoteVault),
      meta(pb.ammProgramData),
      meta(p.quoteTokenProgram ?? TOKEN_PROGRAM_ID),
      meta(SystemProgram.programId),
    ],
    discriminated(ISOLATED_DISCRIMINATOR.createIsolatedMarket, body.done()),
    p.programId,
  );
}

function reserveKeys(p: {
  programId?: PublicKey; creator: PublicKey; market: PublicKey; mint: PublicKey; tokenProgram: PublicKey;
}) {
  const reserve = reservePda(p.market, p.mint, p.programId);
  return {
    reserve,
    keys: [
      meta(p.creator, true, true),
      meta(isolatedMarketPda(p.market, p.programId), true),
      meta(p.market),
      meta(reserve, true),
      meta(p.mint),
      meta(liquidityVaultPda(reserve, p.programId), true),
      meta(shareMintPda(reserve, p.programId), true),
      meta(oraclePda(p.market, p.mint, p.programId)),
    ],
  };
}

/** Step 2 of 3: the token (collateral) reserve. */
export function initIsolatedCollateralReserveIx(p: {
  programId?: PublicKey; creator: PublicKey; market: PublicKey; tokenMint: PublicKey; tokenProgram?: PublicKey;
}) {
  const tokenProgram = p.tokenProgram ?? TOKEN_PROGRAM_ID;
  const { keys } = reserveKeys({ ...p, mint: p.tokenMint, tokenProgram });
  keys.push(meta(tokenProgram), meta(TOKEN_2022_PROGRAM_ID), meta(SystemProgram.programId));
  return ix(keys, discriminated(ISOLATED_DISCRIMINATOR.initIsolatedCollateralReserve), p.programId);
}

/** Step 3 of 3: the SOL (lending) reserve and its per-wallet cap. Borrowing opens once the oracle bootstraps. */
export function initIsolatedQuoteReserveIx(p: {
  programId?: PublicKey; creator: PublicKey; market: PublicKey; quoteMint: PublicKey; tokenProgram?: PublicKey;
}) {
  const tokenProgram = p.tokenProgram ?? TOKEN_PROGRAM_ID;
  const { reserve, keys } = reserveKeys({ ...p, mint: p.quoteMint, tokenProgram });
  keys.push(
    meta(riskConfigPda(reserve, p.programId), true),
    meta(tokenProgram),
    meta(TOKEN_2022_PROGRAM_ID),
    meta(SystemProgram.programId),
  );
  return ix(keys, discriminated(ISOLATED_DISCRIMINATOR.initIsolatedQuoteReserve), p.programId);
}

/**
 * The creator-market oracle refresh.
 *
 * **Records a sample only when sent in a transaction of its own** (ComputeBudget
 * instructions aside). Keepers must send it standalone every `minSpacingSeconds`.
 * Bundled with a borrow or liquidation it still makes the oracle fresh, which is
 * what those need.
 */
export function refreshIsolatedOracleIx(p: {
  programId?: PublicKey;
  tokenOracle: PublicKey;
  pools: [PoolAccounts, PoolAccounts];
}) {
  const [a, b] = p.pools;
  return ix(
    [
      meta(p.tokenOracle, true),
      meta(isolatedOraclePda(p.tokenOracle, p.programId), true),
      meta(a.pool),
      meta(a.collateralVault),
      meta(a.quoteVault),
      meta(b.pool),
      meta(b.collateralVault),
      meta(b.quoteVault),
      meta(a.ammProgramData),
      meta(b.ammProgramData),
      meta(INSTRUCTIONS_SYSVAR),
    ],
    discriminated(ISOLATED_DISCRIMINATOR.refreshIsolatedOracle),
    p.programId,
  );
}

/** Build the refresh from a decoded `IsolatedOracle`, as a keeper does. */
export function refreshIsolatedOracleFromAccount(oracle: IsolatedOracleAccount, programId?: PublicKey) {
  const pool = (i: 0 | 1): PoolAccounts => ({
    pool: oracle.pools[i].pool,
    collateralVault: oracle.pools[i].collateralVault,
    quoteVault: oracle.pools[i].quoteVault,
    ammProgramData: oracle.pools[i].ammProgramData,
  });
  return refreshIsolatedOracleIx({ programId, tokenOracle: oracle.oracle, pools: [pool(0), pool(1)] });
}

/** Mint the creator their fee as shares. Permissionless; precede with `accrue` on the quote reserve. */
export function harvestCreatorFeesIx(p: {
  programId?: PublicKey; market: PublicKey; quoteMint: PublicKey; creatorShareAccount: PublicKey;
}) {
  const reserve = reservePda(p.market, p.quoteMint, p.programId);
  return ix(
    [
      meta(isolatedMarketPda(p.market, p.programId), true),
      meta(reserve, true),
      meta(shareMintPda(reserve, p.programId), true),
      meta(p.creatorShareAccount, true),
      meta(TOKEN_2022_PROGRAM_ID),
    ],
    discriminated(ISOLATED_DISCRIMINATOR.harvestCreatorFees),
    p.programId,
  );
}

function limitKeys(p: { programId?: PublicKey; market: PublicKey; quoteMint: PublicKey }) {
  const reserve = reservePda(p.market, p.quoteMint, p.programId);
  return [
    meta(isolatedMarketPda(p.market, p.programId), true),
    meta(reserve, true),
    meta(riskConfigPda(reserve, p.programId), true),
  ];
}

/** Admin kill switch. `frozen = false` queues an unfreeze; send again after 24 h to apply. */
export function freezeIsolatedMarketIx(p: IsolatedProgramAccounts & { admin: PublicKey; market: PublicKey; quoteMint: PublicKey; frozen: boolean }) {
  return ix(
    [meta(p.global), meta(p.admin, false, true), ...limitKeys(p)],
    discriminated(ISOLATED_DISCRIMINATOR.freezeIsolatedMarket, new Writer().bool(p.frozen).done()),
    p.programId,
  );
}

export function retireIsolatedMarketIx(p: { programId?: PublicKey; creator: PublicKey; market: PublicKey; quoteMint: PublicKey }) {
  return ix(
    [meta(p.creator, false, true), ...limitKeys(p)],
    discriminated(ISOLATED_DISCRIMINATOR.retireIsolatedMarket),
    p.programId,
  );
}

function bondKeys(p: { programId?: PublicKey; creator: PublicKey; market: PublicKey; quoteMint: PublicKey; creatorQuote: PublicKey; quoteTokenProgram?: PublicKey }) {
  return [
    // `Global`, so a protocol-wide pause holds the bond (withdrawals only).
    meta(globalPda(p.programId)),
    meta(p.creator, false, true),
    ...limitKeys(p),
    meta(p.quoteMint),
    meta(isolatedBondVaultPda(p.market, p.programId), true),
    meta(p.creatorQuote, true),
    meta(p.quoteTokenProgram ?? TOKEN_PROGRAM_ID),
  ];
}

export function topUpBondIx(p: Parameters<typeof bondKeys>[0] & { amount: bigint }) {
  return ix(bondKeys(p), discriminated(ISOLATED_DISCRIMINATOR.topUpBond, new Writer().u64(p.amount).done()), p.programId);
}

/** Precede with `accrue` on the quote reserve. Refused if the rest would not cover live debt at 80%. */
export function withdrawBondIx(p: Parameters<typeof bondKeys>[0] & { amount: bigint }) {
  return ix(bondKeys(p), discriminated(ISOLATED_DISCRIMINATOR.withdrawBond, new Writer().u64(p.amount).done()), p.programId);
}

export function syncIsolatedCapsIx(p: { programId?: PublicKey; market: PublicKey; tokenMint: PublicKey; quoteMint: PublicKey }) {
  const reserve = reservePda(p.market, p.quoteMint, p.programId);
  const tokenOracle = oraclePda(p.market, p.tokenMint, p.programId);
  return ix(
    [
      meta(isolatedMarketPda(p.market, p.programId), true),
      meta(isolatedOraclePda(tokenOracle, p.programId)),
      meta(reserve, true),
      meta(riskConfigPda(reserve, p.programId), true),
    ],
    discriminated(ISOLATED_DISCRIMINATOR.syncIsolatedCaps),
    p.programId,
  );
}

export function syncIsolatedAmmPinsIx(p: { programId?: PublicKey; market: PublicKey; tokenMint: PublicKey }) {
  const tokenOracle = oraclePda(p.market, p.tokenMint, p.programId);
  return ix(
    [
      meta(isolatedConfigPda(p.programId)),
      meta(isolatedMarketPda(p.market, p.programId)),
      meta(isolatedOraclePda(tokenOracle, p.programId), true),
    ],
    discriminated(ISOLATED_DISCRIMINATOR.syncIsolatedAmmPins),
    p.programId,
  );
}

/**
 * The bond repays a bad loan. Precede with the market prelude and
 * `refresh_obligation` for the underwater case; the dead-oracle and
 * no-collateral cases need only `accrue` on the quote reserve.
 */
export function coverIsolatedDebtIx(p: {
  programId?: PublicKey;
  market: PublicKey;
  obligation: PublicKey;
  tokenMint: PublicKey;
  quoteMint: PublicKey;
  creatorCollateralAccount: PublicKey;
  quoteTokenProgram?: PublicKey;
}) {
  const quoteReserve = reservePda(p.market, p.quoteMint, p.programId);
  const tokenReserve = reservePda(p.market, p.tokenMint, p.programId);
  const tokenOracle = oraclePda(p.market, p.tokenMint, p.programId);
  return ix(
    [
      meta(isolatedMarketPda(p.market, p.programId), true),
      meta(p.market),
      meta(p.obligation, true),
      meta(quoteReserve, true),
      meta(tokenReserve),
      meta(isolatedOraclePda(tokenOracle, p.programId)),
      meta(riskConfigPda(quoteReserve, p.programId), true),
      meta(p.quoteMint),
      meta(liquidityVaultPda(quoteReserve, p.programId), true),
      meta(isolatedBondVaultPda(p.market, p.programId), true),
      meta(shareMintPda(tokenReserve, p.programId)),
      meta(obligationShareVaultPda(tokenReserve, p.obligation, p.programId), true),
      meta(p.creatorCollateralAccount, true),
      meta(p.quoteTokenProgram ?? TOKEN_PROGRAM_ID),
      meta(TOKEN_2022_PROGRAM_ID),
    ],
    discriminated(ISOLATED_DISCRIMINATOR.coverIsolatedDebt),
    p.programId,
  );
}

/** `SetComputeUnitLimit`, for creation. */
export function computeUnitLimitIx(units: number) {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return new TransactionInstruction({ programId: COMPUTE_BUDGET_PROGRAM_ID, keys: [], data: Buffer.from(data) });
}
