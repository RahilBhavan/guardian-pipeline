/**
 * fixtures.test.ts — differential JSON-fixture coverage for all 12
 * invariants. Loads test/fixtures/invariants.json and asserts the
 * pass/fail outcome of each case against the corresponding `invXX`
 * function exported from evaluator.ts. The fixture format is documented
 * in the file's `_meta` block.
 *
 * Each fixture's `state` is a *partial* {VaultState} (or, for delta
 * invariants, a `{ prior, current }` pair) — fields that aren't relevant
 * to the invariant under test fall back to the default-healthy values
 * built by {makeStateDefaults}. That keeps each fixture focused on its
 * own tension point.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  inv01,
  inv02,
  inv03,
  inv04,
  inv05,
  inv06,
  inv07,
  inv08,
  inv09,
  inv10,
  inv11,
  inv12,
} from '../src/evaluator.js';
import type {
  InvariantId,
  LiquidationEvent,
  UserPosition,
  VaultState,
} from '../src/types.js';

const ONE_E18 = 1_000_000_000_000_000_000n;
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES_PATH = resolve(here, 'fixtures/invariants.json');

interface RawUser {
  address: string;
  supplyShares: string;
  borrowShares: string;
  collateral: string;
}

interface RawLiquidation {
  blockNumber: string;
  borrower: string;
  debtRepaid: string;
  collateralSeized: string;
  oraclePrice: string;
}

interface RawPartialState {
  cash?: string;
  totalBorrowed?: string;
  totalSupplyAssets?: string;
  totalSupplyShares?: string;
  totalBorrowShares?: string;
  borrowIndex?: string;
  collateralRatio?: string;
  lastAccrualTime?: string;
  liquidationBonus?: string;
  maxStaleness?: string;
  oracleLastUpdatedAt?: string;
  users?: RawUser[];
  liquidationEvents?: RawLiquidation[];
  blockNumber?: string;
  blockTimestamp?: number;
}

interface Case {
  name: string;
  state: RawPartialState | { prior?: RawPartialState; current: RawPartialState };
  expected: { passed: boolean };
}

interface InvariantFixture {
  name: string;
  cases: Case[];
}

interface FixtureFile {
  _meta: unknown;
  [id: string]: unknown;
}

/** Default-healthy VaultState. Every numeric field is set so the snapshot
 *  passes every invariant unless overridden — fixtures only encode the
 *  fields that matter for the case under test. */
function makeStateDefaults(): VaultState {
  return {
    cash: 0n,
    totalBorrowed: 0n,
    totalSupplyAssets: 0n,
    totalSupplyShares: 0n,
    totalBorrowShares: 0n,
    borrowIndex: ONE_E18,
    collateralRatio: 8000n,
    lastAccrualTime: 0n,
    maxStaleness: 0n,
    liquidationBonus: 500n,
    oracleLastUpdatedAt: 0n,
    users: [],
    liquidationEvents: [],
    blockNumber: 1n,
    blockTimestamp: 0,
  };
}

function toUser(r: RawUser): UserPosition {
  return {
    address: r.address as `0x${string}`,
    supplyShares: BigInt(r.supplyShares),
    borrowShares: BigInt(r.borrowShares),
    collateral: BigInt(r.collateral),
  };
}

function toLiquidation(r: RawLiquidation): LiquidationEvent {
  return {
    blockNumber: BigInt(r.blockNumber),
    borrower: r.borrower as `0x${string}`,
    debtRepaid: BigInt(r.debtRepaid),
    collateralSeized: BigInt(r.collateralSeized),
    oraclePrice: BigInt(r.oraclePrice),
  };
}

/** Merge a partial fixture state onto the default-healthy baseline. */
function hydrate(part: RawPartialState): VaultState {
  const base = makeStateDefaults();
  if (part.cash !== undefined) base.cash = BigInt(part.cash);
  if (part.totalBorrowed !== undefined) base.totalBorrowed = BigInt(part.totalBorrowed);
  if (part.totalSupplyAssets !== undefined) base.totalSupplyAssets = BigInt(part.totalSupplyAssets);
  if (part.totalSupplyShares !== undefined) base.totalSupplyShares = BigInt(part.totalSupplyShares);
  if (part.totalBorrowShares !== undefined) base.totalBorrowShares = BigInt(part.totalBorrowShares);
  if (part.borrowIndex !== undefined) base.borrowIndex = BigInt(part.borrowIndex);
  if (part.collateralRatio !== undefined) base.collateralRatio = BigInt(part.collateralRatio);
  if (part.lastAccrualTime !== undefined) base.lastAccrualTime = BigInt(part.lastAccrualTime);
  if (part.liquidationBonus !== undefined) base.liquidationBonus = BigInt(part.liquidationBonus);
  if (part.maxStaleness !== undefined) base.maxStaleness = BigInt(part.maxStaleness);
  if (part.oracleLastUpdatedAt !== undefined) base.oracleLastUpdatedAt = BigInt(part.oracleLastUpdatedAt);
  if (part.users) base.users = part.users.map(toUser);
  if (part.liquidationEvents) base.liquidationEvents = part.liquidationEvents.map(toLiquidation);
  if (part.blockNumber !== undefined) base.blockNumber = BigInt(part.blockNumber);
  if (part.blockTimestamp !== undefined) base.blockTimestamp = part.blockTimestamp;
  return base;
}

const fixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf8')) as FixtureFile;

/** Type-narrowed accessor for a fixture entry; throws if the id is missing
 *  so a typo in this test surfaces as a hard failure, not a silent skip. */
function getFixture(id: InvariantId): InvariantFixture {
  const hit = fixtures[id];
  if (!hit) throw new Error(`fixture file missing entry for ${id}`);
  return hit as InvariantFixture;
}

// ---------------------------------------------------------------------------
// Snapshot-channel fixtures: INV-01..06, INV-08, INV-10, INV-11, INV-12
// ---------------------------------------------------------------------------

const snapshotInvariants: ReadonlyArray<{
  id: InvariantId;
  fn: (state: VaultState) => { passed: boolean };
}> = [
  { id: 'INV-01', fn: inv01 },
  { id: 'INV-02', fn: inv02 },
  { id: 'INV-03', fn: inv03 },
  { id: 'INV-04', fn: inv04 },
  { id: 'INV-05', fn: inv05 },
  { id: 'INV-06', fn: inv06 },
  { id: 'INV-08', fn: inv08 },
  { id: 'INV-10', fn: inv10 },
  { id: 'INV-11', fn: inv11 },
  { id: 'INV-12', fn: inv12 },
];

for (const { id, fn } of snapshotInvariants) {
  describe(`${id} fixture cases`, () => {
    const fx = getFixture(id);
    for (const c of fx.cases) {
      it(c.name, () => {
        const state = hydrate(c.state as RawPartialState);
        const result = fn(state);
        assert.equal(
          result.passed,
          c.expected.passed,
          `${id} '${c.name}': expected passed=${c.expected.passed}, got ${result.passed}`,
        );
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Delta-channel fixtures: INV-07, INV-09 (2-block fixtures per acceptance)
// ---------------------------------------------------------------------------

const deltaInvariants: ReadonlyArray<{
  id: InvariantId;
  fn: (state: VaultState, prior: VaultState | null) => { passed: boolean };
}> = [
  { id: 'INV-07', fn: inv07 },
  { id: 'INV-09', fn: inv09 },
];

for (const { id, fn } of deltaInvariants) {
  describe(`${id} fixture cases (2-block delta)`, () => {
    const fx = getFixture(id);
    for (const c of fx.cases) {
      it(c.name, () => {
        const pair = c.state as { prior?: RawPartialState; current: RawPartialState };
        const current = hydrate(pair.current);
        const prior = pair.prior ? hydrate(pair.prior) : null;
        const result = fn(current, prior);
        assert.equal(
          result.passed,
          c.expected.passed,
          `${id} '${c.name}': expected passed=${c.expected.passed}, got ${result.passed}`,
        );
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Manifest check — every invariant ID has a fixture entry, no orphans.
// ---------------------------------------------------------------------------

describe('invariants.json manifest', () => {
  it('covers all twelve invariant ids', () => {
    const ids = Object.keys(fixtures).filter((k) => k !== '_meta').sort();
    assert.deepEqual(ids, [
      'INV-01', 'INV-02', 'INV-03', 'INV-04', 'INV-05', 'INV-06',
      'INV-07', 'INV-08', 'INV-09', 'INV-10', 'INV-11', 'INV-12',
    ]);
  });

  it('every fixture has at least one pass case and one fail case', () => {
    for (const id of Object.keys(fixtures)) {
      if (id === '_meta') continue;
      const fx = fixtures[id] as InvariantFixture;
      const passes = fx.cases.filter((c) => c.expected.passed).length;
      const fails = fx.cases.filter((c) => !c.expected.passed).length;
      assert.ok(passes >= 1, `${id} fixture missing pass case`);
      assert.ok(fails >= 1, `${id} fixture missing fail case`);
    }
  });
});
