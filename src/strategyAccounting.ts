/** Conservative accounting kernel for a FUTURE, separate Solana strategy.
 * This is not a bridge adapter, custody program or authenticated NAV oracle.
 * Production share issuance must consume program-verified finality/inventory.
 * Current aSOL receipts and their local backing never enter this ledger.
 */
export interface StrategyTransfer {
  id: string; direction: 'cookie-to-solana' | 'solana-to-cookie'; amount: bigint;
  state: 'dispatched' | 'delivered' | 'failed';
}
export interface StrategyExit { id: string; owner: string; shares: bigint }
export interface StrategyLedger {
  cookieCash: bigint; cookieLoansRecoverable: bigint; solanaCash: bigint; solanaStakeRecoverable: bigint;
  liabilities: bigint; recognizedLosses: bigint; shareSupply: bigint;
  checkpointSequence: bigint; checkpointAt: number; transfers: StrategyTransfer[]; exits: StrategyExit[];
}
const nonnegative = (...values: bigint[]) => {
  if (values.some(v => v < 0n)) throw Error('Negative accounting input');
};
export function strategyNav(ledger: StrategyLedger): bigint {
  nonnegative(ledger.cookieCash, ledger.cookieLoansRecoverable, ledger.solanaCash, ledger.solanaStakeRecoverable,
    ledger.liabilities, ledger.recognizedLosses, ledger.shareSupply);
  // Dispatched assets have already left the source balance. In-flight funds
  // carry ZERO issuance value until the destination reports finalized custody.
  // Loans are the recoverable value of shares, not loans + the same reserve cash.
  const gross = ledger.cookieCash + ledger.cookieLoansRecoverable + ledger.solanaCash + ledger.solanaStakeRecoverable;
  const deductions = ledger.liabilities + ledger.recognizedLosses;
  return gross > deductions ? gross - deductions : 0n;
}
export function assertStrategyPricingReady(ledger: StrategyLedger, now: number, maxAgeMs: number): void {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0 ||
    !Number.isSafeInteger(ledger.checkpointAt) || now < ledger.checkpointAt || now - ledger.checkpointAt > maxAgeMs) throw Error('Strategy checkpoint is stale');
  if (ledger.transfers.some(t => t.state === 'dispatched')) throw Error('Share pricing suspended while bridge funds are in flight');
  if (ledger.shareSupply > 0n && strategyNav(ledger) === 0n) throw Error('Strategy is insolvent');
}
export function dispatchStrategyTransfer(ledger: StrategyLedger, transfer: Omit<StrategyTransfer, 'state'>): StrategyLedger {
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(transfer.id) || transfer.amount <= 0n || ledger.transfers.some(t => t.id === transfer.id)) throw Error('Invalid or duplicate transfer');
  const field = transfer.direction === 'cookie-to-solana' ? 'cookieCash' : transfer.direction === 'solana-to-cookie' ? 'solanaCash' : null;
  if (!field || ledger[field] < transfer.amount) throw Error('Insufficient source cash');
  return { ...ledger, [field]: ledger[field] - transfer.amount, transfers: [...ledger.transfers, { ...transfer, state: 'dispatched' }] };
}
/** Call only AFTER the adapter verifies destination domain, recipient PDA,
 * token mint, finalized delivery and unique message ID. Never credit both ends. */
export function finalizeStrategyTransfer(ledger: StrategyLedger, id: string, amountReceived: bigint, sequence: bigint): StrategyLedger {
  const transfer = ledger.transfers.find(t => t.id === id);
  if (!transfer || transfer.state !== 'dispatched' || sequence <= ledger.checkpointSequence || amountReceived < 0n || amountReceived > transfer.amount) throw Error('Invalid delivery or replay');
  const field = transfer.direction === 'cookie-to-solana' ? 'solanaCash' : 'cookieCash';
  // Fees/losses are represented by the smaller destination balance. Do not
  // subtract them again in recognizedLosses (which is for separate impairments).
  return { ...ledger, [field]: ledger[field] + amountReceived, checkpointSequence: sequence,
    transfers: ledger.transfers.map(t => t.id === id ? { ...t, state: 'delivered' } : t) };
}
export function enqueueStrategyExit(ledger: StrategyLedger, exit: StrategyExit): StrategyLedger {
  if (!exit.id || !exit.owner || exit.shares <= 0n || ledger.exits.some(e => e.id === exit.id) ||
    ledger.exits.reduce((n, e) => n + e.shares, exit.shares) > ledger.shareSupply) throw Error('Invalid exit queue');
  // On chain, this operation must transfer the shares into queue escrow.
  return { ...ledger, exits: [...ledger.exits, { ...exit }] };
}
export function settleStrategyExit(ledger: StrategyLedger, id: string, now: number, maxAgeMs: number): { ledger: StrategyLedger; paid: bigint } {
  assertStrategyPricingReady(ledger, now, maxAgeMs);
  const exit = ledger.exits[0];
  if (!exit || exit.id !== id || ledger.shareSupply === 0n) throw Error('Only the first funded exit may settle');
  const paid = exit.shares * strategyNav(ledger) / ledger.shareSupply;
  if (paid === 0n || paid > ledger.cookieCash) throw Error('Exit awaits Cookie liquidity');
  return { paid, ledger: { ...ledger, cookieCash: ledger.cookieCash - paid,
    shareSupply: ledger.shareSupply - exit.shares, exits: ledger.exits.slice(1) } };
}
