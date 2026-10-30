/**
 * Offline wiring check for the SDK.
 *
 * Builds every instruction the SDK can produce and asserts the account list it
 * hands Anchor matches the IDL. Nothing is sent and no RPC is required.
 *
 * This covers the one thing the Rust tests cannot: the Rust suite proves the
 * *program* is correct, but the SDK's account objects are hand-written, and a
 * misspelled or missing key there is invisible to `tsc` — Anchor resolves
 * account names from the IDL at instruction-build time, so a wrong name throws
 * here and only here.
 *
 *   node sdk/smoke.mjs
 */

import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

import {
  AeraAdmin,
  AeraClient,
  BCOOK_RESERVE_CONFIG,
  COOK_RESERVE_CONFIG,
  nativeBcookConfig,
  unitOfAccountConfig,
  riskConfigPda,
} from './dist/index.js';
import idl from './idl/aera.json' with { type: 'json' };

const client = new AeraClient({ marketId: 0 });
// Offline mint identity for instruction builders. Real clients read the owner
// from chain; this smoke harness deliberately makes no network requests.
client.connection.getAccountInfo = async () => {
  const data = Buffer.alloc(82);
  data[44] = 9;
  data[45] = 1;
  return { data, owner: TOKEN_PROGRAM_ID, executable: false, lamports: 1 };
};
const admin = new AeraAdmin(client);

const META = { name: 'Aera COOK', symbol: 'aCOOK', uri: 'https://aera.io/acook.json' };
const owner = Keypair.generate().publicKey;
const other = Keypair.generate().publicKey;
const cook = Keypair.generate().publicKey;
const bcook = Keypair.generate().publicKey;

/** Accounts the IDL declares for an instruction, in order. */
const expected = (name) => {
  const entry = idl.instructions.find((ix) => ix.name === name);
  if (!entry) throw new Error(`no instruction "${name}" in the IDL`);
  return entry.accounts.map((a) => a.name);
};

let failures = 0;
let checked = 0;

const check = async (idlName, label, build) => {
  checked += 1;
  try {
    const instruction = await build();
    const want = expected(idlName);
    const got = instruction.keys.length;
    if (got !== want.length) {
      console.log(`  FAIL ${label}: ${got} accounts, IDL declares ${want.length} (${want.join(', ')})`);
      failures += 1;
      return;
    }
    if (!instruction.programId.equals(client.programId)) {
      console.log(`  FAIL ${label}: wrong program id`);
      failures += 1;
      return;
    }
    console.log(`  ok   ${label}  (${got} accounts)`);
  } catch (error) {
    console.log(`  FAIL ${label}: ${error.message}`);
    failures += 1;
  }
};

console.log(`\nprogram ${client.programId.toBase58()}`);
console.log(`market  ${client.market.toBase58()}\n`);

console.log('admin:');
await check('init_global', 'initGlobal', () => admin.initGlobal(owner, other));
await check('set_fee_destination', 'setFeeDestination', () =>
  admin.setFeeDestination(owner, other),
);
await check('set_admin', 'setAdmin', () => admin.setAdmin(owner, other));
await check('init_market', 'initMarket', () => admin.initMarket(owner, 0, 'Aera Core', cook));
await check('set_oracle', 'setOracle (COOK, unit of account)', () =>
  admin.setOracle(owner, cook, unitOfAccountConfig()),
);
await check('init_reserve', 'initReserve (COOK)', () =>
  admin.initReserve(owner, cook, COOK_RESERVE_CONFIG, META),
);
await check('init_reserve', 'initReserve (bCOOK)', () =>
  admin.initReserve(owner, bcook, BCOOK_RESERVE_CONFIG, META),
);
await check('set_params', 'setParams', () => admin.setParams(owner, cook, COOK_RESERVE_CONFIG));
await check('apply_pending_params', 'applyPendingParams', () => admin.applyPendingParams(cook));
await check('pause_all', 'pauseAll', () => admin.pauseAll(owner));
await check('pause_borrow', 'pauseBorrow', () => admin.pauseBorrow(owner));
await check('unpause', 'unpause', () => admin.unpause(owner));
await check('set_oracle', 'setOracle (bCOOK, derived from the stake pool)', () =>
  admin.setOracle(owner, bcook, nativeBcookConfig()),
);

console.log('\nuser:');
await check('accrue', 'accrueIx', () => client.accrueIx(client.reserveAddress(cook)));
await check('refresh_oracle', 'refreshOracleIx', () =>
  client.refreshOracleIx(cook),
);

// The instruction builders that need an on-chain read are exercised through
// their inner `.instruction()` call, which is where account names are resolved.
const methods = client.methods;
const { globalPda, liquidityVaultPda, obligationPda, obligationShareVaultPda, oraclePda, reservePda, shareMintPda, supplyPositionPda } =
  await import('./dist/pda.js');
const { getAssociatedTokenAddressSync } = await import('@solana/spl-token');
const { SystemProgram } = await import('@solana/web3.js');
const { shareAta } = await import('./dist/index.js');
/*
 * Same reason as sdk/src: anchor re-exports `BN` from bn.js rather than
 * assigning it, so a dynamic import's `.BN` is undefined on Node 20 and 22 and
 * every `new BN(...)` below fails with "BN is not a constructor". bn.js sets
 * `module.exports = BN`, and the `.default` unwrap covers the runtimes that
 * hand back the namespace instead.
 */
const BNModule = (await import('bn.js')).default;
const BN = BNModule?.default ?? BNModule;

const market = client.market;
const cookReserve = reservePda(market, cook, client.programId);
const bcookReserve = reservePda(market, bcook, client.programId);
const obligation = obligationPda(market, owner, client.programId);

await check('supply', 'supply', () =>
  methods
    .supply(new BN(1))
    .accounts({
      global: globalPda(client.programId),
      reserve: cookReserve,
      liquidityMint: cook,
      liquidityVault: liquidityVaultPda(cookReserve, client.programId),
      shareMint: shareMintPda(cookReserve, client.programId),
      userLiquidity: getAssociatedTokenAddressSync(cook, owner),
      userShare: shareAta(shareMintPda(cookReserve, client.programId), owner),
      supplyPosition: supplyPositionPda(cookReserve, owner, client.programId),
      owner,
      liquidityTokenProgram: TOKEN_PROGRAM_ID,
      shareTokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction(),
);

await check('withdraw', 'withdraw', () =>
  methods
    .withdraw(new BN(1))
    .accounts({
      global: globalPda(client.programId),
      reserve: cookReserve,
      liquidityMint: cook,
      liquidityVault: liquidityVaultPda(cookReserve, client.programId),
      shareMint: shareMintPda(cookReserve, client.programId),
      userLiquidity: getAssociatedTokenAddressSync(cook, owner),
      userShare: shareAta(shareMintPda(cookReserve, client.programId), owner),
      supplyPosition: supplyPositionPda(cookReserve, owner, client.programId),
      owner,
      liquidityTokenProgram: TOKEN_PROGRAM_ID,
      shareTokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction(),
);

await check('init_obligation', 'initObligation', () =>
  methods
    .initObligation()
    .accounts({ market, obligation, owner, systemProgram: SystemProgram.programId })
    .instruction(),
);

await check('deposit_collateral', 'depositCollateral', () =>
  methods
    .depositCollateral(new BN(1))
    .accounts({
      global: globalPda(client.programId),
      obligation,
      owner,
      reserve: bcookReserve,
      shareMint: shareMintPda(bcookReserve, client.programId),
      obligationShareVault: obligationShareVaultPda(bcookReserve, obligation, client.programId),
      userShare: shareAta(shareMintPda(bcookReserve, client.programId), owner),
      shareTokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction(),
);

await check('withdraw_collateral', 'withdrawCollateral', () =>
  methods
    .withdrawCollateral(new BN(1))
    .accounts({
      global: globalPda(client.programId),
      obligation,
      owner,
      reserve: bcookReserve,
      oracle: oraclePda(market, bcook, client.programId),
      shareMint: shareMintPda(bcookReserve, client.programId),
      obligationShareVault: obligationShareVaultPda(bcookReserve, obligation, client.programId),
      userShare: shareAta(shareMintPda(bcookReserve, client.programId), owner),
      shareTokenProgram: TOKEN_2022_PROGRAM_ID,
    })
    .instruction(),
);

await check('borrow', 'borrow', () =>
  methods
    .borrow(new BN(1))
    .accounts({
      global: globalPda(client.programId),
      obligation,
      owner,
      reserve: cookReserve,
      oracle: oraclePda(market, cook, client.programId),
      liquidityMint: cook,
      liquidityVault: liquidityVaultPda(cookReserve, client.programId),
      userLiquidity: getAssociatedTokenAddressSync(cook, owner),
      liquidityTokenProgram: TOKEN_PROGRAM_ID,
      riskConfig: riskConfigPda(cookReserve, client.programId),
    })
    .instruction(),
);

await check('repay', 'repay', () =>
  methods
    .repay(new BN(1))
    .accounts({
      obligation,
      reserve: cookReserve,
      liquidityMint: cook,
      liquidityVault: liquidityVaultPda(cookReserve, client.programId),
      userLiquidity: getAssociatedTokenAddressSync(cook, owner),
      repayer: owner,
      liquidityTokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction(),
);

await check('liquidate', 'liquidate', () =>
  methods
    .liquidate(new BN(1))
    .accounts({
      global: globalPda(client.programId),
      obligation,
      liquidator: other,
      repayReserve: cookReserve,
      collateralReserve: bcookReserve,
      repayOracle: oraclePda(market, cook, client.programId),
      collateralOracle: oraclePda(market, bcook, client.programId),
      repayLiquidityMint: cook,
      collateralShareMint: shareMintPda(bcookReserve, client.programId),
      repayLiquidityVault: liquidityVaultPda(cookReserve, client.programId),
      obligationCollateralVault: obligationShareVaultPda(bcookReserve, obligation, client.programId),
      liquidatorRepaySource: getAssociatedTokenAddressSync(cook, other),
      liquidatorCollateralDest: shareAta(shareMintPda(bcookReserve, client.programId), other),
      collateralRiskConfig: riskConfigPda(bcookReserve, client.programId),
      protocolCollateralDest: shareAta(shareMintPda(bcookReserve, client.programId), owner),
      liquidityTokenProgram: TOKEN_PROGRAM_ID,
      shareTokenProgram: TOKEN_2022_PROGRAM_ID,
    })
    .instruction(),
);

await check('collect_fees', 'collectFees', () =>
  methods
    .collectFees()
    .accounts({
      global: globalPda(client.programId),
      reserve: cookReserve,
      liquidityMint: cook,
      liquidityVault: liquidityVaultPda(cookReserve, client.programId),
      feeToken: getAssociatedTokenAddressSync(cook, other),
      liquidityTokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction(),
);

// Every PDA the SDK derives must be a valid off-curve address.
console.log('\npdas:');
for (const [label, address] of [
  ['global', globalPda(client.programId)],
  ['market', market],
  ['reserve(COOK)', cookReserve],
  ['shareMint(COOK)', shareMintPda(cookReserve, client.programId)],
  ['liquidityVault(COOK)', liquidityVaultPda(cookReserve, client.programId)],
  ['oracle(COOK)', oraclePda(market, cook, client.programId)],
  ['oracle(bCOOK)', oraclePda(market, bcook, client.programId)],
  ['obligation', obligation],
  ['obligationShareVault', obligationShareVaultPda(bcookReserve, obligation, client.programId)],
  ['supplyPosition', supplyPositionPda(cookReserve, owner, client.programId)],
]) {
  checked += 1;
  if (PublicKey.isOnCurve(address.toBytes())) {
    console.log(`  FAIL ${label} is on-curve — not a valid PDA`);
    failures += 1;
  } else {
    console.log(`  ok   ${label}  ${address.toBase58()}`);
  }
}

console.log(`\n${checked - failures}/${checked} passed`);
process.exit(failures > 0 ? 1 : 0);
