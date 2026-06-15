/**
 * evaluator.ts — 12-of-12 mirror across snapshot, delta, and
 * event-reconciliation channels.
 *
 * Every check here is the exact logical twin of its counterpart in
 * test/invariant/InvariantVault.t.sol. The twelve properties proven across
 * tens of thousands of fuzz calls pre-deployment are the same twelve
 * enforced live, block by block. Three detection channels coexist:
 *
 *   - **Snapshot (INV-01..06, INV-10, INV-11, INV-12)** — pure function of
 *     the current {@link VaultState}. Catches identity and rounding-direction
 *     mutations from one observation.
 *   - **Delta (INV-07, INV-09)** — takes the prior observation alongside
 *     the current. Catches monotonicity mutations (margin shrink, debt
 *     decrease under flat shares). The prior is persisted in Supabase per
 *     block; see {@link ./stateHistory.ts}.
 *   - **Event reconciliation (INV-08)** — reads each `Liquidated` log
 *     harvested from the polled range against the on-block oracle price
 *     and the vault's immutable bonus. INV-12's structural port asserts
 *     `lastAccrualTime == blockTimestamp` so a second accrue() would
 *     trivially no-op.
 *
 * Unlike a sampled proxy, INV-02/03/06/09/10 are evaluated against the
 * *actual* per-user positions the fetcher discovers from vault events.
 */
import type {
  InvariantResult,
  LiquidationEvent,
  PriorVaultState,
  VaultState,
} from './types.js';

const ONE_E18 = 1_000_000_000_000_000_000n;
const BPS = 10_000n;

/** Per-account current debt, floored — `floor(borrowShares * borrowIndex / WAD)`.
 *  Mirrors `Vault.userDebt`'s rounding direction byte-for-byte. */
function userDebt(borrowShares: bigint, borrowIndex: bigint): bigint {
  return (borrowShares * borrowIndex) / ONE_E18;
}

/** INV-01 Protocol solvency — assets must always cover lender claims. */
export function inv01(state: VaultState): InvariantResult {
  const assets = state.cash + state.totalBorrowed;
  return {
    id: 'INV-01',
    name: 'Protocol solvency',
    passed: assets >= state.totalSupplyAssets,
    actualValue: assets,
    boundValue: state.totalSupplyAssets,
    description: 'cash + totalBorrowed must cover totalSupplyAssets (lender claims)',
  };
}

/** INV-02 Supply-share integrity — totalSupplyShares equals the sum of all lender shares. */
export function inv02(state: VaultState): InvariantResult {
  const sum = state.users.reduce((acc, u) => acc + u.supplyShares, 0n);
  return {
    id: 'INV-02',
    name: 'Supply-share integrity',
    passed: state.totalSupplyShares === sum,
    actualValue: state.totalSupplyShares,
    boundValue: sum,
    description: 'totalSupplyShares must equal the sum of every userSupplyShares',
  };
}

/** INV-03 Debt-share integrity — totalBorrowShares equals the sum of all borrow shares. */
export function inv03(state: VaultState): InvariantResult {
  const sum = state.users.reduce((acc, u) => acc + u.borrowShares, 0n);
  return {
    id: 'INV-03',
    name: 'Debt-share integrity',
    passed: state.totalBorrowShares === sum,
    actualValue: state.totalBorrowShares,
    boundValue: sum,
    description: 'totalBorrowShares must equal the sum of every userBorrowShares',
  };
}

/** INV-04 Lender-value floor — the share price never falls below the 1:1 peg. */
export function inv04(state: VaultState): InvariantResult {
  return {
    id: 'INV-04',
    name: 'Lender-value floor',
    passed: state.totalSupplyAssets >= state.totalSupplyShares,
    actualValue: state.totalSupplyAssets,
    boundValue: state.totalSupplyShares,
    description: 'totalSupplyAssets must be >= totalSupplyShares (share price >= 1:1)',
  };
}

/** INV-05 Interest-index floor — the borrow index only ever accrues forward. */
export function inv05(state: VaultState): InvariantResult {
  return {
    id: 'INV-05',
    name: 'Interest-index floor',
    passed: state.borrowIndex >= ONE_E18,
    actualValue: state.borrowIndex,
    boundValue: ONE_E18,
    description: 'borrowIndex must be >= 1e18 (interest never accrues backwards)',
  };
}

/**
 * INV-06 No uncollateralised debt — an account with zero posted collateral
 * must carry no debt. `actualValue` reports the count of offending accounts.
 */
export function inv06(state: VaultState): InvariantResult {
  const offenders = state.users.filter(
    (u) => u.collateral === 0n && u.borrowShares > 0n,
  ).length;
  return {
    id: 'INV-06',
    name: 'No uncollateralised debt',
    passed: offenders === 0,
    actualValue: BigInt(offenders),
    boundValue: 0n,
    description: 'no account may hold debt while holding zero posted collateral',
  };
}

/**
 * INV-07 Per-observation solvency monotonicity — the solvency margin
 * `cash + totalBorrowed - totalSupplyAssets` never decreases between two
 * consecutive observations. The harness mirror is unconditional; activity-
 * gating (withdraw/borrow) is not part of the on-chain assertion, so the
 * off-chain port is also unconditional. Short-circuits to PASS on the first
 * observation after deploy or restart (no prior to compare against).
 */
export function inv07(state: VaultState, prior: PriorVaultState): InvariantResult {
  const current = state.cash + state.totalBorrowed - state.totalSupplyAssets;
  if (!prior) {
    return {
      id: 'INV-07',
      name: 'Per-observation solvency monotonicity',
      passed: true,
      actualValue: current,
      boundValue: current,
      description: 'no prior observation — delta check deferred to next block',
    };
  }
  const previous = prior.cash + prior.totalBorrowed - prior.totalSupplyAssets;
  return {
    id: 'INV-07',
    name: 'Per-observation solvency monotonicity',
    passed: current >= previous,
    actualValue: current,
    boundValue: previous,
    description: 'solvency margin (cash + totalBorrowed - totalSupplyAssets) must not decrease between observations',
  };
}

/**
 * INV-08 No-free-lunch on liquidation — every observed `Liquidated` event
 * must satisfy `seized * price * BPS <= paid * (BPS + bonus) * WAD`. This
 * is byte-equivalent to LiquidateHandler.sol's call-time check; `bonus`
 * is read from {@link VaultState.liquidationBonus} (immutable on the
 * deployed vault) and `price` is the per-event oracle reading attached
 * by {@link fetchLiquidationsInRange}. `actualValue` is the count of
 * offending liquidations.
 */
function checkLiquidationViolation(
  ev: LiquidationEvent,
  bonus: bigint,
): boolean {
  // LHS = seized * price * BPS; RHS = paid * (BPS + bonus) * WAD.
  const lhs = ev.collateralSeized * ev.oraclePrice * BPS;
  const rhs = ev.debtRepaid * (BPS + bonus) * ONE_E18;
  return lhs > rhs;
}

export function inv08(state: VaultState): InvariantResult {
  const offenders = state.liquidationEvents.filter((ev) =>
    checkLiquidationViolation(ev, state.liquidationBonus),
  ).length;
  return {
    id: 'INV-08',
    name: 'No-free-lunch on liquidation',
    passed: offenders === 0,
    actualValue: BigInt(offenders),
    boundValue: 0n,
    description: 'every Liquidated event must satisfy seized*price*BPS <= paid*(BPS+bonus)*WAD',
  };
}

/**
 * INV-09 Per-position debt monotonicity under accrual — for every actor
 * whose `borrowShares` was flat between observations, `userDebt` must not
 * decrease. Actor identity is matched on address; actors who are new in
 * the current snapshot (no prior position) are skipped. `actualValue`
 * reports the count of offending actors.
 */
export function inv09(state: VaultState, prior: PriorVaultState): InvariantResult {
  if (!prior) {
    return {
      id: 'INV-09',
      name: 'Per-position debt monotonicity under accrual',
      passed: true,
      actualValue: 0n,
      boundValue: 0n,
      description: 'no prior observation — delta check deferred to next block',
    };
  }
  const priorByAddr = new Map(prior.users.map((u) => [u.address, u]));
  let offenders = 0;
  for (const u of state.users) {
    const p = priorByAddr.get(u.address);
    if (!p) continue;
    if (p.borrowShares !== u.borrowShares) continue;
    const debtNow = userDebt(u.borrowShares, state.borrowIndex);
    const debtPrev = userDebt(p.borrowShares, prior.borrowIndex);
    if (debtNow < debtPrev) offenders++;
  }
  return {
    id: 'INV-09',
    name: 'Per-position debt monotonicity under accrual',
    passed: offenders === 0,
    actualValue: BigInt(offenders),
    boundValue: 0n,
    description: 'actors whose borrowShares were flat must not see userDebt decrease',
  };
}

/**
 * INV-10 Debt rounding favours the protocol — the sum of every actor's
 * floored `userDebt` cannot exceed `totalBorrowed` (itself a floor of the
 * total). Sum-of-floors ≤ floor-of-sum, so the check tensions on the
 * rounding direction of the per-actor view.
 */
export function inv10(state: VaultState): InvariantResult {
  const sum = state.users.reduce(
    (acc, u) => acc + userDebt(u.borrowShares, state.borrowIndex),
    0n,
  );
  return {
    id: 'INV-10',
    name: 'Debt rounding favours protocol',
    passed: sum <= state.totalBorrowed,
    actualValue: sum,
    boundValue: state.totalBorrowed,
    description: 'sum of userDebt(actor) must not exceed totalBorrowed',
  };
}

/**
 * INV-11 Oracle freshness gate — `blockTimestamp - oracleLastUpdatedAt`
 * must not exceed `MAX_STALENESS`. Mirrors the on-chain `_freshPrice`
 * guard that gates every price-dependent path.
 */
export function inv11(state: VaultState): InvariantResult {
  const blockTs = BigInt(state.blockTimestamp);
  // Underflow guard: a malformed snapshot where oracleLastUpdatedAt is in
  // the future is treated as fresh (gap = 0) rather than wrapping around.
  const gap = blockTs > state.oracleLastUpdatedAt ? blockTs - state.oracleLastUpdatedAt : 0n;
  return {
    id: 'INV-11',
    name: 'Oracle freshness gate',
    passed: gap <= state.maxStaleness,
    actualValue: gap,
    boundValue: state.maxStaleness,
    description: 'block.timestamp - oracle.lastUpdatedAt must be <= MAX_STALENESS',
  };
}

/**
 * INV-12 Accrue idempotence (structural port) — the on-chain harness calls
 * `accrue()` twice and asserts byte-identical state. A passive monitor cannot
 * transact, so it asserts the observable structural precondition instead:
 * `lastAccrualTime <= blockTimestamp`. Accrual always stamps
 * `lastAccrualTime = block.timestamp`, so it can never run ahead of the block;
 * an idle vault (lastAccrualTime behind the head) is perfectly healthy — the
 * earlier `=== blockTimestamp` port wrongly flagged every block without a
 * same-block transaction. Only a malformed snapshot or a clock/source bug can
 * put accrual in the future, which this fires on. The *strong* idempotence
 * guarantee is proven pre-deployment by the harness and
 * `test/mutant/MutantINV12.t.sol`, not by this passive read — see
 * docs/guardian-bot.md.
 */
export function inv12(state: VaultState): InvariantResult {
  const blockTs = BigInt(state.blockTimestamp);
  return {
    id: 'INV-12',
    name: 'Accrue idempotence (structural)',
    passed: state.lastAccrualTime <= blockTs,
    actualValue: state.lastAccrualTime,
    boundValue: blockTs,
    description: 'lastAccrualTime must never exceed block.timestamp (accrual cannot run in the future)',
  };
}

/**
 * Evaluate all twelve invariants against a current snapshot and (when
 * available) the prior observation. INV-07/09 short-circuit to PASS when
 * `prior` is null — the very first block after deploy or restart has no
 * delta to compute.
 * @returns The twelve results in INV-01..INV-12 order.
 */
export function evaluateInvariants(
  state: VaultState,
  prior: PriorVaultState = null,
): InvariantResult[] {
  return [
    inv01(state),
    inv02(state),
    inv03(state),
    inv04(state),
    inv05(state),
    inv06(state),
    inv07(state, prior),
    inv08(state),
    inv09(state, prior),
    inv10(state),
    inv11(state),
    inv12(state),
  ];
}
