/**
 * recorded.ts — typed view of the recorded monitor run.
 *
 * `data/recorded-run.json` is written by scripts/record-demo-run.sh, which
 * replays the Guardian monitor's own fetcher and evaluator over a scripted
 * scenario on a local anvil chain. It is not live data and not Base Sepolia
 * data. The dashboard renders it when no live backend is configured.
 */
import runData from './data/recorded-run.json';
import { INVARIANTS } from './types';
import type { AlertRow, BlockCheckedRow, LatencyPoint } from './types';

interface RecordedBlock {
  blockNumber: number;
  blockTimestamp: number;
  allPassed: boolean;
  latencyMs: number;
  violationsCount: number;
}

interface RecordedAlert {
  blockNumber: number;
  blockTimestamp: number;
  invariantId: string;
  invariantName: string;
  actualValue: string;
  boundValue: string;
  description: string;
  detectionLatencyMs: number;
}

interface RecordedRun {
  kind: 'recorded-run';
  recordedAt: string;
  source: string;
  sourceCommit: string | null;
  scenario: string[];
  vault: string;
  firstBlock: number;
  lastBlock: number;
  blocks: RecordedBlock[];
  alerts: RecordedAlert[];
}

export const recordedRun = runData as RecordedRun;

/** Calendar date of the recording, e.g. "2026-10-24" (UTC). */
export const recordedDate = recordedRun.recordedAt.slice(0, 10);

const iso = (unixSeconds: number): string => new Date(unixSeconds * 1000).toISOString();

/** Alerts newest-first, in the shape the live feed uses. */
export function recordedAlerts(): AlertRow[] {
  return [...recordedRun.alerts]
    .reverse()
    .map((a, i) => ({
      id: `recorded-${i}`,
      created_at: iso(a.blockTimestamp),
      vault: recordedRun.vault,
      block_number: a.blockNumber,
      invariant_id: a.invariantId,
      invariant_name: a.invariantName,
      actual_value: a.actualValue,
      bound_value: a.boundValue,
      description: a.description,
      detection_latency_ms: a.detectionLatencyMs,
    }));
}

/** Per-block heartbeats, oldest-first. */
export function recordedBlockRows(): BlockCheckedRow[] {
  return recordedRun.blocks.map((b, i) => ({
    id: `recorded-block-${i}`,
    checked_at: iso(b.blockTimestamp),
    block_number: b.blockNumber,
    vault: recordedRun.vault,
    all_passed: b.allPassed,
    latency_ms: b.latencyMs,
    violations_count: b.violationsCount,
  }));
}

export function recordedLatency(): LatencyPoint[] {
  return recordedBlockRows().map((b) => ({
    blockNumber: b.block_number,
    latencyMs: b.latency_ms ?? 0,
    checkedAt: new Date(b.checked_at),
  }));
}

/** Invariant status at the last recorded block: false for each one that failed there. */
export function recordedFinalStatus(): Record<string, boolean | null> {
  const status: Record<string, boolean | null> = Object.fromEntries(INVARIANTS.map((i) => [i.id, true]));
  for (const a of recordedRun.alerts) if (a.blockNumber === recordedRun.lastBlock) status[a.invariantId] = false;
  return status;
}
