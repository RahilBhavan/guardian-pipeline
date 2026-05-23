/**
 * router.ts — persists alerts and block-checks to Supabase.
 *
 * Every database call retries on transient failure (exponential backoff, four
 * attempts) before giving up. After retry exhaustion the failure is
 * **escalated** through the shared {@link GuardianState}: the
 * `consecutiveInsertFailures` gauge is bumped, the `alertInsertFailedTotal`
 * counter is incremented (only for alert inserts), and on threshold milestones
 * (1, 5, 25, 100, 500) a loud error is emitted so operators see a persistent
 * DB outage without log-tailing. On the first success after a failure run the
 * counter resets and a recovery line is logged. The bot itself does not crash
 * on a DB outage — a monitor that dies on its own alert path is worse than
 * one that escalates loudly and keeps watching.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from 'pino';
import type { GuardianState } from './health.js';
import type { AlertPayload, InvariantResult } from './types.js';

/**
 * Max retry attempts per insert and the base backoff. Delays double each
 * attempt — 200, 400, 800ms — so the total worst-case wait before giving up
 * is ~1.4s, comfortably inside one ~2s block interval.
 */
const INSERT_ATTEMPTS = 4;
const INSERT_BASE_BACKOFF_MS = 200;

/**
 * Re-log a persistent DB outage at error level on these consecutive-failure
 * counts — first failure is loud, subsequent failures stay quieter at the
 * `warn` level used inside the retry loop until a milestone is hit. Mirrors
 * the cadence used for block-check failures in `bot.ts`.
 */
const INSERT_FAILURE_ESCALATION_THRESHOLDS = new Set([1, 5, 25, 100, 500]);

/** Promise-based sleep. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run a Supabase insert with exponential-backoff retry. Treats both a
 * thrown error (network / driver) and a non-null `{ error }` (server-side
 * rejection) as failure. Returns `{ ok: true }` on the first success, or
 * `{ ok: false, error }` after all attempts are exhausted.
 *
 * Kept local to this module — the only persistence path in the bot — so the
 * helper does not become a generic library function in advance of a need.
 */
async function insertWithRetry(
  op: () => PromiseLike<{ error: unknown }>,
  label: string,
  logger: Logger,
): Promise<{ ok: boolean; error?: unknown }> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= INSERT_ATTEMPTS; attempt++) {
    try {
      const { error } = await op();
      if (!error) return { ok: true };
      lastError = error;
    } catch (err) {
      lastError = err;
    }
    if (attempt === INSERT_ATTEMPTS) break;
    const delay = INSERT_BASE_BACKOFF_MS * 2 ** (attempt - 1);
    logger.warn(
      { err: lastError, label, attempt, nextRetryMs: delay },
      'Supabase insert failed — retrying',
    );
    await sleep(delay);
  }
  return { ok: false, error: lastError };
}

/**
 * Record an insert outcome on the shared state and emit the appropriate log
 * line. Mutates `state.consecutiveInsertFailures`. The caller has already
 * logged the per-attempt warnings; this is the cross-call summary that lets
 * operators see whether the outage is transient or sustained.
 */
function recordInsertOutcome(
  state: GuardianState,
  logger: Logger,
  outcome: { ok: boolean; error?: unknown },
  context: { label: string; block?: bigint; count?: number },
): void {
  if (outcome.ok) {
    if (state.consecutiveInsertFailures > 0) {
      logger.info(
        { label: context.label, recoveredAfter: state.consecutiveInsertFailures },
        'Supabase inserts recovered after consecutive failures',
      );
      state.consecutiveInsertFailures = 0;
    }
    return;
  }

  state.consecutiveInsertFailures += 1;
  const n = state.consecutiveInsertFailures;
  const escalate = INSERT_FAILURE_ESCALATION_THRESHOLDS.has(n);
  const fields = {
    err: outcome.error,
    label: context.label,
    consecutiveInsertFailures: n,
    block: context.block?.toString(),
    count: context.count,
  };
  if (escalate) {
    logger.error(
      fields,
      `Supabase ${context.label} insert giving up — ${n} consecutive failures (DB outage suspected)`,
    );
  } else {
    logger.warn(fields, `Supabase ${context.label} insert giving up — retries exhausted`);
  }
}

/**
 * Insert one row per violation into the `alerts` table, retrying on transient
 * failure. After all retries are exhausted the failure is escalated through
 * the shared state (counter + gauge + threshold log line) but never thrown —
 * the Guardian keeps watching subsequent blocks.
 */
export async function logAlertToSupabase(
  supabase: SupabaseClient,
  payload: AlertPayload,
  logger: Logger,
  state: GuardianState,
): Promise<void> {
  const rows = payload.violations.map((v: InvariantResult) => ({
    vault: payload.vaultAddress,
    block_number: Number(payload.blockNumber),
    block_ts: new Date(payload.timestamp * 1000).toISOString(),
    invariant_id: v.id,
    invariant_name: v.name,
    passed: v.passed,
    actual_value: v.actualValue.toString(),
    bound_value: v.boundValue.toString(),
    description: v.description,
    detection_latency_ms: Math.round(payload.detectionLatencyMs),
  }));

  const result = await insertWithRetry(
    () => supabase.from('alerts').insert(rows),
    'alerts',
    logger,
  );
  if (result.ok) {
    logger.info({ count: rows.length }, 'Alert rows written to Supabase');
  } else {
    // Alerts are the load-bearing write — separate counter so dashboards can
    // alarm specifically on dropped alerts (vs. lost liveness rows).
    state.alertInsertFailedTotal += 1;
  }
  recordInsertOutcome(state, logger, result, {
    label: 'alerts',
    block: payload.blockNumber,
    count: rows.length,
  });
}

/**
 * Insert exactly one row into `blocks_checked` for every inspected block —
 * this feeds the dashboard's latency history and liveness indicator. Retries
 * on transient failure; on exhaustion the failure is escalated through the
 * shared state. A gap in `blocks_checked` will also surface to the dashboard
 * as a stale-timestamp liveness loss, which is the correct user-visible
 * signal even if our logs are not being read.
 */
export async function logBlockCheck(
  supabase: SupabaseClient,
  params: {
    vaultAddress: string;
    blockNumber: bigint;
    allPassed: boolean;
    latencyMs: number;
    violationsCount: number;
  },
  logger: Logger,
  state: GuardianState,
): Promise<void> {
  const row = {
    vault: params.vaultAddress,
    block_number: Number(params.blockNumber),
    all_passed: params.allPassed,
    latency_ms: Math.round(params.latencyMs),
    violations_count: params.violationsCount,
  };
  const result = await insertWithRetry(
    () => supabase.from('blocks_checked').insert(row),
    'blocks_checked',
    logger,
  );
  recordInsertOutcome(state, logger, result, {
    label: 'blocks_checked',
    block: params.blockNumber,
  });
}
