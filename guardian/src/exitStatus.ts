/** Exit codes of the scheduled single-pass check, so a red run says why. */
export type RunOutcome = 'ok' | 'infra' | 'violation' | 'behind';

export const EXIT_CODES: Record<RunOutcome, number> = { ok: 0, infra: 1, violation: 2, behind: 3 };

/**
 * `violations` are the failed invariant ids at the last block committed by this run.
 * A violation outranks lag: a breach is worth reporting even while the backlog drains.
 */
export function classifyRun(head: bigint, checkpoint: bigint | undefined, violations: readonly string[]): Exclude<RunOutcome, 'infra'> {
  if (violations.length > 0) return 'violation';
  return checkpoint === undefined || checkpoint < head ? 'behind' : 'ok';
}
