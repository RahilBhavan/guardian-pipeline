/**
 * invariants.ts — the canonical catalogue of the six Vault invariants.
 *
 * This is the single source of truth the assurance engine resolves security-review
 * findings and exploit replays against. The same six properties are asserted
 * by test/invariant/InvariantVault.t.sol and mirrored live by
 * guardian/src/evaluator.ts; `harnessTest` records the Foundry function name so
 * the traceability resolver can verify a finding's reference is not dangling.
 */

/** Static metadata for one of the six monitored invariants. */
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

/** The six invariants, in canonical INV-01..INV-06 order. */
export const INVARIANTS: readonly InvariantMeta[] = [
  {
    id: 'INV-01',
    name: 'Protocol solvency',
    formula: 'cash + totalBorrowed >= totalSupplyAssets',
    harnessTest: 'invariant_solvency',
  },
  {
    id: 'INV-02',
    name: 'Supply-share integrity',
    formula: 'totalSupplyShares == sum(userSupplyShares[i])',
    harnessTest: 'invariant_supplyShareIntegrity',
  },
  {
    id: 'INV-03',
    name: 'Debt-share integrity',
    formula: 'totalBorrowShares == sum(userBorrowShares[i])',
    harnessTest: 'invariant_debtShareIntegrity',
  },
  {
    id: 'INV-04',
    name: 'Lender-value floor',
    formula: 'totalSupplyAssets >= totalSupplyShares',
    harnessTest: 'invariant_lenderValueFloor',
  },
  {
    id: 'INV-05',
    name: 'Interest-index floor',
    formula: 'borrowIndex >= 1e18',
    harnessTest: 'invariant_interestIndexFloor',
  },
  {
    id: 'INV-06',
    name: 'No uncollateralised debt',
    formula: 'userSupplyShares[u] == 0  =>  userDebt(u) == 0',
    harnessTest: 'invariant_noUncollateralisedDebt',
  },
] as const;

/** The set of valid invariant IDs. */
export const INVARIANT_IDS: ReadonlySet<string> = new Set(INVARIANTS.map((i) => i.id));

/** The set of harness `invariant_*` function names. */
export const HARNESS_TESTS: ReadonlySet<string> = new Set(INVARIANTS.map((i) => i.harnessTest));
