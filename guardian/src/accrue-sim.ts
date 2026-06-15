/**
 * Pure off-chain port of Vault.accrue() for INV-12 idempotence checks.
 */
import type { VaultState } from './types.js';

const WAD = 10n ** 18n;

export interface AccrueFields {
  borrowIndex: bigint;
  totalSupplyAssets: bigint;
  totalBorrowShares: bigint;
  lastAccrualTime: bigint;
  borrowRatePerSecond: bigint;
}

export function totalBorrowedFromFields(fields: AccrueFields): bigint {
  return (fields.totalBorrowShares * fields.borrowIndex) / WAD;
}

export function simulateAccrue(fields: AccrueFields, blockTimestamp: bigint): AccrueFields {
  const dt = blockTimestamp - fields.lastAccrualTime;
  if (dt === 0n) return fields;

  const next: AccrueFields = { ...fields, lastAccrualTime: blockTimestamp };
  const borrowedBefore = totalBorrowedFromFields(next);
  if (borrowedBefore === 0n) return next;

  next.borrowIndex = next.borrowIndex + (next.borrowIndex * next.borrowRatePerSecond * dt) / WAD;

  const interest = totalBorrowedFromFields(next) - borrowedBefore;
  if (interest > 0n) {
    next.totalSupplyAssets += interest;
  }

  return next;
}

export function accrueTwiceIdempotent(fields: AccrueFields, blockTimestamp: bigint): boolean {
  const afterFirst = simulateAccrue(fields, blockTimestamp);
  const afterSecond = simulateAccrue(afterFirst, blockTimestamp);

  return (
    afterSecond.borrowIndex === afterFirst.borrowIndex &&
    afterSecond.totalSupplyAssets === afterFirst.totalSupplyAssets &&
    afterSecond.totalBorrowShares === afterFirst.totalBorrowShares &&
    afterSecond.lastAccrualTime === afterFirst.lastAccrualTime
  );
}

export function accrueFieldsFromState(state: VaultState): AccrueFields {
  return {
    borrowIndex: state.borrowIndex,
    totalSupplyAssets: state.totalSupplyAssets,
    totalBorrowShares: state.totalBorrowShares,
    lastAccrualTime: state.lastAccrualTime,
    borrowRatePerSecond: state.borrowRatePerSecond,
  };
}
