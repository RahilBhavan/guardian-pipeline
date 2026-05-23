/**
 * health.test.ts — focused smoke test for the health server.
 *
 * Uses node's built-in test runner (node --test) so no new dependency is
 * needed. Runs over the source via tsx (already a devDep).
 *
 * Covers the three pieces of behaviour the SRE review called out:
 *   1. /healthz returns 200 + correct JSON shape when state is healthy.
 *   2. /healthz returns 503 when the circuit breaker is open.
 *   3. /metrics returns Prometheus-format text with the expected metric names.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import {
  createGuardianState,
  evaluateHealth,
  renderHealthBody,
  renderMetrics,
  startHealthServer,
} from './health.js';

/** Silent logger so test output stays clean. */
const silentLogger = pino({ level: 'silent' });

/** Get a free ephemeral port by binding the server on `0`. */
async function startOnEphemeralPort(state: ReturnType<typeof createGuardianState>): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = await startHealthServer(state, silentLogger, 0, '127.0.0.1');
  const addr = server.address() as AddressInfo;
  return {
    port: addr.port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

test('evaluateHealth: healthy when no checks have run yet', () => {
  const state = createGuardianState({ blockPollIntervalMs: 2000, maxHealthyBlocks: 30 });
  const verdict = evaluateHealth(state);
  assert.equal(verdict.healthy, true);
});

test('evaluateHealth: unhealthy when breaker is open', () => {
  const state = createGuardianState({ blockPollIntervalMs: 2000, maxHealthyBlocks: 30 });
  state.breakerState = 'open';
  state.circuitBreakerOpen = 1;
  const verdict = evaluateHealth(state);
  assert.equal(verdict.healthy, false);
  assert.equal(verdict.reason, 'breaker_open');
});

test('evaluateHealth: unhealthy when last check is stale beyond threshold', () => {
  const state = createGuardianState({ blockPollIntervalMs: 2000, maxHealthyBlocks: 30 });
  // maxHealthyStalenessMs = 2000 * 2 * 30 = 120_000ms.
  const longAgo = new Date(Date.now() - 200_000).toISOString();
  state.lastBlockCheckedAt = longAgo;
  const verdict = evaluateHealth(state);
  assert.equal(verdict.healthy, false);
  assert.equal(verdict.reason, 'stale_block_checks');
});

test('renderHealthBody: shape matches contract', () => {
  const state = createGuardianState({ blockPollIntervalMs: 2000, maxHealthyBlocks: 30 });
  state.lastBlockChecked = 42;
  state.lastBlockCheckedAt = '2026-01-01T00:00:00.000Z';
  state.consecutiveBlockCheckFailures = 2;
  const body = JSON.parse(renderHealthBody(state));
  assert.equal(body.status, 'ok');
  assert.equal(body.lastBlockCheckedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(body.lastBlockCheckedNumber, 42);
  assert.equal(body.consecutiveFailures, 2);
  assert.equal(body.breakerState, 'closed');
});

test('renderMetrics: emits all expected metric names + HELP/TYPE lines', () => {
  const state = createGuardianState({ blockPollIntervalMs: 2000, maxHealthyBlocks: 30 });
  state.blockChecksTotal = 7;
  state.violationsDetectedTotal['INV-01'] = 3;
  state.alertInsertFailedTotal = 1;
  const body = renderMetrics(state);
  for (const name of [
    'guardian_block_checks_total',
    'guardian_block_checks_failed_total',
    'guardian_violations_detected_total',
    'guardian_alert_insert_failed_total',
    'guardian_block_check_latency_ms',
    'guardian_consecutive_block_check_failures',
    'guardian_consecutive_insert_failures',
    'guardian_circuit_breaker_open',
    'guardian_last_block_checked',
  ]) {
    assert.ok(body.includes(`# HELP ${name} `), `missing HELP for ${name}`);
    assert.ok(body.includes(`# TYPE ${name} `), `missing TYPE for ${name}`);
  }
  assert.ok(body.includes('guardian_block_checks_total 7'));
  assert.ok(body.includes('guardian_violations_detected_total{invariant_id="INV-01"} 3'));
});

test('HTTP /healthz returns 200 when healthy', async () => {
  const state = createGuardianState({ blockPollIntervalMs: 2000, maxHealthyBlocks: 30 });
  const { port, close } = await startOnEphemeralPort(state);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal((body as { breakerState: string }).breakerState, 'closed');
  } finally {
    await close();
  }
});

test('HTTP /healthz returns 503 when breaker is open', async () => {
  const state = createGuardianState({ blockPollIntervalMs: 2000, maxHealthyBlocks: 30 });
  state.breakerState = 'open';
  state.circuitBreakerOpen = 1;
  const { port, close } = await startOnEphemeralPort(state);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal((body as { breakerState: string }).breakerState, 'open');
  } finally {
    await close();
  }
});

test('HTTP /metrics returns Prometheus content-type and expected names', async () => {
  const state = createGuardianState({ blockPollIntervalMs: 2000, maxHealthyBlocks: 30 });
  const { port, close } = await startOnEphemeralPort(state);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(res.status, 200);
    const ct = res.headers.get('content-type') ?? '';
    assert.ok(ct.startsWith('text/plain'), `unexpected content-type: ${ct}`);
    assert.ok(ct.includes('version=0.0.4'), `missing prom version in content-type: ${ct}`);
    const body = await res.text();
    assert.ok(body.includes('guardian_block_checks_total '));
    assert.ok(body.includes('guardian_circuit_breaker_open '));
  } finally {
    await close();
  }
});

test('HTTP unknown route returns 404', async () => {
  const state = createGuardianState({ blockPollIntervalMs: 2000, maxHealthyBlocks: 30 });
  const { port, close } = await startOnEphemeralPort(state);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});
