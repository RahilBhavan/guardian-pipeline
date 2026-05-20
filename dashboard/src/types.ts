/** Shared dashboard types — mirror the Supabase `alerts` / `blocks_checked` tables. */

/** One row of the `alerts` table — a single invariant violation event. */
export interface AlertRow {
  id: string;
  created_at: string;
  vault: string;
  block_number: number;
  invariant_id: string;
  invariant_name: string;
  actual_value: string;
  bound_value: string;
  description: string;
  detection_latency_ms: number | null;
}

/** One row of the `blocks_checked` table — a single Guardian liveness heartbeat. */
export interface BlockCheckedRow {
  id: string;
  checked_at: string;
  block_number: number;
  vault: string;
  all_passed: boolean;
  latency_ms: number | null;
  violations_count: number;
}

/** A single point on the latency sparkline. */
export interface LatencyPoint {
  blockNumber: number;
  latencyMs: number;
  checkedAt: Date;
}

/** Static metadata for one of the eight monitored invariants. */
export interface InvariantMeta {
  id: string;
  name: string;
  description: string;
}

/** The eight invariants, in canonical order — matches the Solidity harness. */
export const INVARIANTS: readonly InvariantMeta[] = [
  { id: 'INV-01', name: 'Solvency', description: 'totalBorrowed ≤ totalDeposited' },
  { id: 'INV-02', name: 'Liquidity buffer', description: 'tokenBalance ≥ totalDeposited − totalBorrowed' },
  { id: 'INV-03', name: 'Share price floor', description: 'sharePrice ≥ 1e18' },
  { id: 'INV-04', name: 'Share accounting', description: 'totalShares = Σ userShares[i]' },
  { id: 'INV-05', name: 'Collateral cap', description: 'borrows ≤ collateral × ratio' },
  { id: 'INV-06', name: 'No share inflation', description: 'sharePrice × totalShares / 1e18 ≤ totalDeposited' },
  { id: 'INV-07', name: 'Non-negative net', description: 'totalDeposited ≥ totalBorrowed' },
  { id: 'INV-08', name: 'Zero-state consistency', description: 'totalShares = 0 ⇔ totalDeposited = 0' },
] as const;
