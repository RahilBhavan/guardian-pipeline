import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { evaluateInvariants } from './evaluator.js';
import { rowToVaultState, vaultStateToRow } from './stateHistory.js';
import type { PriorVaultState, VaultState } from './types.js';

/** Stable signed int64: independent of JS process, PostgreSQL hash version and case. */
export function vaultLockKey(vault: string): string {
  return createHash('sha256').update(`guardian:${vault.toLowerCase()}`).digest().readBigInt64BE().toString();
}

/**
 * One block per transaction. Both workers MUST use this entry point, the same
 * database and the same chain (the existing schema keys by vault, not chain).
 * A lost connection rolls back results AND cursor; PostgreSQL releases the lock.
 * No detached writes, lease timeout, or new migration/privileged SQL function.
 */
export async function checkNextBlock(params: {
  pool: Pool;
  vault: `0x${string}`;
  deployBlock: bigint;
  head: bigint;
  fetch: (block: bigint, prior: PriorVaultState) => Promise<VaultState>;
}): Promise<'standby' | 'caught-up' | 'checked'> {
  const vault = params.vault.toLowerCase();
  const db = await params.pool.connect();
  try {
    await db.query('BEGIN');
    const lock = await db.query<{ locked: boolean }>('SELECT pg_try_advisory_xact_lock($1::bigint) AS locked', [vaultLockKey(vault)]);
    if (!lock.rows[0]?.locked) { await db.query('ROLLBACK'); return 'standby'; }
    const previous = await db.query<Parameters<typeof rowToVaultState>[0]>(
      'SELECT * FROM public.vault_state_previous WHERE lower(vault) = $1', [vault],
    );
    if (previous.rows.length > 1) throw new Error('Duplicate case variants in vault checkpoint; canonicalize before HA');
    const oldRow = previous.rows[0];
    const prior = oldRow ? rowToVaultState(oldRow) : null;
    const block = prior ? prior.blockNumber + 1n : params.deployBlock;
    if (block > params.head) { await db.query('ROLLBACK'); return 'caught-up'; }
    const start = performance.now();
    const state = await params.fetch(block, prior);
    if (state.blockNumber !== block) throw new Error('Fetcher returned a different block');
    const violations = evaluateInvariants(state, prior).filter((result) => !result.passed);
    const latency = Math.round(performance.now() - start);
    for (const v of violations) {
      await db.query(`INSERT INTO public.alerts
        (vault,block_number,block_ts,invariant_id,invariant_name,passed,actual_value,bound_value,description,detection_latency_ms)
        VALUES ($1,$2,to_timestamp($3),$4,$5,false,$6,$7,$8,$9)
        ON CONFLICT (vault,block_number,invariant_id) DO NOTHING`,
      [vault, block.toString(), state.blockTimestamp, v.id, v.name, v.actualValue.toString(), v.boundValue.toString(), v.description, latency]);
    }
    await db.query(`INSERT INTO public.blocks_checked (vault,block_number,all_passed,latency_ms,violations_count)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT (vault,block_number) DO NOTHING`,
    [vault, block.toString(), violations.length === 0, latency, violations.length]);
    // Column identifiers come ONLY from our serializer, never from external input.
    const row = vaultStateToRow(state, vault);
    const entries = Object.entries(row);
    const columns = entries.map(([key]) => key);
    // Remove a legacy mixed-case checkpoint only within this successful transaction.
    if (oldRow && oldRow.vault !== vault) await db.query('DELETE FROM public.vault_state_previous WHERE vault=$1', [oldRow.vault]);
    await db.query(`INSERT INTO public.vault_state_previous (${columns.join(',')})
      VALUES (${entries.map((_, i) => `$${i + 1}`).join(',')})
      ON CONFLICT (vault) DO UPDATE SET ${columns.filter((key) => key !== 'vault').map((key) => `${key}=EXCLUDED.${key}`).join(',')},updated_at=now()`,
    entries.map(([key, value]) => key === 'users_jsonb' ? JSON.stringify(value) : value));
    await db.query('COMMIT');
    return 'checked';
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { db.release(); }
}
