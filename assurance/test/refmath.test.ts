import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {
  WAD,
  applyAccrual,
  computeBorrowShares,
  computeDepositShares,
  computeUserDebt,
  computeWithdrawAmount,
} from '../src/refmath.ts';

// These cases mirror the pinned regression vectors in
// test/differential/ShareMathDifferential.t.sol. If a value here changes,
// the Foundry differential test must change in lockstep.

test('refmath: deposit-shares bootstrap mints 1:1', () => {
  assert.equal(computeDepositShares(1_000n * WAD, 0n, 0n), 1_000n * WAD);
});

test('refmath: deposit-shares uses floor division once shares exist', () => {
  // tsa = 5e18, tss = 2.5e18, amount = 1e18 → 0.5e18 shares (exact).
  assert.equal(computeDepositShares(WAD, 5n * WAD, (5n * WAD) / 2n), WAD / 2n);
});

test('refmath: withdraw-amount uses floor division', () => {
  // shares = 1e18, tsa = 3e18, tss = 2e18 → 1.5e18 amount (exact).
  assert.equal(computeWithdrawAmount(WAD, 3n * WAD, 2n * WAD), (3n * WAD) / 2n);
});

test('refmath: borrow-shares ceil-rounds in protocol favour', () => {
  // amount = 1e18, index = 1.1e18: floor = 909090909090909090, ceil = +1.
  const idx = (11n * WAD) / 10n;
  assert.equal(computeBorrowShares(WAD, idx), 909090909090909091n);
});

test('refmath: user-debt floor-rounds in protocol favour', () => {
  // borrowShares = 1e18, index = 1.1e18 → 1.1e18 debt (exact).
  const idx = (11n * WAD) / 10n;
  assert.equal(computeUserDebt(WAD, idx), (11n * WAD) / 10n);
});

test('refmath: applyAccrual with dt=0 is identity', () => {
  const idx = WAD;
  const rate = 3_170_979_198n;
  assert.equal(applyAccrual(idx, rate, 0n), idx);
});

test('refmath: applyAccrual grows monotonically with dt', () => {
  const idx = WAD;
  const rate = 3_170_979_198n;
  const a = applyAccrual(idx, rate, 1n);
  const b = applyAccrual(idx, rate, 2n);
  assert.ok(b >= a);
  assert.ok(a >= idx);
});
