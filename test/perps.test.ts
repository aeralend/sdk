import assert from "node:assert/strict";
import test from "node:test";
import {
  inversePnl,
  markPaperPosition,
  openPaperPosition,
  paperLiquidationPrice,
  requireFreshReference,
  splitCollectedFees,
  tradeFee,
} from "../src/perps.js";
const p = {
  side: "long" as const,
  collateralLamports: 1_000_000_000n,
  notionalUsdMicros: 300_000_000n,
  entryPriceMicros: 100_000_000n,
};
test("inverse contracts pay SOL, not a linear USD approximation", () => {
  assert.equal(inversePnl(p, 120_000_000n), 500_000_000n);
  assert.equal(inversePnl(p, 80_000_000n), -750_000_000n);
  assert.equal(inversePnl({ ...p, side: "short" }, 80_000_000n), 750_000_000n);
  assert.equal(inversePnl(p, p.entryPriceMicros), 0n);
});
test("unbounded short profit and bankrupt long cannot silently drain backing", () => {
  assert.ok(
    inversePnl({ ...p, side: "short" }, 1n) > 1000000n * 1_000_000_000n,
  );
  const mark = markPaperPosition(p, 1_000_000n);
  assert.equal(mark.payout, 0n);
  assert.ok(mark.badDebt > 0n);
  assert.equal(mark.liquidatable, true);
});
test("fees round up and losses round against trader, preserving LP solvency", () => {
  assert.equal(tradeFee(1n, 1_000_000_000n), 1n);
  assert.equal(inversePnl({ ...p, notionalUsdMicros: 1n }, 99_999_999n), -1n);
  for (const fees of [0n, 1n, 9n, 10000n, 1000000001n]) {
    const s = splitCollectedFees(fees);
    assert.equal(s.holders + s.protocol + s.lpAndInsurance, fees);
  }
});
test("margin, leverage, direction and fresh prices fail closed", () => {
  assert.throws(() => openPaperPosition("long", 0n, 3, 100n));
  for (const leverage of [0, 4, 1.5, NaN])
    assert.throws(() =>
      openPaperPosition("long", 1_000_000_000n, leverage, 100_000_000n),
    );
  assert.throws(() => inversePnl({ ...p, side: "other" as "long" }, 100n));
  for (const at of [0, 103001, NaN])
    assert.throws(() => requireFreshReference(100n, at, 100000));
  requireFreshReference(100n, 100000, 100000);
});
test("liquidation boundary works for long and short with fee-inclusive equity", () => {
  for (const side of ["long", "short"] as const) {
    const { position, openingFee } = openPaperPosition(
      side,
      1_000_000_000n,
      3,
      100_000_000n,
    );
    assert.equal(openingFee, 1500000n);
    const liquidation = paperLiquidationPrice(position)!;
    const adverse = side === "long" ? liquidation - 2n : liquidation + 2n;
    const safe = side === "long" ? liquidation + 2n : liquidation - 2n;
    assert.equal(markPaperPosition(position, adverse).liquidatable, true);
    assert.equal(markPaperPosition(position, safe).liquidatable, false);
  }
});
