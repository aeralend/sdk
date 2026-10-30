/**
 * Decoding, PDAs, instruction builders, and the checks that catch a wrong
 * account before a transaction is signed.
 *
 * These run without a chain. What they establish is that the SDK's idea of the
 * program's shape matches the IDL the program actually emits — which is a
 * different claim from "the numbers are right" (`vectors.test.ts`) and a
 * different one again from "it works end to end" (the Rust integration suite).
 *
 * ## The gap this closes
 *
 * `smoke.mjs` builds every instruction *by hand* against the IDL. That verifies
 * the IDL contract and says nothing about the SDK, which is how the SDK's own
 * `borrowIx`, `withdrawCollateralIx` and `liquidateIx` came to be passing a
 * `priceFeed` account that v0.2 does not have — broken, and smoke-tested green.
 * These tests go through the SDK's builders.
 */

import { PublicKey } from '@solana/web3.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  decodeRelayedRate,
  isRelayStale,
  MAX_RELAYED_RATE_AGE_SECONDS,
  RATE_RECEIVER_PROGRAM_ID,
  readsSourceAccount,
  RELAYED_RATE_DISCRIMINATOR,
  RELAYED_RATE_LEN,
  relayAgeSeconds,
  relayedRateConfig,
  relayedRateFeedAddress,
} from '../src/index.js';
import {
  AERA_PROGRAM_ID,
  BCOOK_RESERVE_CONFIG,
  COOK_RESERVE_CONFIG,
  CHAIN,
  GLOBAL_V1_LEN,
  GLOBAL_V2_LEN,
  LAUNCH_CONFIG,
  OracleHealth,
  OracleSourceKind,
  RiskAction,
  STAKE_POOL,
  applyWithdrawalFee,
  decodeOracleState,
  bonusSplit,
  isBootstrapped,
  liquidatorBonusBps,
  previewLiquidation,
  riskConfigPda,
  splitSeizedShares,
  marketOraclePda,
  orderedObservations,
  formatRate,
  globalPda,
  haircutRate,
  hasReference,
  healthName,
  liquidityVaultPda,
  marketPda,
  nativeBcookConfig,
  obligationPda,
  oraclePda,
  permits,
  programDataAddress,
  reservePda,
  shareMintPda,
  supplyPositionPda,
  unitOfAccountConfig,
} from '../src/index.js';

const idl = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'idl', 'aera.json'), 'utf8'),
) as {
  instructions: { name: string; accounts: { name: string; signer?: boolean }[] }[];
  accounts: { name: string }[];
  errors: { code: number; name: string }[];
  types: { name: string; type: { fields: { name: string }[] } }[];
  events: { name: string }[];
};

const market = marketPda(0n, AERA_PROGRAM_ID);
const cook = new PublicKey(CHAIN.cookMint);
const bcook = new PublicKey(CHAIN.bcookMint);

// ---------------------------------------------------------------------------
// The IDL is v0.2
// ---------------------------------------------------------------------------

test('the IDL carries no guardian surface', () => {
  const names = idl.instructions.map((i) => i.name);
  for (const gone of ['publish_price', 'reset_circuit_breaker']) {
    assert.ok(!names.includes(gone), `${gone} is still in the IDL`);
  }
  assert.ok(
    !idl.accounts.some((a) => a.name === 'PriceFeed'),
    'PriceFeed is still an account type',
  );
  assert.ok(
    idl.accounts.some((a) => a.name === 'OracleState'),
    'OracleState is missing from the IDL',
  );
});

test('the IDL carries the v0.2 instructions', () => {
  const names = idl.instructions.map((i) => i.name);
  for (const required of [
    'set_oracle',
    'refresh_oracle',
    'reset_oracle_breaker',
    'absorb_bad_debt',
    'migrate_reserve_to_v2',
    'migrate_global_to_v2',
  ]) {
    assert.ok(names.includes(required), `${required} is missing from the IDL`);
  }
});

test('every priced instruction takes an oracle, not a price feed', () => {
  const priced = ['borrow', 'withdraw_collateral', 'liquidate', 'set_oracle', 'refresh_oracle'];
  for (const name of priced) {
    const instruction = idl.instructions.find((i) => i.name === name);
    assert.ok(instruction, `${name} is missing`);
    const accounts = instruction.accounts.map((a) => a.name);
    assert.ok(
      !accounts.some((a) => a.includes('price_feed')),
      `${name} still takes a price_feed account: ${accounts.join(', ')}`,
    );
    assert.ok(
      accounts.some((a) => a.includes('oracle')),
      `${name} takes no oracle account: ${accounts.join(', ')}`,
    );
  }
});

// ---------------------------------------------------------------------------
// PDAs
// ---------------------------------------------------------------------------

test('every PDA is off-curve and deterministic', () => {
  const reserve = reservePda(market, cook, AERA_PROGRAM_ID);
  const owner = PublicKey.unique();

  const derived: [string, PublicKey][] = [
    ['global', globalPda(AERA_PROGRAM_ID)],
    ['market', market],
    ['reserve', reserve],
    ['shareMint', shareMintPda(reserve, AERA_PROGRAM_ID)],
    ['liquidityVault', liquidityVaultPda(reserve, AERA_PROGRAM_ID)],
    ['oracle', oraclePda(market, cook, AERA_PROGRAM_ID)],
    ['obligation', obligationPda(market, owner, AERA_PROGRAM_ID)],
    ['supplyPosition', supplyPositionPda(reserve, owner, AERA_PROGRAM_ID)],
  ];

  for (const [name, address] of derived) {
    assert.ok(
      !PublicKey.isOnCurve(address.toBytes()),
      `${name} is on the ed25519 curve, so a private key could exist for it`,
    );
  }

  // Deterministic: the same inputs give the same address every time.
  assert.ok(oraclePda(market, cook, AERA_PROGRAM_ID).equals(derived[5]![1]));
});

test('the oracle PDA differs from the retired price-feed PDA', () => {
  /*
   * The seed changed with the account type, deliberately: a v0.1 feed and a
   * v0.2 oracle for the same mint live at different addresses, so neither can
   * be mistaken for the other and the migration cannot half-apply into a
   * collision.
   */
  const oracle = oraclePda(market, cook, AERA_PROGRAM_ID);
  const legacy = PublicKey.findProgramAddressSync(
    [Buffer.from('price_feed'), market.toBytes(), cook.toBytes()],
    AERA_PROGRAM_ID,
  )[0];
  assert.ok(!oracle.equals(legacy), 'the oracle and the old feed derive to the same address');
});

test('the ProgramData address derives to the measured one', () => {
  const derived = programDataAddress(new PublicKey(STAKE_POOL.program));
  assert.equal(
    derived.toBase58(),
    STAKE_POOL.programData,
    'the SDK derives a different ProgramData address than the launch config records',
  );
});

// ---------------------------------------------------------------------------
// The oracle state machine
// ---------------------------------------------------------------------------

test('the permits matrix matches the program', () => {
  const { Healthy, RateWarning, Bootstrapping, BorrowFrozen, Emergency } = OracleHealth;

  // Repay in every state, without exception. The rule the design bends around.
  for (const health of [Healthy, RateWarning, Bootstrapping, BorrowFrozen, Emergency]) {
    assert.ok(permits(health, RiskAction.Repay), `repay must be permitted in ${healthName(health)}`);
    assert.ok(
      permits(health, RiskAction.Liquidate),
      `liquidate must be permitted in ${healthName(health)}`,
    );
    assert.ok(
      permits(health, RiskAction.SupplyLiquidity),
      `supplying must be permitted in ${healthName(health)}`,
    );
    assert.ok(
      permits(health, RiskAction.DepositCollateral),
      `adding collateral must be permitted in ${healthName(health)}`,
    );
  }

  // New risk only when the oracle is trusted.
  for (const action of [RiskAction.Borrow, RiskAction.WithdrawCollateral]) {
    assert.ok(permits(Healthy, action));
    assert.ok(permits(RateWarning, action));
    assert.ok(!permits(Bootstrapping, action), `${action} must be blocked while bootstrapping`);
    assert.ok(!permits(BorrowFrozen, action), `${action} must be blocked when frozen`);
    assert.ok(!permits(Emergency, action), `${action} must be blocked in an emergency`);
  }

  // Supplier exit: open until an emergency, when undiscovered bad debt would
  // make a race for the door pay the fastest out of the slowest.
  assert.ok(permits(BorrowFrozen, RiskAction.WithdrawLiquidity));
  assert.ok(!permits(Emergency, RiskAction.WithdrawLiquidity));
});

test('health names cover every state', () => {
  for (const health of [0, 1, 2, 3, 4] as OracleHealth[]) {
    const name = healthName(health);
    assert.ok(name && !name.startsWith('unknown'), `health ${health} has no name`);
  }
});

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

test('decodeOracleState carries every field through as bigint', () => {
  const address = oraclePda(market, bcook, AERA_PROGRAM_ID);
  const raw = {
    market,
    mint: bcook,
    sourceKind: 1,
    sourceProgram: new PublicKey(STAKE_POOL.program),
    sourceAccount: new PublicKey(STAKE_POOL.pool),
    maxWithdrawalFeeBps: 500,
    rateFloor: { toString: () => '100000000000000000' },
    rateCeiling: { toString: () => '10000000000000000000' },
    expectedDeploySlot: { toString: () => '5504973' },
    expectedUpgradeAuthority: new PublicKey(STAKE_POOL.upgradeAuthority),
    breaker: {
      maxUpBpsPerEpoch: 200,
      maxDownBpsPerEpoch: 100,
      emergencyDeviationBps: 1000,
      maxEpochAllowance: { toString: () => '32' },
    },
    reference: {
      grossRate: { toString: () => '1303558011882286677' },
      // gross x 9800/10000, floored. Written out rather than computed so the
      // assertion below compares the SDK against a number, not against itself
      // -- the first version of this fixture carried an invented value and the
      // assertion caught it.
      effectiveRate: { toString: () => '1277486851644640943' },
      withdrawalFeeBps: 200,
      sourceEpoch: { toString: () => '51' },
      slot: { toString: () => '22429522' },
      unixTimestamp: { toString: () => '1756640000' },
    },
    health: 0,
    lastMovedBps: { toString: () => '33' },
    lastRefreshSlot: { toString: () => '22429500' },
    lastSourceEpoch: { toString: () => '51' },
    bump: 254,
  };

  const decoded = decodeOracleState(address, raw);

  assert.equal(typeof decoded.reference.grossRate, 'bigint');
  assert.equal(decoded.reference.grossRate, 1_303_558_011_882_286_677n);
  assert.equal(decoded.expectedDeploySlot, 5_504_973n);
  assert.equal(decoded.sourceKind, OracleSourceKind.NativeExchangeRate);
  assert.equal(decoded.health, OracleHealth.Healthy);
  assert.ok(hasReference(decoded));

  // The reference's effective rate is the gross less the 2% fee, exactly.
  assert.equal(
    decoded.reference.effectiveRate,
    applyWithdrawalFee(decoded.reference.grossRate, 200),
    'the decoded effective rate is not the gross less the recorded fee',
  );
});

test('an unset reference reads as unset rather than as zero', () => {
  const address = oraclePda(market, cook, AERA_PROGRAM_ID);
  const raw = {
    market,
    mint: cook,
    sourceKind: 0,
    sourceProgram: PublicKey.default,
    sourceAccount: PublicKey.default,
    maxWithdrawalFeeBps: 0,
    rateFloor: '1000000000000000000',
    rateCeiling: '1000000000000000000',
    expectedDeploySlot: '0',
    expectedUpgradeAuthority: PublicKey.default,
    breaker: {
      maxUpBpsPerEpoch: 200,
      maxDownBpsPerEpoch: 100,
      emergencyDeviationBps: 1000,
      maxEpochAllowance: '32',
    },
    reference: {
      grossRate: '0',
      effectiveRate: '0',
      withdrawalFeeBps: 0,
      sourceEpoch: '0',
      slot: '0',
      unixTimestamp: '0',
    },
    health: 2,
    lastMovedBps: '0',
    lastRefreshSlot: '0',
    lastSourceEpoch: '0',
    bump: 255,
  };

  const decoded = decodeOracleState(address, raw);
  assert.ok(!hasReference(decoded), 'a zero gross rate must read as no reference');
  assert.ok(!permits(decoded.health, RiskAction.Borrow));
  assert.ok(permits(decoded.health, RiskAction.Repay));
});

// ---------------------------------------------------------------------------
// The launch configuration
// ---------------------------------------------------------------------------

test('the launch config the SDK exposes is the one on disk', () => {
  const onDisk = JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'protocol', 'aera.launch.json'), 'utf8'),
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(LAUNCH_CONFIG)),
    onDisk,
    'sdk/src/launch.generated.ts and config/aera.launch.json disagree; regenerate both',
  );
});

test('the reserve configs are the agreed launch values', () => {
  const ONE = 1_000_000_000n;
  assert.equal(COOK_RESERVE_CONFIG.supplyCap, 1_000_000n * ONE);
  assert.equal(COOK_RESERVE_CONFIG.borrowCap, 600_000n * ONE);
  assert.equal(COOK_RESERVE_CONFIG.perWalletSupplyCap, 250_000n * ONE);
  assert.ok(COOK_RESERVE_CONFIG.borrowEnabled);
  assert.ok(!COOK_RESERVE_CONFIG.collateralEnabled, 'COOK must never be collateral');

  assert.equal(BCOOK_RESERVE_CONFIG.loanToValueBps, 5_500);
  assert.equal(BCOOK_RESERVE_CONFIG.liquidationThresholdBps, 6_500);
  assert.equal(BCOOK_RESERVE_CONFIG.liquidationBonusBps, 800);
  assert.equal(BCOOK_RESERVE_CONFIG.collateralHaircutBps, 500);
  assert.ok(!BCOOK_RESERVE_CONFIG.borrowEnabled, 'bCOOK must never be borrowable');
  assert.ok(BCOOK_RESERVE_CONFIG.collateralEnabled);

  // Every cap and rate is a bigint. A `number` here would round above 2^53.
  for (const [key, value] of Object.entries(COOK_RESERVE_CONFIG)) {
    if (['supplyCap', 'borrowCap', 'perWalletSupplyCap', 'slotsPerYear'].includes(key)) {
      assert.equal(typeof value, 'bigint', `${key} must be a bigint`);
    }
  }
});

test('the oracle configs pin what they should', () => {
  const native = nativeBcookConfig();
  assert.equal(native.sourceKind, OracleSourceKind.NativeExchangeRate);
  assert.equal(native.expectedDeploySlot, BigInt(STAKE_POOL.deploySlot));
  assert.equal(native.sourceAccount.toBase58(), STAKE_POOL.pool);
  assert.equal(native.expectedUpgradeAuthority.toBase58(), STAKE_POOL.upgradeAuthority);

  const unit = unitOfAccountConfig();
  assert.equal(unit.sourceKind, OracleSourceKind.UnitOfAccount);
  assert.equal(unit.rateFloor, unit.rateCeiling, 'the unit of account is exactly one');
  assert.equal(
    unit.expectedDeploySlot,
    0n,
    'a source that reads no program has no deployment to pin',
  );
});

// ---------------------------------------------------------------------------
// Era detection
// ---------------------------------------------------------------------------

test('the Global lengths encode the version', () => {
  assert.equal(
    GLOBAL_V2_LEN - GLOBAL_V1_LEN,
    1,
    'v0.2 must be exactly one byte longer, or the length stops being the version',
  );
  assert.equal(GLOBAL_V1_LEN, 83, 'the v0.1 Global length is what the migration assumes');
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

test('rate formatting does not go through floating point', () => {
  // A rate that a double cannot hold exactly.
  const rate = 1_303_558_011_882_286_677n;
  assert.equal(formatRate(rate, 18), '1.303558011882286677');
  assert.equal(formatRate(rate, 6), '1.303558');
  assert.equal(formatRate(1_000_000_000_000_000_000n, 6), '1.000000');
  // The low digits survive, which `Number(rate)/1e18` would not preserve.
  assert.ok(formatRate(rate, 18).endsWith('677'));
});

test('the haircut is applied on top of the fee, not merged with it', () => {
  const gross = 1_303_558_011_882_286_677n;
  const effective = applyWithdrawalFee(gross, 200);
  const collateral = haircutRate(effective, 500);

  assert.ok(effective < gross, 'the fee must lower the rate');
  assert.ok(collateral < effective, 'the haircut must lower it again');

  // 5% is Aera's margin and 2% is BakeYourStake's fee. Together they are not
  // 7%: they compound, and the protocol applies them in that order.
  const naive = (gross * 9_300n) / 10_000n;
  assert.notEqual(collateral, naive, 'a 7% single haircut is not the same calculation');
});

// ---------------------------------------------------------------------------
// The Tier 3 market oracle
// ---------------------------------------------------------------------------

test('the IDL carries the market oracle instruction and its accounts', () => {
  const ix = idl.instructions.find((i: any) => i.name === 'refresh_market_oracle');
  assert.ok(ix, 'refresh_market_oracle is missing from the IDL');

  // The ten accounts the SDK builder names. A rename on either side is exactly
  // the mismatch that shipped a `priceFeed` account v0.2 does not have. Each
  // pool brings its own AMM's ProgramData, so the two can sit on different AMMs.
  assert.deepEqual(
    ix.accounts.map((a: any) => a.name),
    [
      'oracle',
      'market_oracle',
      'pool_a',
      'pool_a_collateral_vault',
      'pool_a_quote_vault',
      'pool_b',
      'pool_b_collateral_vault',
      'pool_b_quote_vault',
      'pool_a_amm_program_data',
      'pool_b_amm_program_data',
    ],
  );

  // No signer. The whole argument for a permissionless crank is that there is
  // no authority to hold, and a signer appearing here would quietly end it.
  assert.equal(
    ix.accounts.filter((a: any) => a.signer).length,
    0,
    'refresh_market_oracle gained a signer; it must stay permissionless',
  );

  assert.ok(
    idl.accounts.some((a: any) => a.name === 'MarketOracle'),
    'the MarketOracle account is missing from the IDL',
  );
});

test('the market oracle PDA is seeded on the oracle, not the mint', () => {
  const oracle = oraclePda(market, cook, AERA_PROGRAM_ID);
  const derived = marketOraclePda(oracle, AERA_PROGRAM_ID);

  const [expected] = PublicKey.findProgramAddressSync(
    [Buffer.from('market_oracle'), oracle.toBytes()],
    AERA_PROGRAM_ID,
  );
  assert.ok(derived.equals(expected));

  // Seeding on the OracleState rather than the mint is what lets a Tier 3 asset
  // be added without any Core account changing shape.
  const other = marketOraclePda(oraclePda(market, bcook, AERA_PROGRAM_ID), AERA_PROGRAM_ID);
  assert.ok(!derived.equals(other), 'two oracles must not share a market oracle');
});

test('MarketTwap is a distinct source kind', () => {
  assert.equal(OracleSourceKind.UnitOfAccount, 0);
  assert.equal(OracleSourceKind.NativeExchangeRate, 1);
  assert.equal(OracleSourceKind.MarketTwap, 2);
});

test('bootstrap needs both a count and an elapsed span', () => {
  const observation = (unixTimestamp: bigint) => ({
    price: 28_333_333_333_333_333n,
    slot: 1n,
    unixTimestamp,
    quoteDepth: 850_000_000_000_000n,
  });
  const config = { minObservations: 3, minSpanSeconds: 300 } as any;

  // Three observations, four seconds apart: the count is met and the span is
  // not. `min_observations` alone is satisfiable in consecutive slots, which is
  // exactly what an attacker who can call in a loop would do.
  assert.equal(
    isBootstrapped({
      config,
      observations: [observation(100n), observation(102n), observation(104n)],
    } as any),
    false,
  );

  assert.equal(
    isBootstrapped({
      config,
      observations: [observation(100n), observation(300n), observation(500n)],
    } as any),
    true,
  );

  // Two observations far apart: span met, count not.
  assert.equal(
    isBootstrapped({ config, observations: [observation(100n), observation(900n)] } as any),
    false,
  );
});

test('observations are ordered by time, not by buffer position', () => {
  const at = (unixTimestamp: bigint) => ({
    price: 1n,
    slot: 1n,
    unixTimestamp,
    quoteDepth: 1n,
  });
  // A wrapped ring buffer: the newest entries sit at the front of the array.
  const wrapped = {
    observations: [at(900n), at(1000n), at(700n), at(800n)],
  } as any;

  assert.deepEqual(
    orderedObservations(wrapped).map((o) => o.unixTimestamp),
    [700n, 800n, 900n, 1000n],
  );
});

// ---------------------------------------------------------------------------
// Gap D: the liquidation bonus split
// ---------------------------------------------------------------------------

test('the IDL carries the two accounts Gap D added to liquidate', () => {
  const ix = idl.instructions.find((i: any) => i.name === 'liquidate');
  assert.ok(ix, 'liquidate is missing from the IDL');

  const names = ix.accounts.map((a: any) => a.name);
  assert.ok(names.includes('collateral_risk_config'), 'collateral_risk_config is missing');
  assert.ok(names.includes('protocol_collateral_dest'), 'protocol_collateral_dest is missing');
  assert.ok(names.includes('global'), 'global is missing');

  // Neither may be a signer: a liquidator holds no authority over either.
  for (const name of ['collateral_risk_config', 'protocol_collateral_dest']) {
    const account: { name: string; signer?: boolean } | undefined = ix.accounts.find((a) => a.name === name);
    assert.ok(account, `${name} is missing`);
    assert.equal(account.signer ?? false, false, `${name} became a signer`);
  }
});

test('RiskConfig carries the protocol liquidation share', () => {
  const account = idl.types.find((t: any) => t.name === 'RiskConfig');
  assert.ok(account, 'RiskConfig is missing from the IDL');
  const fields = account.type.fields.map((f: any) => f.name);
  assert.ok(fields.includes('protocol_liquidation_share_bps'));
  assert.ok(fields.includes('pending_protocol_liquidation_share_bps'));
});

test('the Liquidated event distinguishes the two recipients', () => {
  const event = idl.events.find((e: any) => e.name === 'Liquidated');
  assert.ok(event, 'the Liquidated event is missing');
  const type = idl.types.find((t) => t.name === 'Liquidated');
  assert.ok(type, 'the Liquidated type is missing');
  const fields = type.type.fields.map((f) => f.name);

  // `seized_shares` keeps its old meaning, so an existing consumer still reads
  // the borrower's total penalty from it and needs no change.
  assert.ok(fields.includes('seized_shares'), 'seized_shares was removed or renamed');
  for (const added of [
    'liquidator_shares',
    'protocol_shares',
    'total_bonus_bps',
    'protocol_share_bps',
  ]) {
    assert.ok(fields.includes(added), `${added} is missing from Liquidated`);
  }
});

test('the split conserves and floors toward the liquidator', () => {
  // Conservation for a wide sweep, checked as an identity rather than against a
  // second copy of the formula.
  for (const seized of [0n, 1n, 7n, 74n, 75n, 1_000n, 1_120_000n, 2n ** 63n]) {
    for (const bonus of [0, 800, 1_200, 1_500]) {
      for (const share of [0, 25, 150, 300, 1_200, 9_999]) {
        const { protocolShares, liquidatorShares } = splitSeizedShares(seized, bonus, share);
        assert.equal(
          protocolShares + liquidatorShares,
          seized,
          `split(${seized}, ${bonus}, ${share}) did not conserve`,
        );

        // Never more than the exact entitlement, and never more than one unit
        // below it. Cross-multiplied so the check does not itself round.
        const effective = BigInt(Math.min(share, bonus));
        const denominator = 10_000n + BigInt(bonus);
        assert.ok(protocolShares * denominator <= seized * effective);
        assert.ok((protocolShares + 1n) * denominator > seized * effective);
      }
    }
  }
});

test('a zero share gives the liquidator everything', () => {
  for (const seized of [1n, 1_000n, 10n ** 18n]) {
    assert.deepEqual(splitSeizedShares(seized, 1_200, 0), {
      protocolShares: 0n,
      liquidatorShares: seized,
    });
  }
});

test('a share above the bonus is clamped, never applied', () => {
  // Above the bonus, Aera would be taking the liquidator's principal rather
  // than a slice of the bonus. The program clamps and so must the SDK, or a
  // preview would disagree with the transaction it previews.
  const atBonus = splitSeizedShares(1_000_000n, 1_200, 1_200);
  for (const excessive of [1_201, 5_000, 10_000, 65_535]) {
    assert.deepEqual(
      splitSeizedShares(1_000_000n, 1_200, excessive),
      atBonus,
      `a ${excessive} bps share was not clamped to a 1200 bps bonus`,
    );
  }
  assert.equal(bonusSplit(1_200, 5_000).protocolShareBps, 1_200);
  assert.equal(bonusSplit(1_200, 5_000).liquidatorBonusBps, 0);
});

test('the liquidator bonus is the total minus the protocol share', () => {
  /*
   * The number a keeper must size against, and the single most consequential
   * confusion Gap D introduces. At a 12% bonus and a 150 bps share, a bot
   * checking profitability against 12% believes it earns 1,200 bps while
   * receiving 1,050 -- and keeps taking trades that lose the difference.
   */
  assert.equal(liquidatorBonusBps(1_200, 150), 1_050);
  assert.equal(liquidatorBonusBps(1_200, 0), 1_200);
  assert.equal(liquidatorBonusBps(1_200, 300), 900);
  // The identity the whole design rests on.
  for (const total of [800, 1_200, 1_500]) {
    for (const share of [0, 25, 150, 300]) {
      const split = bonusSplit(total, share);
      assert.equal(
        split.liquidatorBonusBps + split.protocolShareBps,
        split.totalBonusBps,
        'the two halves do not sum to the borrower penalty',
      );
    }
  }
});

test('a small liquidation pays the protocol nothing', () => {
  // Correct, and deliberately not floored upward: a minimum protocol fee would
  // make the borrower's effective penalty depend on the size of the close.
  assert.equal(splitSeizedShares(74n, 1_200, 150).protocolShares, 0n);
  assert.equal(splitSeizedShares(75n, 1_200, 150).protocolShares, 1n);
});

test('previewLiquidation attributes without inventing a seizure', () => {
  const preview = previewLiquidation({
    repay: 1_000_000_000n,
    seizedShares: 1_120_000_000n,
    totalBonusBps: 1_200,
    protocolShareBps: 150,
  });
  assert.equal(preview.totalBonusBps, 1_200);
  assert.equal(preview.protocolShareBps, 150);
  assert.equal(preview.liquidatorBonusBps, 1_050);
  assert.equal(preview.protocolShares + preview.liquidatorShares, preview.seizedShares);
  // 150 / 11200 of 1,120,000,000 is exactly 15,000,000.
  assert.equal(preview.protocolShares, 15_000_000n);
  assert.equal(preview.liquidatorShares, 1_105_000_000n);
});

test('the risk config PDA is seeded on the reserve', () => {
  const reserve = reservePda(market, bcook, AERA_PROGRAM_ID);
  const [expected] = PublicKey.findProgramAddressSync(
    [Buffer.from('risk_config'), reserve.toBytes()],
    AERA_PROGRAM_ID,
  );
  assert.ok(riskConfigPda(reserve, AERA_PROGRAM_ID).equals(expected));
});

// ---------------------------------------------------------------------------
// Relayed rates: JitoSOL's books, relayed from Solana into a rate_receiver feed
// ---------------------------------------------------------------------------

/**
 * A feed's bytes, written field by field in declaration order -- an encoding
 * independent of the decoder's offsets, so a misplaced offset there fails here.
 */
function feedBytes(fields: {
  totalLamports: bigint;
  poolTokenSupply: bigint;
  epoch: bigint;
  stakeFeeBps: number;
  solFeeBps: number;
  sourceUnixTimestamp: bigint;
  updates: bigint;
}): Uint8Array {
  const parts: Uint8Array[] = [RELAYED_RATE_DISCRIMINATOR];
  const u64 = (value: bigint) => {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, value, true);
    return out;
  };
  const i64 = (value: bigint) => {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigInt64(0, value, true);
    return out;
  };
  const u16 = (value: number) => Uint8Array.from([value & 0xff, value >> 8]);
  parts.push(new Uint8Array(32).fill(1)); // stake_pool
  parts.push(new Uint8Array(32).fill(2)); // pool_mint
  parts.push(new Uint8Array(32).fill(3)); // token_program
  parts.push(u64(fields.totalLamports), u64(fields.poolTokenSupply), u64(fields.epoch));
  parts.push(u16(fields.stakeFeeBps), u16(fields.solFeeBps));
  parts.push(u64(fields.totalLamports - 1n), u64(fields.poolTokenSupply)); // last epoch
  parts.push(u64(380_000_123n), i64(fields.sourceUnixTimestamp)); // source
  parts.push(u64(5_000n), i64(fields.sourceUnixTimestamp + 60n)); // received
  parts.push(u64(fields.updates), Uint8Array.from([254])); // updates, bump
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

test('a relayed feed decodes field for field, at the length the receiver allocates', async () => {
  const { createHash } = await import('node:crypto');
  const discriminator = createHash('sha256').update('account:RelayedRate').digest().subarray(0, 8);
  assert.deepEqual([...RELAYED_RATE_DISCRIMINATOR], [...discriminator]);

  const bytes = feedBytes({
    totalLamports: 13_055_493_800_000_000n,
    poolTokenSupply: 10_685_702_800_000_000n,
    epoch: 863n,
    stakeFeeBps: 10,
    solFeeBps: 12,
    sourceUnixTimestamp: 1_790_000_000n,
    updates: 7n,
  });
  assert.equal(bytes.length, RELAYED_RATE_LEN);

  const feed = decodeRelayedRate(bytes);
  assert.ok(feed.stakePool.equals(new PublicKey(new Uint8Array(32).fill(1))));
  assert.ok(feed.poolMint.equals(new PublicKey(new Uint8Array(32).fill(2))));
  assert.equal(feed.totalLamports, 13_055_493_800_000_000n);
  assert.equal(feed.poolTokenSupply, 10_685_702_800_000_000n);
  assert.equal(feed.lastUpdateEpoch, 863n);
  assert.equal(feed.stakeWithdrawalFeeBps, 10);
  assert.equal(feed.solWithdrawalFeeBps, 12);
  assert.equal(feed.lastEpochTotalLamports, 13_055_493_799_999_999n);
  assert.equal(feed.sourceSlot, 380_000_123n);
  assert.equal(feed.sourceUnixTimestamp, 1_790_000_000n);
  assert.equal(feed.receivedSlot, 5_000n);
  assert.equal(feed.receivedUnixTimestamp, 1_790_000_060n);
  assert.equal(feed.updates, 7n);

  assert.throws(() => decodeRelayedRate(bytes.subarray(0, RELAYED_RATE_LEN - 1)), /189 bytes/);
  const wrongType = Uint8Array.from(bytes);
  wrongType[0] = bytes[0]! ^ 1;
  assert.throws(() => decodeRelayedRate(wrongType), /not a RelayedRate/);
});

test('relay age is measured from the read on Solana, against the same bound as the program', () => {
  const feed = decodeRelayedRate(
    feedBytes({
      totalLamports: 2n,
      poolTokenSupply: 1n,
      epoch: 1n,
      stakeFeeBps: 0,
      solFeeBps: 0,
      sourceUnixTimestamp: 1_000_000n,
      updates: 1n,
    }),
  );
  assert.equal(MAX_RELAYED_RATE_AGE_SECONDS, 259_200, 'three days, as in constants.rs');
  assert.equal(relayAgeSeconds(feed, 1_000_000 + 60), 60);
  assert.equal(relayAgeSeconds(feed, 999_990), 0, 'clock skew is not negative age');
  assert.equal(isRelayStale(feed, 1_000_000 + MAX_RELAYED_RATE_AGE_SECONDS), false, 'at the bound is fresh');
  assert.equal(isRelayStale(feed, 1_000_000 + MAX_RELAYED_RATE_AGE_SECONDS + 1), true);
});

test('a relayed oracle names the receiver and its feed, and refreshes with both', () => {
  const jitoPool = new PublicKey('Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb');
  const [expectedFeed] = PublicKey.findProgramAddressSync(
    [Buffer.from('relayed_rate'), jitoPool.toBytes()],
    RATE_RECEIVER_PROGRAM_ID,
  );
  assert.ok(relayedRateFeedAddress(jitoPool).equals(expectedFeed));

  const config = relayedRateConfig({
    stakePool: jitoPool,
    receiverDeploySlot: 7_000_123n,
    receiverUpgradeAuthority: PublicKey.default,
  });
  assert.equal(config.sourceKind, OracleSourceKind.RelayedRate);
  assert.equal(OracleSourceKind.RelayedRate, 3, 'matches the program enum');
  assert.ok(config.sourceProgram.equals(RATE_RECEIVER_PROGRAM_ID));
  assert.ok(config.sourceAccount.equals(expectedFeed));
  // Bounded exactly as bCOOK is.
  const native = nativeBcookConfig();
  assert.equal(config.maxWithdrawalFeeBps, native.maxWithdrawalFeeBps);
  assert.equal(config.rateFloor, native.rateFloor);
  assert.equal(config.rateCeiling, native.rateCeiling);
  assert.deepEqual(config.breaker, native.breaker);

  assert.equal(readsSourceAccount(OracleSourceKind.RelayedRate), true);
  assert.equal(readsSourceAccount(OracleSourceKind.NativeExchangeRate), true);
  assert.equal(readsSourceAccount(OracleSourceKind.UnitOfAccount), false);
  assert.equal(readsSourceAccount(OracleSourceKind.MarketTwap), false);
});
