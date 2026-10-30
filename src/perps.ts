/** Integer-only inverse SOL/USD accounting. Research/paper engine, not an on-chain risk authority. */
export const PERPS_PAPER_CONFIG = Object.freeze({
  maxLeverage: 3,
  feeBps: 5,
  maintenanceBps: 1000,
  maxQuoteAgeMs: 30000,
});
const SOL = 1_000_000_000n;
const BPS = 10_000n;
export type PerpSide = "long" | "short";
export interface PaperPosition {
  side: PerpSide;
  collateralLamports: bigint;
  notionalUsdMicros: bigint;
  entryPriceMicros: bigint;
}
function positive(value: bigint) {
  if (value <= 0n) throw Error("Amount and price must be positive.");
}
/** Signed floor: gains rounded down, losses rounded against the trader. */
function floor(n: bigint, d: bigint) {
  return n >= 0n ? n / d : -((-n + d - 1n) / d);
}
function ceil(n: bigint, d: bigint) {
  return (n + d - 1n) / d;
}
function direction(side: PerpSide) {
  if (side !== "long" && side !== "short") throw Error("Invalid side.");
  return side === "long" ? 1n : -1n;
}
export function requireFreshReference(
  priceMicros: bigint,
  observedAtMs: number,
  nowMs: number,
): void {
  positive(priceMicros);
  if (
    !Number.isSafeInteger(nowMs) ||
    !Number.isSafeInteger(observedAtMs) ||
    nowMs - observedAtMs > PERPS_PAPER_CONFIG.maxQuoteAgeMs ||
    observedAtMs > nowMs + 2000
  )
    throw Error("Price reference is stale or invalid.");
}
export function tradeFee(
  notionalUsdMicros: bigint,
  priceMicros: bigint,
): bigint {
  positive(notionalUsdMicros);
  positive(priceMicros);
  return ceil(
    notionalUsdMicros * SOL * BigInt(PERPS_PAPER_CONFIG.feeBps),
    priceMicros * BPS,
  );
}
/** Fixed USD notional, PnL settled in SOL, unlike a linear USD-settled contract. */
export function inversePnl(
  position: PaperPosition,
  priceMicros: bigint,
): bigint {
  positive(position.notionalUsdMicros);
  positive(position.entryPriceMicros);
  positive(priceMicros);
  return floor(
    direction(position.side) *
      position.notionalUsdMicros *
      SOL *
      (priceMicros - position.entryPriceMicros),
    position.entryPriceMicros * priceMicros,
  );
}
export function openPaperPosition(
  side: PerpSide,
  margin: bigint,
  leverage: number,
  priceMicros: bigint,
) {
  direction(side);
  positive(margin);
  positive(priceMicros);
  if (
    !Number.isSafeInteger(leverage) ||
    leverage < 1 ||
    leverage > PERPS_PAPER_CONFIG.maxLeverage
  )
    throw Error("Paper leverage must be 1–3x.");
  const notionalUsdMicros = (margin * BigInt(leverage) * priceMicros) / SOL;
  positive(notionalUsdMicros);
  const openingFee = tradeFee(notionalUsdMicros, priceMicros);
  if (openingFee >= margin) throw Error("Margin cannot cover the opening fee.");
  return {
    position: {
      side,
      collateralLamports: margin - openingFee,
      notionalUsdMicros,
      entryPriceMicros: priceMicros,
    },
    openingFee,
  };
}
export function markPaperPosition(
  position: PaperPosition,
  priceMicros: bigint,
) {
  positive(position.collateralLamports);
  const pnl = inversePnl(position, priceMicros);
  const closingFee = tradeFee(position.notionalUsdMicros, priceMicros);
  const maintenance = ceil(
    position.notionalUsdMicros *
      SOL *
      BigInt(PERPS_PAPER_CONFIG.maintenanceBps),
    priceMicros * BPS,
  );
  const equity = position.collateralLamports + pnl - closingFee;
  return {
    pnl,
    closingFee,
    maintenance,
    equity,
    liquidatable: equity <= maintenance,
    payout: equity > 0n ? equity : 0n,
    badDebt: equity < 0n ? -equity : 0n,
  };
}
/** Threshold estimate excluding funding, price impact and liquidation execution costs. */
export function paperLiquidationPrice(position: PaperPosition): bigint | null {
  const s = direction(position.side),
    n = position.notionalUsdMicros,
    e = position.entryPriceMicros;
  positive(n);
  positive(e);
  positive(position.collateralLamports);
  const numerator =
    n *
    SOL *
    e *
    (s * BPS +
      BigInt(PERPS_PAPER_CONFIG.feeBps + PERPS_PAPER_CONFIG.maintenanceBps));
  const denominator = position.collateralLamports * e * BPS + s * n * SOL * BPS;
  if (denominator === 0n || numerator * denominator <= 0n) return null;
  return position.side === "long"
    ? ceil(numerator, denominator)
    : numerator / denominator;
}
/** Split only collected fees, never trader collateral or ordinary reserve assets. Remainder goes to LP/insurance. */
export function splitCollectedFees(fees: bigint) {
  if (fees < 0n) throw Error("Collected fees cannot be negative.");
  const holders = (fees * 3000n) / BPS,
    protocol = (fees * 2000n) / BPS;
  return { holders, protocol, lpAndInsurance: fees - holders - protocol };
}
