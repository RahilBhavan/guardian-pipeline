/**
 * router.ts — delivers alerts to Discord and Supabase.
 *
 * Every external call is wrapped so a failed webhook or a database outage
 * never crashes the Guardian. A monitor that dies on its own alert path is
 * worse than no monitor at all.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from 'pino';
import type { AlertPayload, InvariantResult } from './types.js';

/** Discord red (#E74C3C) as a decimal embed colour. */
const DISCORD_RED = 15158332;

/** Format a Unix-seconds timestamp as `YYYY-MM-DD HH:MM:SS UTC`. */
function formatUtc(unixSeconds: number): string {
  return `${new Date(unixSeconds * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/**
 * POST a violation embed to a Discord webhook.
 * Failures are logged and swallowed — they never propagate to the caller.
 */
export async function sendDiscordAlert(
  webhookUrl: string,
  payload: AlertPayload,
  logger: Logger,
): Promise<void> {
  const violationList = payload.violations
    .map((v: InvariantResult) => `${v.id}: ${v.name}`)
    .join('\n');

  const body = {
    embeds: [
      {
        title: '🚨 Invariant violation detected',
        color: DISCORD_RED,
        fields: [
          { name: 'Vault', value: payload.vaultAddress, inline: true },
          { name: 'Block', value: payload.blockNumber.toString(), inline: true },
          { name: 'Violations', value: violationList, inline: false },
          { name: 'Detected at', value: formatUtc(payload.timestamp), inline: true },
          { name: 'Detection latency', value: `${(payload.detectionLatencyMs / 1000).toFixed(1)}s`, inline: true },
        ],
        footer: { text: 'Guardian Pipeline · Base L2' },
      },
    ],
  };

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      logger.error({ status: res.status }, 'Discord webhook returned a non-2xx status');
    } else {
      logger.info({ block: payload.blockNumber.toString() }, 'Discord alert delivered');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to deliver Discord alert');
  }
}

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
