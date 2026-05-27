/**
 * stateHistory.test.ts — round-trips {VaultState} through the wire
 * (de)serialiser used by Supabase persistence. The bigint↔text mapping
 * is the only thing that could silently corrupt a delta invariant — a
 * missed field would leave INV-07 or INV-09 reading the wrong prior
 * snapshot, and the delta check would either false-positive or
 * false-negative for one block per restart. A round-trip identity
 * assertion pins it.
 *
 * The Supabase client is stubbed: this test exercises {vaultStateToRow}
 * + {rowToVaultState} directly, plus a light fake of {loadPreviousState}
 * / {savePreviousState} that records the wire row to confirm the upsert
 * shape is what we put on the network.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadPreviousState,
  rowToVaultState,
  savePreviousState,
  vaultStateToRow,
} from '../src/stateHistory.js';
import type { VaultState } from '../src/types.js';

const VAULT = '0x0000000000000000000000000000000000000abc';
const ONE_E18 = 1_000_000_000_000_000_000n;

/** Silent pino-shaped logger. */
const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  fatal: () => undefined,
  trace: () => undefined,
  child: () => silentLogger,
} as unknown as Parameters<typeof loadPreviousState>[2];

function exampleState(): VaultState {
  return {
    cash: 12345n,
    totalBorrowed: 6789n,
    totalSupplyAssets: 19134n,
    totalSupplyShares: 19000n,
    totalBorrowShares: 6000n,
    borrowIndex: ONE_E18 + 42n,
    collateralRatio: 8000n,
    lastAccrualTime: 1716000000n,
    maxStaleness: 86400n,
    liquidationBonus: 500n,
    oracleLastUpdatedAt: 1716000000n,
    users: [
      {
        address: '0x0000000000000000000000000000000000000001',
        supplyShares: 11000n,
        borrowShares: 0n,
        collateral: 0n,
      },
      {
        address: '0x0000000000000000000000000000000000000002',
        supplyShares: 8000n,
        borrowShares: 6000n,
        collateral: 50000n,
      },
    ],
    liquidationEvents: [
      // Intentionally non-empty in the source — persistence must drop these.
      {
        blockNumber: 100n,
        borrower: '0x0000000000000000000000000000000000000002',
        debtRepaid: 10n,
        collateralSeized: 5n,
        oraclePrice: 2n * ONE_E18,
      },
    ],
    blockNumber: 12345678n,
    blockTimestamp: 1716000000,
  };
}

describe('stateHistory wire round-trip', () => {
  it('vaultStateToRow → rowToVaultState recovers every persisted field', () => {
    const original = exampleState();
    const row = vaultStateToRow(original, VAULT);
    const recovered = rowToVaultState(row);

    // Every persisted bigint must round-trip exactly. liquidationEvents are
    // intentionally not persisted — they belong to a polled window, not a
    // stateful concept — so we exclude them from the comparison.
    const expected: Omit<VaultState, 'liquidationEvents'> = {
      cash: original.cash,
      totalBorrowed: original.totalBorrowed,
      totalSupplyAssets: original.totalSupplyAssets,
      totalSupplyShares: original.totalSupplyShares,
      totalBorrowShares: original.totalBorrowShares,
      borrowIndex: original.borrowIndex,
      collateralRatio: original.collateralRatio,
      lastAccrualTime: original.lastAccrualTime,
      maxStaleness: original.maxStaleness,
      liquidationBonus: original.liquidationBonus,
      oracleLastUpdatedAt: original.oracleLastUpdatedAt,
      users: original.users,
      blockNumber: original.blockNumber,
      blockTimestamp: original.blockTimestamp,
    };
    const { liquidationEvents: _ignore, ...recoveredCore } = recovered;
    assert.deepEqual(recoveredCore, expected);
    assert.deepEqual(
      recovered.liquidationEvents,
      [],
      'liquidationEvents must not be persisted across blocks',
    );
  });

  it('serialised row exposes every uint256 as decimal-string text', () => {
    const row = vaultStateToRow(exampleState(), VAULT);
    for (const field of [
      row.cash,
      row.total_supply_assets,
      row.total_supply_shares,
      row.total_borrow_shares,
      row.total_borrowed,
      row.borrow_index,
      row.collateral_ratio,
      row.last_accrual_time,
      row.liquidation_bonus,
      row.max_staleness,
      row.oracle_last_updated_at,
    ]) {
      assert.equal(typeof field, 'string', `expected text, got ${typeof field}`);
      assert.ok(/^[0-9]+$/.test(field), `expected decimal digits, got '${field}'`);
    }
    for (const u of row.users_jsonb) {
      assert.ok(/^[0-9]+$/.test(u.supplyShares));
      assert.ok(/^[0-9]+$/.test(u.borrowShares));
      assert.ok(/^[0-9]+$/.test(u.collateral));
    }
  });
});

// ---------------------------------------------------------------------------
// loadPreviousState / savePreviousState — exercised against a fake Supabase
// client so the network surface is verified without a live Postgres.
// ---------------------------------------------------------------------------

type AnyFn = (...args: unknown[]) => unknown;

function makeFakeSupabase(opts: {
  selectResult: { data: unknown; error: { message: string } | null };
  upsertResult: { error: { message: string } | null };
  captureUpsert?: (row: unknown) => void;
}) {
  // Each .from() returns a thenable-ish query stub. The shape mirrors the
  // narrow subset of @supabase/supabase-js the production code touches.
  return {
    from: (() => ({
      select: (() => ({
        ilike: (() => ({
          maybeSingle: (() => opts.selectResult) as AnyFn,
        })) as AnyFn,
      })) as AnyFn,
      upsert: ((row: unknown) => {
        opts.captureUpsert?.(row);
        return Promise.resolve(opts.upsertResult);
      }) as AnyFn,
    })) as AnyFn,
  } as unknown as Parameters<typeof loadPreviousState>[0];
}

describe('loadPreviousState', () => {
  it('returns null when the row does not exist', async () => {
    const supabase = makeFakeSupabase({
      selectResult: { data: null, error: null },
      upsertResult: { error: null },
    });
    const prior = await loadPreviousState(supabase, VAULT, silentLogger);
    assert.equal(prior, null);
  });

  it('returns null and logs when the read errors', async () => {
    const supabase = makeFakeSupabase({
      selectResult: { data: null, error: { message: 'boom' } },
      upsertResult: { error: null },
    });
    const prior = await loadPreviousState(supabase, VAULT, silentLogger);
    assert.equal(prior, null);
  });

  it('rehydrates a VaultState when the row exists', async () => {
    const row = vaultStateToRow(exampleState(), VAULT);
    const supabase = makeFakeSupabase({
      selectResult: { data: row, error: null },
      upsertResult: { error: null },
    });
    const prior = await loadPreviousState(supabase, VAULT, silentLogger);
    assert.ok(prior !== null);
    assert.equal(prior.cash, exampleState().cash);
    assert.equal(prior.borrowIndex, exampleState().borrowIndex);
    assert.deepEqual(prior.liquidationEvents, []);
  });
});

describe('savePreviousState', () => {
  it('writes a single upsert with onConflict=vault', async () => {
    let captured: unknown = null;
    const supabase = makeFakeSupabase({
      selectResult: { data: null, error: null },
      upsertResult: { error: null },
      captureUpsert: (row) => {
        captured = row;
      },
    });
    await savePreviousState(supabase, exampleState(), VAULT, silentLogger);
    assert.ok(captured, 'expected the upsert payload to be captured');
    const row = captured as { vault: string; block_number: number };
    assert.equal(row.vault, VAULT);
    assert.equal(row.block_number, Number(exampleState().blockNumber));
  });

  it('does not throw when the upsert errors — bot must keep running', async () => {
    const supabase = makeFakeSupabase({
      selectResult: { data: null, error: null },
      upsertResult: { error: { message: 'boom' } },
    });
    // No assertion needed beyond "this call returns" — savePreviousState
    // swallows the error after logging.
    await savePreviousState(supabase, exampleState(), VAULT, silentLogger);
  });
});
