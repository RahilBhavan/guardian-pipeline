/**
 * router.ts — persists alerts and block-checks to Supabase.
 *
 * Every database call is wrapped so an outage never crashes the Guardian.
 * A monitor that dies on its own alert path is worse than no monitor at all.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from 'pino';
import type { AlertPayload, InvariantResult } from './types.js';

/**
 * Insert one row per violation into the `alerts` table.
 * Failures are logged and swallowed.
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

  try {
    const { error } = await supabase.from('alerts').insert(rows);
    if (error) {
      logger.error({ error }, 'Failed to insert alert rows into Supabase');
    } else {
      logger.info({ count: rows.length }, 'Alert rows written to Supabase');
    }
  } catch (err) {
    logger.error({ err }, 'Unexpected error writing alerts to Supabase');
  }
}

/**
 * Insert one row into `blocks_checked` for every block the Guardian inspects —
 * this feeds the dashboard's latency history and liveness indicator.
 * Failures are logged and swallowed.
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
  try {
    const { error } = await supabase.from('blocks_checked').insert({
      vault: params.vaultAddress,
      block_number: Number(params.blockNumber),
      all_passed: params.allPassed,
      latency_ms: Math.round(params.latencyMs),
      violations_count: params.violationsCount,
    });
    if (error) {
      logger.error({ error }, 'Failed to insert blocks_checked row');
    }
  } catch (err) {
    logger.error({ err }, 'Unexpected error writing blocks_checked row');
  }
}
