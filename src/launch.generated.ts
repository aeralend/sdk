/**
 * Aera Core's launch configuration.
 *
 * GENERATED from `programs/aera/src/launch.rs` by
 * `programs/aera/tests/test_launch_config.rs`. Do not edit by hand: the test
 * fails if this file and the program's constants disagree.
 *
 * Regenerate with:
 *
 *   AERA_WRITE_LAUNCH_CONFIG=1 cargo test --test test_launch_config
 *
 * Caps and slot counts are strings: they are u64 base units and `JSON.parse`
 * would round them. Parse with `BigInt`, never `Number`.
 */

export const LAUNCH = {
  "$comment": "GENERATED from programs/aera/src/launch.rs by tests/test_launch_config.rs. Do not edit by hand: the test fails if this file and the program's constants disagree. Regenerate with AERA_WRITE_LAUNCH_CONFIG=1 cargo test --test test_launch_config.",
  "version": "0.2",
  "programId": "AerafpFHsY4N16i4KufPJQyURryxKtYgCr6oZMwbp76q",
  "marketId": 0,
  "marketName": "Aera Core",

  "chain": {
    "genesis": "9wDaBRDgArEUpvhHxGguNkwozsZh4UpGZB9o2EoEcBB2",
    "decimals": 9,
    "cookMint": "So11111111111111111111111111111111111111112",
    "bcookMint": "EkPafx58mgwkEnGwo62jXhXDAdJ37Z8G8MFBRPsr9uhz"
  },

  "stakePool": {
    "program": "GZgs5uREPp6BvDt8eysmhavQPAHBAtjePgV4zfhgd9pH",
    "programData": "6Dsx1cdbzEsNaV4BKzJhEvTpuSGf4CcVH3UCt45mERTF",
    "deploySlot": 5504973,
    "upgradeAuthority": "GSPUoahS7jSQUEAEkjaejsN9vo2w4B2NYHZ9oJSMm45p",
    "pool": "GxbNKNYdtNXQkhDkpHdLDAMX64GxaECgANqdfp6cUGH4"
  },

  "oracle": {
    "maxWithdrawalFeeBps": 500,
    "rateFloor": "100000000000000000",
    "rateCeiling": "10000000000000000000",
    "maxUpBpsPerEpoch": 200,
    "maxDownBpsPerEpoch": 100,
    "emergencyDeviationBps": 1000,
    "staleEpochsWarning": 3
  },

  "reserves": {
    "cook": {
      "loanToValueBps": 0,
      "liquidationThresholdBps": 0,
      "liquidationBonusBps": 800,
      "closeFactorBps": 5000,
      "collateralHaircutBps": 0,
      "optimalUtilizationBps": 6000,
      "minBorrowRateBps": 200,
      "optimalBorrowRateBps": 1000,
      "maxBorrowRateBps": 9000,
      "reserveFactorBps": 1500,
      "originationFeeBps": 15,
      "supplyCap": "1000000000000000",
      "borrowCap": "600000000000000",
      "perWalletSupplyCap": "250000000000000",
      "borrowEnabled": true,
      "collateralEnabled": false,
      "isolated": false,
      "slotsPerYear": "69313098"
    },
    "bcook": {
      "loanToValueBps": 5500,
      "liquidationThresholdBps": 6500,
      "liquidationBonusBps": 800,
      "closeFactorBps": 5000,
      "collateralHaircutBps": 500,
      "optimalUtilizationBps": 6000,
      "minBorrowRateBps": 200,
      "optimalBorrowRateBps": 1000,
      "maxBorrowRateBps": 9000,
      "reserveFactorBps": 1500,
      "originationFeeBps": 15,
      "supplyCap": "0",
      "borrowCap": "0",
      "perWalletSupplyCap": "0",
      "borrowEnabled": false,
      "collateralEnabled": true,
      "isolated": false,
      "slotsPerYear": "69313098"
    }
  },

  "slotTime": {
    "$comment": "Measured, not applied. slotsPerYear above is what the program deploys; changing it changes the economics of every position and is an operator decision made through set_params with the timelock. See LAUNCH_CHECKLIST.md.",
    "measuredOn": "2026-08-31",
    "meanSlotMs": 455.291,
    "slotsPerYearMeasured": "69313098",
    "deployedDriftBps": 0
  }
} as const;

export type LaunchConfig = typeof LAUNCH;
