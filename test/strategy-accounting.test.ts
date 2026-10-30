import assert from 'node:assert/strict';
import { test } from 'node:test';
import { strategyNav, dispatchStrategyTransfer, finalizeStrategyTransfer, assertStrategyPricingReady,
  enqueueStrategyExit, settleStrategyExit, type StrategyLedger } from '../src/strategyAccounting.js';
const base = (): StrategyLedger => ({ cookieCash: 1000n, cookieLoansRecoverable: 0n, solanaCash: 0n, solanaStakeRecoverable: 0n,
  liabilities: 0n, recognizedLosses: 0n, shareSupply: 1000n, checkpointSequence: 1n, checkpointAt: 100, transfers: [], exits: [] });
test('bridge never counts source, in-flight balance and destination twice; mint pricing pauses', () => {
  const sent = dispatchStrategyTransfer(base(), { id: 'route:1', direction: 'cookie-to-solana', amount: 300n });
  assert.equal(strategyNav(sent), 700n); assert.throws(() => assertStrategyPricingReady(sent, 101, 1000), /flight/);
  const delivered = finalizeStrategyTransfer(sent, 'route:1', 299n, 2n);
  assert.equal(strategyNav(delivered), 999n); assert.equal(delivered.solanaCash, 299n);
  assert.throws(() => finalizeStrategyTransfer(delivered, 'route:1', 299n, 3n), /replay/);
  assert.throws(() => finalizeStrategyTransfer(sent, 'route:1', 301n, 2n));
  assert.throws(() => dispatchStrategyTransfer(sent, { id: 'route:1', direction: 'cookie-to-solana', amount: 300n }));
});
test('stale, future and insolvent NAV cannot settle; exit queue requires available Cookie cash', () => {
  let state = enqueueStrategyExit(base(), { id: 'exit1', owner: 'a', shares: 100n });
  state = enqueueStrategyExit(state, { id: 'exit2', owner: 'b', shares: 100n });
  assert.throws(() => settleStrategyExit(state, 'exit2', 101, 100));
  assert.throws(() => settleStrategyExit(state, 'exit1', 99, 100));
  assert.throws(() => settleStrategyExit(state, 'exit1', 201, 100));
  const settled = settleStrategyExit(state, 'exit1', 101, 100);
  assert.equal(settled.paid, 100n); assert.equal(settled.ledger.shareSupply, 900n);
  assert.equal(strategyNav(settled.ledger), 900n);
  assert.throws(() => settleStrategyExit({ ...state, cookieCash: 0n, solanaStakeRecoverable: 1000n }, 'exit1', 101, 100), /liquidity/);
  assert.throws(() => settleStrategyExit({ ...state, recognizedLosses: 1001n }, 'exit1', 101, 100), /insolvent/);
});
test('losses and liabilities reduce claims; negative balances and excessive queued claims fail', () => {
  assert.equal(strategyNav({ ...base(), recognizedLosses: 100n, liabilities: 50n }), 850n);
  assert.throws(() => strategyNav({ ...base(), cookieCash: -1n }));
  assert.throws(() => enqueueStrategyExit(base(), { id: 'x', owner: 'a', shares: 1001n }));
});
