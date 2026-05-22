/**
 * evaluator.ts — the off-chain mirror of the Solidity `invariant_*` functions.
 *
 * Every check here is the exact logical twin of its counterpart in
 * test/invariant/InvariantVault.t.sol. The six properties proven across
 * hundreds of thousands of fuzz runs pre-deployment are the same six enforced
 * live, block by block. Unlike a sampled proxy, INV-02/03/06 are evaluated
 * against the *actual* per-user positions the fetcher discovers from vault
 * events — so the mirror is genuinely 1:1, not an approximation.
 */
import type { InvariantResult, VaultState } from './types.js';

const ONE_E18 = 1_000_000_000_000_000_000n;

/** INV-01 Protocol solvency — assets must always cover lender claims. */
function inv01(state: VaultState): InvariantResult {
  const assets = state.cash + state.totalBorrowed;
  return {
    id: 'INV-01',
    name: 'Protocol solvency',
    passed: assets >= state.totalSupplyAssets,
    actualValue: assets,
    boundValue: state.totalSupplyAssets,
    description: 'cash + totalBorrowed must cover totalSupplyAssets (lender claims)',
  };
}

/** INV-02 Supply-share integrity — totalSupplyShares equals the sum of all lender shares. */
function inv02(state: VaultState): InvariantResult {
  const sum = state.users.reduce((acc, u) => acc + u.supplyShares, 0n);
  return {
    id: 'INV-02',
    name: 'Supply-share integrity',
    passed: state.totalSupplyShares === sum,
    actualValue: state.totalSupplyShares,
    boundValue: sum,
    description: 'totalSupplyShares must equal the sum of every userSupplyShares',
  };
}

/** INV-03 Debt-share integrity — totalBorrowShares equals the sum of all borrow shares. */
function inv03(state: VaultState): InvariantResult {
  const sum = state.users.reduce((acc, u) => acc + u.borrowShares, 0n);
  return {
    id: 'INV-03',
    name: 'Debt-share integrity',
    passed: state.totalBorrowShares === sum,
    actualValue: state.totalBorrowShares,
    boundValue: sum,
    description: 'totalBorrowShares must equal the sum of every userBorrowShares',
  };
}

/** INV-04 Lender-value floor — the share price never falls below the 1:1 peg. */
function inv04(state: VaultState): InvariantResult {
  return {
    id: 'INV-04',
    name: 'Lender-value floor',
    passed: state.totalSupplyAssets >= state.totalSupplyShares,
    actualValue: state.totalSupplyAssets,
    boundValue: state.totalSupplyShares,
    description: 'totalSupplyAssets must be >= totalSupplyShares (share price >= 1:1)',
  };
}

/** INV-05 Interest-index floor — the borrow index only ever accrues forward. */
function inv05(state: VaultState): InvariantResult {
  return {
    id: 'INV-05',
    name: 'Interest-index floor',
    passed: state.borrowIndex >= ONE_E18,
    actualValue: state.borrowIndex,
    boundValue: ONE_E18,
    description: 'borrowIndex must be >= 1e18 (interest never accrues backwards)',
  };
}

/**
 * INV-06 No uncollateralised debt — an account with zero collateral shares must
 * carry no debt. `actualValue` reports the count of offending accounts.
 */
function inv06(state: VaultState): InvariantResult {
  const offenders = state.users.filter(
    (u) => u.supplyShares === 0n && u.borrowShares > 0n,
  ).length;
  return {
    id: 'INV-06',
    name: 'No uncollateralised debt',
    passed: offenders === 0,
    actualValue: BigInt(offenders),
    boundValue: 0n,
    description: 'no account may hold debt while holding zero collateral shares',
  };
}

/**
 * Evaluate all six invariants against a single vault state snapshot.
 * @returns The six results in INV-01..INV-06 order.
 */
export function evaluateInvariants(state: VaultState): InvariantResult[] {
  return [inv01(state), inv02(state), inv03(state), inv04(state), inv05(state), inv06(state)];
}
