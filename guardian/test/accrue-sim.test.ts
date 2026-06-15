import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { simulateAccrue, accrueTwiceIdempotent } from '../src/accrue-sim.js';

const WAD = 10n ** 18n;
const RATE = WAD / (365n * 86400n);

describe('accrue-sim', () => {
  it('second accrue in same block is a no-op after first accrual', () => {
    const fields = {
      borrowIndex: WAD,
      totalSupplyAssets: 1000n * WAD,
      totalBorrowShares: 500n * WAD,
      lastAccrualTime: 100n,
      borrowRatePerSecond: RATE,
    };
    assert.equal(accrueTwiceIdempotent(fields, 200n), true);
  });

  it('simulateAccrue is a no-op when lastAccrualTime equals block timestamp', () => {
    const fields = {
      borrowIndex: WAD,
      totalSupplyAssets: 1000n * WAD,
      totalBorrowShares: 500n * WAD,
      lastAccrualTime: 200n,
      borrowRatePerSecond: RATE,
    };
    assert.deepEqual(simulateAccrue(fields, 200n), fields);
  });
});
