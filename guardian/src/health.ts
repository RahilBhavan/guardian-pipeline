/**
 * health.ts — /healthz and /metrics endpoints.
 *
 * A small HTTP server on top of node:http (no new deps) exposing two routes:
 *
 *   GET /healthz  — liveness/readiness JSON; 200 healthy, 503 unhealthy
 *   GET /metrics  — Prometheus exposition format
 *
 * All counters and gauges live on a single `GuardianState` object so there are
 * no module-level globals — the bot owns the state and mutates it as blocks
 * are checked and as the circuit breaker / DB-insert escalation update.
 */
import http, { type IncomingMessage, type RequestListener, type Server, type ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import type { InvariantId } from './types.js';

/** Circuit-breaker phase. `'open'` means RPC calls are suppressed. */
export type BreakerState = 'closed' | 'open';

/**
 * Single source of truth for everything the health server exposes. The bot
 * mutates these fields in place; `startHealthServer` only reads them.
 */
export interface GuardianState {
  /** Counter: total block-check attempts (success + failure). */
  blockChecksTotal: number;
  /** Counter: block checks that threw or otherwise failed. */
  blockChecksFailedTotal: number;
  /** Counter: persisted violation rows, keyed by invariant id. */
  violationsDetectedTotal: Record<InvariantId, number>;
  /** Counter: alert inserts that exhausted all retries. */
  alertInsertFailedTotal: number;
  /** Gauge: last block-check latency, ms. */
  blockCheckLatencyMs: number;
  /** Gauge: consecutive failed block checks (resets on success). */
  consecutiveBlockCheckFailures: number;
  /** Gauge: consecutive failed Supabase inserts (resets on success). */
  consecutiveInsertFailures: number;
  /** Gauge mirror of `breakerState` (0 = closed, 1 = open). */
  circuitBreakerOpen: 0 | 1;
  /** Gauge: highest block number the bot has finished checking. */
  lastBlockChecked: number;
  /** ISO8601 timestamp of the last successful block check, or null. */
  lastBlockCheckedAt: string | null;
  /** Live breaker phase. */
  breakerState: BreakerState;
  /**
   * Max ms between block checks before /healthz reports unhealthy. Computed
   * from `blockPollIntervalMs * 2 * MAX_HEALTHY_BLOCKS` at startup so the
   * health threshold scales with the configured poll interval.
   */
  maxHealthyStalenessMs: number;
}

/** Build the initial state struct. The bot then mutates this in place. */
export function createGuardianState(params: {
  blockPollIntervalMs: number;
  maxHealthyBlocks: number;
}): GuardianState {
  return {
    blockChecksTotal: 0,
    blockChecksFailedTotal: 0,
    violationsDetectedTotal: {
      'INV-01': 0,
      'INV-02': 0,
      'INV-03': 0,
      'INV-04': 0,
      'INV-05': 0,
      'INV-06': 0,
      'INV-07': 0,
      'INV-08': 0,
      'INV-09': 0,
      'INV-10': 0,
      'INV-11': 0,
      'INV-12': 0,
    },
    alertInsertFailedTotal: 0,
    blockCheckLatencyMs: 0,
    consecutiveBlockCheckFailures: 0,
    consecutiveInsertFailures: 0,
    circuitBreakerOpen: 0,
    lastBlockChecked: 0,
    lastBlockCheckedAt: null,
    breakerState: 'closed',
    maxHealthyStalenessMs: params.blockPollIntervalMs * 2 * params.maxHealthyBlocks,
  };
}

/** Decide whether the bot is "healthy enough" to return 200 on /healthz. */
export function evaluateHealth(state: GuardianState, now: number = Date.now()): {
  healthy: boolean;
  reason?: 'breaker_open' | 'stale_block_checks' | 'never_checked';
} {
  if (state.breakerState === 'open') return { healthy: false, reason: 'breaker_open' };
  // No block has been checked yet — treat as healthy if the bot just started;
  // the staleness check below uses lastBlockCheckedAt and is the source of
  // truth once at least one check has run.
  if (state.lastBlockCheckedAt === null) return { healthy: true };
  const ageMs = now - Date.parse(state.lastBlockCheckedAt);
  if (ageMs > state.maxHealthyStalenessMs) return { healthy: false, reason: 'stale_block_checks' };
  return { healthy: true };
}

/** Render the /healthz JSON body. */
export function renderHealthBody(state: GuardianState): string {
  return JSON.stringify({
    status: state.breakerState === 'open' ? 'degraded' : 'ok',
    lastBlockCheckedAt: state.lastBlockCheckedAt,
    lastBlockCheckedNumber: state.lastBlockChecked,
    consecutiveFailures: state.consecutiveBlockCheckFailures,
    breakerState: state.breakerState,
  });
}

/** Render the /metrics body in Prometheus exposition format. */
export function renderMetrics(state: GuardianState): string {
  const lines: string[] = [];

  lines.push('# HELP guardian_block_checks_total Total block-check attempts.');
  lines.push('# TYPE guardian_block_checks_total counter');
  lines.push(`guardian_block_checks_total ${state.blockChecksTotal}`);

  lines.push('# HELP guardian_block_checks_failed_total Block checks that threw or otherwise failed.');
  lines.push('# TYPE guardian_block_checks_failed_total counter');
  lines.push(`guardian_block_checks_failed_total ${state.blockChecksFailedTotal}`);

  lines.push('# HELP guardian_violations_detected_total Persisted violation rows, by invariant id.');
  lines.push('# TYPE guardian_violations_detected_total counter');
  for (const [id, n] of Object.entries(state.violationsDetectedTotal)) {
    lines.push(`guardian_violations_detected_total{invariant_id="${id}"} ${n}`);
  }

  lines.push('# HELP guardian_alert_insert_failed_total Alert inserts that exhausted all retries.');
  lines.push('# TYPE guardian_alert_insert_failed_total counter');
  lines.push(`guardian_alert_insert_failed_total ${state.alertInsertFailedTotal}`);

  lines.push('# HELP guardian_block_check_latency_ms Latency of the most recent block check, ms.');
  lines.push('# TYPE guardian_block_check_latency_ms gauge');
  lines.push(`guardian_block_check_latency_ms ${state.blockCheckLatencyMs}`);

  lines.push('# HELP guardian_consecutive_block_check_failures Consecutive failed block checks.');
  lines.push('# TYPE guardian_consecutive_block_check_failures gauge');
  lines.push(`guardian_consecutive_block_check_failures ${state.consecutiveBlockCheckFailures}`);

  lines.push('# HELP guardian_consecutive_insert_failures Consecutive failed Supabase inserts.');
  lines.push('# TYPE guardian_consecutive_insert_failures gauge');
  lines.push(`guardian_consecutive_insert_failures ${state.consecutiveInsertFailures}`);

  lines.push('# HELP guardian_circuit_breaker_open 1 when the RPC circuit breaker is open, 0 otherwise.');
  lines.push('# TYPE guardian_circuit_breaker_open gauge');
  lines.push(`guardian_circuit_breaker_open ${state.circuitBreakerOpen}`);

  lines.push('# HELP guardian_last_block_checked Highest block number the bot has finished checking.');
  lines.push('# TYPE guardian_last_block_checked gauge');
  lines.push(`guardian_last_block_checked ${state.lastBlockChecked}`);

  // Trailing newline is required by the Prometheus text format.
  return lines.join('\n') + '\n';
}

/** Handle one request — pure routing on top of the state object. */
export function handleRequest(state: GuardianState, req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? '';
  // Strip query string — we don't use it but a scrape with ?foo=bar should
  // still match the route.
  const path = url.split('?', 1)[0];

  if (req.method !== 'GET') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed\n');
    return;
  }

  if (path === '/healthz') {
    const verdict = evaluateHealth(state);
    res.writeHead(verdict.healthy ? 200 : 503, {
      'content-type': 'application/json; charset=utf-8',
    });
    res.end(renderHealthBody(state));
    return;
  }

  if (path === '/metrics') {
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(renderMetrics(state));
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not Found\n');
}

/** Start the HTTP server. Returns the running server (for shutdown). */
export function startHealthServer(
  state: GuardianState,
  logger: Logger,
  port: number,
  host: string = '0.0.0.0',
): Promise<Server> {
  const listener: RequestListener = (req, res) => handleRequest(state, req, res);
  const server = http.createServer(listener);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      logger.info({ host, port }, 'Health server listening on /healthz and /metrics');
      resolve(server);
    });
  });
}
