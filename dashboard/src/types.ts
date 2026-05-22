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

/** Static metadata for one of the six monitored invariants. */
export interface InvariantMeta {
  id: string;
  name: string;
  description: string;
}

/** The six invariants, in canonical order — matches the Solidity harness. */
export const INVARIANTS: readonly InvariantMeta[] = [
  { id: 'INV-01', name: 'Protocol solvency', description: 'cash + totalBorrowed ≥ totalSupplyAssets' },
  { id: 'INV-02', name: 'Supply-share integrity', description: 'totalSupplyShares = Σ userSupplyShares' },
  { id: 'INV-03', name: 'Debt-share integrity', description: 'totalBorrowShares = Σ userBorrowShares' },
  { id: 'INV-04', name: 'Lender-value floor', description: 'totalSupplyAssets ≥ totalSupplyShares' },
  { id: 'INV-05', name: 'Interest-index floor', description: 'borrowIndex ≥ 1e18' },
  { id: 'INV-06', name: 'No uncollateralised debt', description: 'zero collateral ⇒ zero debt' },
] as const;
