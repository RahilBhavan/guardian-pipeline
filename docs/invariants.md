# Invariant reference

The vault's safety is defined by 12 invariants. Each is asserted by an
`invariant_*` function in `test/invariant/InvariantVault.t.sol`, mirrored in
`guardian/src/evaluator.ts` (`inv01`…`inv12`), and re-checked by the
exploit-replay harness (`test/exploit/`).

**Notation:** `WAD = 1e18` (fixed-point unit); `BPS = 100_00` (basis-point
denominator); `collateralRatio = 80_00` (80%); `liquidationBonus = 5_00` (5%).
`cash` is the vault's own ERC-20 balance; `totalBorrowed = totalBorrowShares ×
borrowIndex / WAD`; `userDebt(u) = userBorrowShares[u] × borrowIndex / WAD`.

**Not every invariant is equally hard to satisfy** — and this document does not
pretend they are. Each invariant below carries a **class**:

- **Fuzz-tensioned** (INV-01, INV-06, INV-07..INV-12) — properties the fuzz
  campaign genuinely attacks: a wrong rounding direction, call ordering, or
  missing guard breaks them. INV-01 already caught a real bug (GUA-02).
  INV-07..INV-12 are each paired with a `test/mutant/MutantINV*.t.sol`
  mutation test that breaks the Vault on purpose and asserts the matching
  `invariant_*` catches it.
- **Accounting identity** (INV-02, INV-03) — a share-sum equality that holds
  unless a code path desyncs the two sides of the ledger. The fuzzer's role is
  regression detection.
- **Structural** (INV-04, INV-05) — true by the construction of the contract.
  INV-04 has a non-trivial proof the campaign confirms empirically; INV-05 is a
  one-line tautology kept as a cheap regression check. The fuzzer cannot break
  a structural invariant without a source change.

---

## Testing strategy

Six complementary test tiers ship evidence for these invariants. The CI gate
on each is set so the green badge is a precise, falsifiable claim.

| Tier | Directory | Question it answers | CI gate |
|------|-----------|---------------------|---------|
| Unit | `test/unit/` | Does every individual path behave exactly as specified? | via `coverage` (≥ 85% lines on `Vault.sol`) |
| Parameterized fuzz | `test/fuzz/` | Do the invariants hold under *any* APR / liquidation-bonus parameter pair? | runs with `forge test` |
| Invariant fuzz (Foundry) | `test/invariant/` | Do the twelve properties survive *any* call sequence? | `invariant-fuzz` (zero `[FAIL]`) |
| Invariant fuzz (Echidna) | `test/echidna/` | Does an independent fuzz engine reach the same conclusion as Foundry? | `make echidna` (skipped locally if binary missing) |
| Differential | `test/differential/` | Does Solidity's share/debt math agree with a TS reference on every input? | runs with `forge test` (FFI to `assurance/bin/refmath-cli.mjs`) |
| Exploit replay | `test/exploit/` | Does the vault resist known DeFi exploit classes? | `assurance` (no regression, no `MISSED`) |

The invariant suite drives eight handlers (Deposit, Collateral, Borrow, Warp,
Liquidate, Donation, Oracle, Reentrancy) so a campaign explores meaningful state
transitions — including the ERC-4626 share-inflation vector via direct donations,
oracle-price moves, and re-entrant call sequences — instead of burning runs on
amounts that trivially revert. The donation handler exists specifically to prove
the donation/inflation attack class is exercised, not just asserted.

Counterexamples shrink to a minimal failing call sequence under
`[FAIL] invariant_<name>()`. For how the tiers run as CI jobs, see
[the CI/CD section in the root README](../README.md#cicd-pipeline).

### Formal verification — a known gap

This repo does **not** ship a Certora or Halmos symbolic proof of the twelve
invariants. The campaign is empirical: a 2,000-run invariant fuzz on CI plus
256-run parameterized fuzz over the constructor space. A symbolic proof would
close the residual *is there any sequence we missed* question — fuzzing can
only show none of the runs it tried broke the property. The invariants are
deliberately shaped to be Certora/Halmos-compatible (each is an `assertGe` /
`assertEq` over public state with no external side effects), and
`lib/openzeppelin-contracts/lib/halmos-cheatcodes` is already in the
dependency tree. A future iteration can prove INV-01, INV-04, and INV-06
symbolically without a contract rewrite; until then this section documents
the gap honestly.

---

## INV-01 · Protocol solvency · *Critical*

```
cash + totalBorrowed ≥ totalSupplyAssets
```

The assets the vault holds — idle cash plus debt owed to it — must always cover
the claims of its lenders. This is the master safety property.

- **Breaks when:** accrual credits lenders more than borrowers are charged, a
  repayment collects less than debt actually falls, or shares are minted with
  no backing assets. The fuzz harness found exactly the first class during
  development — a one-wei full-repay leak, now fixed (review finding GUA-02).
- **Caught by:** `invariant_solvency()` · `inv01()` · replay EXP-01.

## INV-02 · Supply-share integrity · *Critical*

```
totalSupplyShares = Σ userSupplyShares[i]
```

The stored total of lender shares must equal the sum of every account's
balance — no share is minted or burned without updating both.

- **Breaks when:** a deposit, withdrawal or liquidation updates one side of the
  share accounting but not the other.
- **Caught by:** `invariant_supplyShareIntegrity()` · `inv02()`.

## INV-03 · Debt-share integrity · *High*

```
totalBorrowShares = Σ userBorrowShares[i]
```

The stored total of borrow shares must equal the sum of every borrower's
balance — the debt-side twin of INV-02.

- **Breaks when:** a borrow, repayment or liquidation mis-accounts borrow
  shares.
- **Caught by:** `invariant_debtShareIntegrity()` · `inv03()`.

## INV-04 · Lender-value floor · *High* · *Structural*

```
totalSupplyAssets ≥ totalSupplyShares
```

The lender share price (`totalSupplyAssets × WAD / totalSupplyShares`) must
never fall below the 1:1 peg — lenders cannot lose nominal principal.

- **Class — structural.** It holds because every share/asset conversion floors
  in the protocol's favour: the first deposit mints shares 1:1, later deposits
  mint `≤ amount`, interest only raises assets, and withdrawal/liquidation
  remove assets and shares in a ratio that preserves the floor. It cannot be
  broken without changing a rounding direction in `deposit`, `withdraw` or
  `liquidate`. The campaign confirms the proof empirically — including with
  `DonationHandler` transferring tokens straight to the vault.
- **Caught by:** `invariant_lenderValueFloor()` · `inv04()` · replay EXP-02.

## INV-05 · Interest-index floor · *Medium* · *Structural*

```
borrowIndex ≥ 1e18
```

The debt-scaling index only ever accrues forward; it can never drop below its
`1e18` starting value. Interest is monotone.

- **Class — structural (true by construction).** `borrowIndex` is initialised
  to `1e18` and `accrue` only ever adds to it. It cannot fall without a source
  change to the accrual maths; the harness keeps it as a cheap regression check.
- **Caught by:** `invariant_interestIndexFloor()` · `inv05()`.

## INV-06 · No uncollateralised debt · *High*

```
∀u: userSupplyShares[u] == 0  ⇒  userDebt(u) == 0
```

An account with zero collateral shares can never carry outstanding debt — the
protocol never accumulates structurally unrecoverable bad debt.

- **Breaks when:** a withdrawal removes all of a borrower's collateral while
  debt is open, or a liquidation seizes every share without clearing the debt.
  Both paths are guarded — `withdraw` re-checks the collateral cap and
  `liquidate` requires a full close before seizing all collateral.
- **Caught by:** `invariant_noUncollateralisedDebt()` · `inv06()` · replays
  EXP-03, EXP-06.

## INV-07 · Per-observation solvency monotonicity · *High*

```
(cash + totalBorrowed − totalSupplyAssets)_t ≥ (cash + totalBorrowed − totalSupplyAssets)_{t−1}
```

The solvency margin — idle cash plus outstanding debt minus total lender claims
— must never shrink between consecutive observations. A mutation that lets
repayments or accrual silently widen the gap in the wrong direction is detected
on the next block.

- **Breaks when:** a code path causes `cash + totalBorrowed − totalSupplyAssets`
  to fall between two consecutive observations; for example, if accrual credits
  lenders more than the matching borrow-index rise covers.
- **Class — Fuzz-tensioned, load-bearing.** `test/mutant/MutantINV07.t.sol`
  breaks the Vault on purpose and asserts `invariant_solvencyMonotone` catches it.
- **Caught by:** `invariant_solvencyMonotone()` · `inv07()` (delta check;
  short-circuits to PASS on the first observation after deploy or restart).

## INV-08 · No-free-lunch on liquidation · *High*

```
seized · price · BPS ≤ paid · (BPS + bonus) · WAD
```

Every liquidation must satisfy the fee-bounded inequality: the value extracted
by the liquidator (seized collateral at oracle price) cannot exceed the debt
repaid plus the permitted bonus.

- **Breaks when:** the seize coefficient is inflated, the bonus cap is removed,
  or the oracle price used at settlement has been manipulated — letting the
  liquidator extract more value than the bonus allows.
- **Class — Fuzz-tensioned, load-bearing.** `test/mutant/MutantINV08.t.sol`
  breaks the Vault on purpose; checked via event reconciliation (each `Liquidated`
  log is re-evaluated against the on-block oracle price and the vault's immutable
  bonus).
- **Caught by:** `invariant_liquidationNoFreeLunch()` · `inv08()` · replays
  EXP-05, EXP-07.

## INV-09 · Per-position debt monotonicity under accrual · *Medium*

```
userBorrowShares[a]_t = userBorrowShares[a]_{t−1}  ⇒  userDebt(a)_t ≥ userDebt(a)_{t−1}
```

If a borrower's share count is unchanged between observations, their computed
debt in asset terms must not have fallen — interest only accrues forward.

- **Breaks when:** `borrowIndex` falls (contradicting INV-05) or the share-to-
  debt conversion rounds in the borrower's favour on consecutive observations.
- **Class — Fuzz-tensioned, load-bearing.** `test/mutant/MutantINV09.t.sol`
  breaks the Vault on purpose; checked as a delta against the prior observation
  (short-circuits to PASS on the first observation).
- **Caught by:** `invariant_debtMonotoneUnderAccrual()` · `inv09()`.

## INV-10 · Debt rounding favours the protocol · *Medium*

```
Σ userDebt[a] ≤ totalBorrowed
```

The sum of every borrower's floored per-account debt must not exceed the
protocol's own floored aggregate. Sum-of-floors ≤ floor-of-sum is an arithmetic
identity; the invariant tensions on the rounding direction of the per-actor view.

- **Breaks when:** the per-account debt computation rounds up (towards the
  borrower) rather than down, causing the sum to exceed `totalBorrowed`.
- **Class — Fuzz-tensioned, load-bearing.** `test/mutant/MutantINV10.t.sol`
  breaks the Vault on purpose.
- **Caught by:** `invariant_debtRoundingFavoursProtocol()` · `inv10()` · replay
  EXP-08.

## INV-11 · Oracle freshness gate · *High*

```
block.timestamp − oracle.lastUpdatedAt ≤ MAX_STALENESS  (MAX_STALENESS = 1 day)
```

The vault must never act on a price that is more than `MAX_STALENESS` seconds
old. The on-chain `_freshPrice` guard enforces this on every price-dependent
path; the monitor mirrors the same check per block.

- **Breaks when:** the staleness guard is removed or its constant is raised,
  letting the vault execute borrows or liquidations against a price that no
  longer reflects market conditions.
- **Class — Fuzz-tensioned, load-bearing.** `test/mutant/MutantINV11.t.sol`
  breaks the Vault on purpose.
- **Caught by:** `invariant_oracleFreshnessGate()` · `inv11()` · replays
  EXP-03, EXP-09.

## INV-12 · Accrue idempotence · *Medium*

```
accrue(); accrue();  ⟹  (borrowIndex, totalSupplyAssets, totalBorrowShares, lastAccrualTime) unchanged
```

A second call to `accrue()` within the same block must leave all accrual-related
state byte-identical to after the first call. The on-chain guard `if (dt == 0)
return;` achieves this; the monitor's structural port confirms `lastAccrualTime
== block.timestamp` so the guard would fire on any re-entrant call.

- **Breaks when:** the `dt == 0` early-return is removed or `lastAccrualTime`
  is not updated, allowing a second `accrue()` to compound interest a second
  time in the same block.
- **Class — Fuzz-tensioned, load-bearing.** `test/mutant/MutantINV12.t.sol`
  breaks the Vault on purpose; the off-chain port is a snapshot check
  (`lastAccrualTime == blockTimestamp`).
- **Caught by:** `invariant_accrueIdempotent()` · `inv12()`.

---

## Where each invariant is enforced

| ID | Foundry harness | Guardian bot | Exploit replay |
|----|-----------------|--------------|----------------|
| INV-01 | `invariant_solvency` | `inv01` (snapshot) | EXP-01 |
| INV-02 | `invariant_supplyShareIntegrity` | `inv02` (snapshot) | — |
| INV-03 | `invariant_debtShareIntegrity` | `inv03` (snapshot) | — |
| INV-04 | `invariant_lenderValueFloor` | `inv04` (snapshot) | EXP-02 |
| INV-05 | `invariant_interestIndexFloor` | `inv05` (snapshot) | — |
| INV-06 | `invariant_noUncollateralisedDebt` | `inv06` (snapshot) | EXP-03, EXP-06 |
| INV-07 | `invariant_solvencyMonotone` | `inv07` (delta) | — |
| INV-08 | `invariant_liquidationNoFreeLunch` | `inv08` (event reconciliation) | EXP-05, EXP-07 |
| INV-09 | `invariant_debtMonotoneUnderAccrual` | `inv09` (delta) | — |
| INV-10 | `invariant_debtRoundingFavoursProtocol` | `inv10` (snapshot) | EXP-08 |
| INV-11 | `invariant_oracleFreshnessGate` | `inv11` (snapshot) | EXP-03, EXP-09 |
| INV-12 | `invariant_accrueIdempotent` | `inv12` (snapshot) | — |

Every off-chain check is **exact**, not a proxy. INV-02, INV-03, INV-06, INV-09
and INV-10 need per-account state: the bot discovers every account from the
vault's `Deposited`, `Borrowed` and `Liquidated` events and reads each one's
on-chain position, so the off-chain sum is over the same user set the harness
iterates. INV-07 and INV-09 are delta checks that require the prior observation
persisted in Supabase; they short-circuit to PASS on the very first block after
deploy or restart. INV-08 is an event-reconciliation check that re-evaluates
each `Liquidated` log against the on-block oracle price. The property proven
pre-deployment is byte-for-byte the property monitored after it.

For how violations roll up into the Assurance Score, see
[assurance.md](assurance.md).

---

## Related documents

- [contracts.md](contracts.md) — the in-contract guards that protect each invariant.
- [guardian-bot.md](guardian-bot.md#evaluatorts) — how the bot evaluates them off-chain.
- [assurance.md](assurance.md) — how violations roll up into the Assurance Score.
