/**
 * invariants.ts — the canonical catalogue of the eight Vault invariants.
 *
 * This is the single source of truth the assurance engine resolves audit
 * findings and exploit replays against. The same eight properties are asserted
 * by test/invariant/InvariantVault.t.sol and mirrored live by
 * guardian/src/evaluator.ts; `harnessTest` records the Foundry function name so
 * the traceability resolver can verify a finding's reference is not dangling.
 */

/** Static metadata for one of the eight monitored invariants. */
export interface InvariantMeta {
  /** Canonical identifier, e.g. "INV-01". */
  id: string;
  /** Human-readable name. */
  name: string;
  /** The mathematical property, as a one-line formula. */
  formula: string;
  /** The `invariant_*` function asserting this property in the Foundry harness. */
  harnessTest: string;
}

/** The eight invariants, in canonical INV-01..INV-08 order. */
export const INVARIANTS: readonly InvariantMeta[] = [
  {
    id: 'INV-01',
    name: 'Solvency',
    formula: 'totalBorrowed <= totalDeposited',
    harnessTest: 'invariant_solvency',
  },
  {
    id: 'INV-02',
    name: 'Liquidity buffer',
    formula: 'token.balanceOf(vault) >= totalDeposited - totalBorrowed',
    harnessTest: 'invariant_liquidityBuffer',
  },
  {
    id: 'INV-03',
    name: 'Share price floor',
    formula: 'sharePrice >= 1e18',
    harnessTest: 'invariant_sharePriceFloor',
  },
  {
    id: 'INV-04',
    name: 'Share accounting',
    formula: 'totalShares == sum(userShares[i])',
    harnessTest: 'invariant_shareAccounting',
  },
  {
    id: 'INV-05',
    name: 'Collateral cap',
    formula: 'userBorrowed[u] <= userShares[u] * sharePrice / 1e18 * collateralRatio',
    harnessTest: 'invariant_collateralCap',
  },
  {
    id: 'INV-06',
    name: 'No share inflation',
    formula: 'sharePrice * totalShares / 1e18 <= totalDeposited',
    harnessTest: 'invariant_noShareInflation',
  },
  {
    id: 'INV-07',
    name: 'Non-negative net',
    formula: 'totalDeposited >= totalBorrowed',
    harnessTest: 'invariant_nonNegativeNet',
  },
  {
    id: 'INV-08',
    name: 'Zero-state consistency',
    formula: 'totalShares == 0  <->  totalDeposited == 0',
    harnessTest: 'invariant_zeroStateConsistency',
  },
] as const;

/** The set of valid invariant IDs. */
export const INVARIANT_IDS: ReadonlySet<string> = new Set(INVARIANTS.map((i) => i.id));

/** The set of harness `invariant_*` function names. */
export const HARNESS_TESTS: ReadonlySet<string> = new Set(INVARIANTS.map((i) => i.harnessTest));

/** Look up an invariant by ID. */
export function invariantById(id: string): InvariantMeta | undefined {
  return INVARIANTS.find((i) => i.id === id);
}
