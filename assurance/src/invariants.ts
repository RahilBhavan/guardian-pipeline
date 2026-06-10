/**
 * invariants.ts — the canonical catalogue of the twelve Vault invariants.
 *
 * This is the single source of truth the assurance engine resolves security-review
 * findings and exploit replays against. The same twelve properties are asserted
 * by test/invariant/InvariantVault.t.sol and mirrored live by
 * guardian/src/evaluator.ts; `harnessTest` records the Foundry function name so
 * the traceability resolver can verify a finding's reference is not dangling.
 */

/** Static metadata for one monitored invariant. */
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

/** The twelve invariants, in canonical INV-01..INV-12 order. */
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
  {
    id: 'INV-07',
    name: 'Per-block solvency monotonicity',
    formula: '(totalAssets - totalSupplyAssets)_t >= (totalAssets - totalSupplyAssets)_{t-1}',
    harnessTest: 'invariant_solvencyMonotone',
  },
  {
    id: 'INV-08',
    name: 'No-free-lunch on liquidation',
    formula: 'forall Liquidated: seized * price * BPS <= paid * (BPS + bonus) * WAD',
    harnessTest: 'invariant_liquidationNoFreeLunch',
  },
  {
    id: 'INV-09',
    name: 'Per-position debt monotonicity under accrual',
    formula: 'userBorrowShares[a]_t == userBorrowShares[a]_{t-1}  =>  userDebt(a)_t >= userDebt(a)_{t-1}',
    harnessTest: 'invariant_debtMonotoneUnderAccrual',
  },
  {
    id: 'INV-10',
    name: 'Debt rounding favours the protocol',
    formula: 'sum(userDebt[a]) <= totalBorrowed',
    harnessTest: 'invariant_debtRoundingFavoursProtocol',
  },
  {
    id: 'INV-11',
    name: 'Oracle freshness gate',
    formula: 'block.timestamp - oracle.lastUpdatedAt <= MAX_STALENESS',
    harnessTest: 'invariant_oracleFreshnessGate',
  },
  {
    id: 'INV-12',
    name: 'Accrue idempotence',
    formula: '(borrowIndex, totalSupplyAssets, totalBorrowShares, lastAccrualTime) unchanged by a second accrue() in the same block',
    harnessTest: 'invariant_accrueIdempotent',
  },
] as const;

/** The set of valid invariant IDs. */
export const INVARIANT_IDS: ReadonlySet<string> = new Set(INVARIANTS.map((i) => i.id));

/**
 * Auxiliary harness tests that defend a finding's class but are not one of
 * the twelve top-level invariants.
 */
export const AUXILIARY_HARNESS_TESTS: readonly string[] = [
  'invariant_reentrancySafe',
] as const;

/** The set of harness `invariant_*` function names — twelve core + auxiliary. */
export const HARNESS_TESTS: ReadonlySet<string> = new Set([
  ...INVARIANTS.map((i) => i.harnessTest),
  ...AUXILIARY_HARNESS_TESTS,
]);
