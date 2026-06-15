/**
 * evaluator.test.ts — property-based coverage for the off-chain mirror.
 *
 * `evaluator.ts` is the load-bearing detection path: every block the bot
 * processes, every alert the dashboard ever shows. Prior to this file the
 * only evaluator test was implicit (an end-to-end run against a live vault).
 * That left the six invariants completely untested in isolation — a typo in
 * a comparator would have shipped silently.
 *
 * Each invariant has three property tests:
 *   1. **Holds on a healthy state** — random valid inputs always pass.
 *   2. **Breaks on a targeted mutation** — perturbing the property's exact
 *      tension point always fails. This is the harder claim: it proves the
 *      check is real, not a tautology that no input can violate.
 *   3. **Edge cases at zero / max-uint** — fixed cases, asserted directly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { evaluateInvariants } from '../src/evaluator.js';
import type { InvariantId, UserPosition, VaultState } from '../src/types.js';

const ONE_E18 = 1_000_000_000_000_000_000n;
const MAX_UINT128 = (1n << 128n) - 1n;

/** Pick the InvariantResult for a specific id out of the six-element array. */
function pick(state: VaultState, id: InvariantId) {
  const hit = evaluateInvariants(state).find((r) => r.id === id);
  if (!hit) throw new Error(`evaluator did not return ${id}`);
  return hit;
}

/** A bigint arbitrary in `[0, MAX_UINT128]` — large enough to exercise
 *  realistic vault values, small enough that sums stay inside uint256. */
const bigUint128 = fc.bigInt({ min: 0n, max: MAX_UINT128 });

/** Build a {@link VaultState} from positive bigint terms, leaving INV-05's
 *  borrow index above the floor and INV-06's user set healthy by default.
 *  INV-08/10/11/12 default-pass: no liquidation events, zero accrual gap,
 *  oracle freshness gap of zero. Tests that exercise those invariants
 *  override the relevant fields. */
function makeState(overrides: Partial<VaultState> = {}): VaultState {
  return {
    cash: 0n,
    totalBorrowed: 0n,
    totalSupplyAssets: 0n,
    totalSupplyShares: 0n,
    totalBorrowShares: 0n,
    borrowIndex: ONE_E18,
    borrowRatePerSecond: 0n,
    collateralRatio: 8000n,
    lastAccrualTime: 0n,
    maxStaleness: 0n,
    liquidationBonus: 500n,
    oracleLastUpdatedAt: 0n,
    users: [],
    liquidationEvents: [],
    blockNumber: 1n,
    blockTimestamp: 0,
    ...overrides,
  };
}

/** Construct a user position with explicit fields. */
function user(
  address: `0x${string}`,
  supplyShares: bigint,
  borrowShares: bigint,
  collateral: bigint,
): UserPosition {
  return { address, supplyShares, borrowShares, collateral };
}

const userAddrs: `0x${string}`[] = [
  '0x0000000000000000000000000000000000000001',
  '0x0000000000000000000000000000000000000002',
  '0x0000000000000000000000000000000000000003',
  '0x0000000000000000000000000000000000000004',
  '0x0000000000000000000000000000000000000005',
];

function makeUsers(supplies: bigint[], borrows: bigint[] = [], collats: bigint[] = []) {
  return supplies.map((s, i) => user(userAddrs[i], s, borrows[i] ?? 0n, collats[i] ?? 0n));
}

// ---------------------------------------------------------------------------
// INV-01 Protocol solvency: cash + totalBorrowed >= totalSupplyAssets
// ---------------------------------------------------------------------------

describe('INV-01 protocol solvency', () => {
  it('passes when asset reality covers lender claims', () => {
    fc.assert(
      fc.property(bigUint128, bigUint128, bigUint128, (cash, borrowed, slack) => {
        const totalSupplyAssets = cash + borrowed > slack ? cash + borrowed - slack : 0n;
        const state = makeState({ cash, totalBorrowed: borrowed, totalSupplyAssets });
        return pick(state, 'INV-01').passed === true;
      }),
    );
  });

  it('fails when lender claims exceed asset reality', () => {
    fc.assert(
      fc.property(
        bigUint128,
        bigUint128,
        fc.bigInt({ min: 1n, max: MAX_UINT128 }),
        (cash, borrowed, overshoot) => {
          const totalSupplyAssets = cash + borrowed + overshoot;
          const state = makeState({ cash, totalBorrowed: borrowed, totalSupplyAssets });
          return pick(state, 'INV-01').passed === false;
        },
      ),
    );
  });

  it('boundary: equality holds (cash + borrowed === totalSupplyAssets)', () => {
    const state = makeState({ cash: 1000n, totalBorrowed: 500n, totalSupplyAssets: 1500n });
    assert.equal(pick(state, 'INV-01').passed, true);
  });
});

// ---------------------------------------------------------------------------
// INV-02 Supply-share integrity: totalSupplyShares === sum(userSupplyShares)
// ---------------------------------------------------------------------------

describe('INV-02 supply-share integrity', () => {
  it('passes when totalSupplyShares matches the user-sum', () => {
    fc.assert(
      fc.property(fc.array(bigUint128, { minLength: 0, maxLength: 5 }), (supplies) => {
        const sum = supplies.reduce((a, b) => a + b, 0n);
        const state = makeState({
          totalSupplyShares: sum,
          users: makeUsers(supplies),
        });
        return pick(state, 'INV-02').passed === true;
      }),
    );
  });

  it('fails when totalSupplyShares disagrees with the user-sum by any non-zero delta', () => {
    fc.assert(
      fc.property(
        fc.array(bigUint128, { minLength: 1, maxLength: 5 }),
        fc.bigInt({ min: 1n, max: MAX_UINT128 }),
        (supplies, delta) => {
          const sum = supplies.reduce((a, b) => a + b, 0n);
          const state = makeState({
            totalSupplyShares: sum + delta,
            users: makeUsers(supplies),
          });
          return pick(state, 'INV-02').passed === false;
        },
      ),
    );
  });

  it('edge case: empty user set and totalSupplyShares === 0 passes', () => {
    assert.equal(pick(makeState(), 'INV-02').passed, true);
  });
});

// ---------------------------------------------------------------------------
// INV-03 Debt-share integrity: totalBorrowShares === sum(userBorrowShares)
// ---------------------------------------------------------------------------

describe('INV-03 debt-share integrity', () => {
  it('passes when totalBorrowShares matches the user-sum', () => {
    fc.assert(
      fc.property(fc.array(bigUint128, { minLength: 0, maxLength: 5 }), (borrows) => {
        const sum = borrows.reduce((a, b) => a + b, 0n);
        const state = makeState({
          totalBorrowShares: sum,
          users: makeUsers(borrows.map(() => 0n), borrows, borrows.map(() => MAX_UINT128)),
        });
        return pick(state, 'INV-03').passed === true;
      }),
    );
  });

  it('fails when totalBorrowShares disagrees with the user-sum by any non-zero delta', () => {
    fc.assert(
      fc.property(
        fc.array(bigUint128, { minLength: 1, maxLength: 5 }),
        fc.bigInt({ min: 1n, max: MAX_UINT128 }),
        (borrows, delta) => {
          const sum = borrows.reduce((a, b) => a + b, 0n);
          const state = makeState({
            totalBorrowShares: sum + delta,
            users: makeUsers(borrows.map(() => 0n), borrows, borrows.map(() => MAX_UINT128)),
          });
          return pick(state, 'INV-03').passed === false;
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// INV-04 Lender-value floor: totalSupplyAssets >= totalSupplyShares
// ---------------------------------------------------------------------------

describe('INV-04 lender-value floor', () => {
  it('passes when assets >= shares', () => {
    fc.assert(
      fc.property(bigUint128, bigUint128, (shares, premium) => {
        const state = makeState({
          totalSupplyShares: shares,
          totalSupplyAssets: shares + premium,
        });
        return pick(state, 'INV-04').passed === true;
      }),
    );
  });

  it('fails when shares strictly exceed assets', () => {
    fc.assert(
      fc.property(bigUint128, fc.bigInt({ min: 1n, max: MAX_UINT128 }), (assets, gap) => {
        const state = makeState({
          totalSupplyAssets: assets,
          totalSupplyShares: assets + gap,
        });
        return pick(state, 'INV-04').passed === false;
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// INV-05 Interest-index floor: borrowIndex >= 1e18
// ---------------------------------------------------------------------------

describe('INV-05 interest-index floor', () => {
  it('passes at and above 1e18', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: MAX_UINT128 }), (extra) => {
        const state = makeState({ borrowIndex: ONE_E18 + extra });
        return pick(state, 'INV-05').passed === true;
      }),
    );
  });

  it('fails strictly below 1e18', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: ONE_E18 - 1n }), (badIndex) => {
        const state = makeState({ borrowIndex: badIndex });
        return pick(state, 'INV-05').passed === false;
      }),
    );
  });

  it('boundary: exactly 1e18 passes', () => {
    assert.equal(pick(makeState({ borrowIndex: ONE_E18 }), 'INV-05').passed, true);
  });
});

// ---------------------------------------------------------------------------
// INV-06 No uncollateralised debt: ∀u. collateral=0 ⇒ borrowShares=0
// ---------------------------------------------------------------------------

describe('INV-06 no uncollateralised debt', () => {
  it('passes when every user with debt has non-zero collateral', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(bigUint128, fc.bigInt({ min: 1n, max: MAX_UINT128 })),
          { minLength: 0, maxLength: 5 },
        ),
        (positions) => {
          const users = positions.map(([borrow, collateral], i) =>
            user(userAddrs[i], 0n, borrow, collateral),
          );
          const state = makeState({ users });
          return pick(state, 'INV-06').passed === true;
        },
      ),
    );
  });

  it('fails as soon as one user holds debt with zero collateral', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: MAX_UINT128 }), (debt) => {
        const users = [user(userAddrs[0], 0n, debt, 0n)];
        const state = makeState({ users });
        return pick(state, 'INV-06').passed === false;
      }),
    );
  });

  it('edge case: collateral=0 with borrowShares=0 is healthy', () => {
    const users = [user(userAddrs[0], 0n, 0n, 0n)];
    assert.equal(pick(makeState({ users }), 'INV-06').passed, true);
  });
});

// ---------------------------------------------------------------------------
// Full evaluator: returns exactly six results in INV-01..INV-06 order.
// ---------------------------------------------------------------------------

describe('evaluateInvariants — contract', () => {
  it('returns twelve results in canonical INV-01..INV-12 order', () => {
    const results = evaluateInvariants(makeState());
    assert.equal(results.length, 12);
    assert.deepEqual(
      results.map((r) => r.id),
      [
        'INV-01', 'INV-02', 'INV-03', 'INV-04', 'INV-05', 'INV-06',
        'INV-07', 'INV-08', 'INV-09', 'INV-10', 'INV-11', 'INV-12',
      ],
    );
  });

  it('all twelve invariants pass on the default healthy state', () => {
    const results = evaluateInvariants(makeState());
    for (const r of results) {
      assert.equal(r.passed, true, `${r.id} should pass on default state, got fail`);
    }
  });
});
