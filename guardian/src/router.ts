/**
 * router.ts — persists alerts and block-checks to Supabase.
 *
 * Every database call retries on transient failure (exponential backoff, four
 * attempts) before giving up, then logs at error level and returns — an outage
 * never crashes the Guardian. A monitor that dies on its own alert path is
 * worse than no monitor at all, but one that silently drops every alert
 * during a 30-second blip is almost as bad — the retries cover that gap.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from 'pino';
import type { AlertPayload, InvariantResult } from './types.js';

/**
 * Max retry attempts per insert and the base backoff. Delays double each
 * attempt — 200, 400, 800ms — so the total worst-case wait before giving up
 * is ~1.4s, comfortably inside one ~2s block interval.
 */
const INSERT_ATTEMPTS = 4;
const INSERT_BASE_BACKOFF_MS = 200;

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
 * Insert one row per violation into the `alerts` table, retrying on transient
 * failure. After all retries are exhausted the error is logged and swallowed
 * so the Guardian keeps watching subsequent blocks.
 */
export async function logAlertToSupabase(
  supabase: SupabaseClient,
  payload: AlertPayload,
  logger: Logger,
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
    logger.error(
      { err: result.error, count: rows.length, block: payload.blockNumber.toString() },
      'Gave up writing alert rows after all retries — alerts lost for this block',
    );
  }
}

/**
 * Insert one row into `blocks_checked` for every block the Guardian inspects —
 * this feeds the dashboard's latency history and liveness indicator. Retries
 * on transient failure; logs at error level and returns if all retries are
 * exhausted. A gap in `blocks_checked` will surface to the dashboard as
 * stale-timestamp liveness loss, which is the correct user-visible signal.
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
  if (!result.ok) {
    logger.error(
      { err: result.error, block: params.blockNumber.toString() },
      'Gave up writing blocks_checked row after all retries',
    );
  }
}
