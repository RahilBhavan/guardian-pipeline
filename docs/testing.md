# Testing strategy

Guardian Pipeline's contract layer is verified by **four complementary test
tiers**, each answering a different question. Together they are the evidence
behind the green CI badge and the `static-verification` slice of the
[Assurance Score](assurance.md).

| Tier | Directory | Question it answers | CI gate |
|------|-----------|---------------------|---------|
| Unit | `test/unit/` | Does every individual path behave exactly as specified? | via `coverage` (≥ 85% lines) |
| Parameterized fuzz | `test/fuzz/` | Do the invariants hold under *any* APR / liquidation-bonus parameter pair the constructor accepts? | runs with the standard `forge test` job |
| Invariant fuzz | `test/invariant/` | Do the six properties survive *any* call sequence? | `invariant-fuzz` (zero `[FAIL]`) |
| Exploit replay | `test/exploit/` | Does the vault resist known DeFi exploit *classes*? | `assurance` (no regression, no `MISSED`) |

`forge test` runs all four — **52 tests across 4 suites** (24 unit + 7
`_burnDebt` boundary tests + 7 parameterized fuzz + 6 invariant +
8 exploit-replay).

---

## Tier 1 — Unit tests

`test/unit/VaultUnit.t.sol` — deterministic, example-based coverage.

The invariant harness exercises the six properties; the unit suite pins
down *behaviour*: every happy path, every revert path, every event, interest
accrual, and liquidation. Together with the other tiers it drives `src/Vault.sol`
to ~97% line coverage — the `coverage` CI job gates at ≥ 85%, comfortably
clear, which is why the coverage job caps invariant fuzzing (it only needs the
percentage, not a full campaign).

Run it:

```bash
forge test --match-contract VaultUnit -vvv
forge coverage --report summary          # see per-file coverage
```

---

## Tier 2 — Parameterized fuzz

`test/fuzz/VaultParameterized.t.sol` — Foundry's standard fuzzer over the
*constructor parameters*.

The invariant harness only ever deploys a Vault at the canonical 10% APR
and 5% liquidation bonus. The parameterized fuzz tests close that gap: each
run deploys a *fresh* Vault with a random APR (1..10000 bps) and/or a random
liquidation bonus (100..5000 bps), drives a deterministic adversarial
sequence through it — deposit, max-borrow, warp, accrue, attempted
withdraw, attempted liquidation — and re-asserts the four invariants that
can be checked statelessly: INV-01, INV-04, INV-05, and a spot-check of
INV-06.

Three fuzz tests bound the coverage:

- `testFuzz_aprOnly`     — vary APR, hold bonus at 5%.
- `testFuzz_bonusOnly`   — vary bonus, hold APR at 10%.
- `testFuzz_aprAndBonus` — vary both, the strongest property statement.

Four further unit tests pin the constructor's revert path:
`InvalidLiquidationBonus` on zero and on values above 50%, plus
accept-paths at the bounds (1 bp and 5000 bps).

`test/unit/VaultBurnDebt.t.sol` is a sibling suite that pins down the
rounding boundaries of the private `_burnDebt` helper — full-close
charges the exact realised drop in `totalBorrowed`, partial repay below
one share's worth burns zero shares but still grows cash, etc. The
invariant harness eventually catches `_burnDebt` errors as INV-01
failures several calls downstream, but the focused suite localises the
failure to the rounding choice itself.

```bash
forge test --match-path "test/fuzz/*"      -vvv
forge test --match-contract VaultBurnDebt  -vvv
```

---

## Tier 3 — Invariant fuzzing

`test/invariant/InvariantVault.t.sol` — the core of the pre-deployment layer.

### How it works

Foundry's invariant fuzzer builds **random call sequences** and asserts all
six `invariant_*` functions after every call. Instead of fuzzing the vault
directly, it drives five **handler contracts** — a standard Foundry pattern
that keeps the fuzzer inside a realistic, meaningful action space.

```
setUp(): deploy Vault + MockERC20, register 5 handlers as targets,
         exclude Vault + token from direct fuzzing
   │
   ▼
fuzzer ─▶ random sequence of handler calls ─▶ assert invariant_01..06 ─▶ repeat
```

### The handlers

| Handler | Fuzz entrypoints | What it bounds |
|---------|------------------|----------------|
| `DepositHandler` | `deposit`, `withdraw` | 5 actors, each funded `500_000e18` and pre-approved; deposit amount bounded to `1…100_000e18`. |
| `BorrowHandler` | `borrow`, `repay` | Same 5 actors (deterministic `makeAddr` labels → identical addresses across handlers); borrow bounded to `1…50_000e18`. |
| `WarpHandler` | `warp` | Advances `block.timestamp` by `1…30 days`, then calls `vault.accrue()` so interest is realised — every warp moves the borrow index and lender claims. |
| `LiquidateHandler` | `liquidate` | A pseudo-random actor liquidates another's position, repaying a bounded `1…debt`; redistributes collateral so INV-06 is exercised. |
| `DonationHandler` | `donate` | Transfers `1…50_000e18` of the asset straight to the vault from a non-actor donor — the ERC-4626 share-inflation vector. Proves a donation cannot move the share price or erode solvency (review finding GUA-06). |

Two design choices make the campaign effective:

- **Bounded inputs.** Handlers use `bound(...)` so the fuzzer spends its budget
  exploring *meaningful* state transitions rather than burning runs on amounts
  that trivially revert.
- **`try/catch` around vault calls.** A legitimately-reverting call (e.g. an
  over-borrow) must not abort the sequence — it is a valid no-op, and the next
  random call should still execute. `foundry.toml` sets
  `fail_on_revert = false` for the same reason.
- **Shared actors.** `DepositHandler` and `BorrowHandler` resolve the *same*
  five addresses, so a borrow can act on shares an earlier deposit minted —
  the sequences interleave into realistic histories.

`DepositHandler` also exposes `sumSupplyShares()`, `sumBorrowShares()` and
`getActors()` so `invariant_supplyShareIntegrity` (INV-02),
`invariant_debtShareIntegrity` (INV-03) and `invariant_noUncollateralisedDebt`
(INV-06) can do a **true per-user** check across every actor — the same per-user
checks the runtime monitor mirrors against its event-discovered user set.

### Fuzz profiles

Set with `FOUNDRY_PROFILE` (see `foundry.toml`):

| Profile | Runs | Depth | Calls (approx) | Use |
|---------|------|-------|----------------|-----|
| `default` | 500 | 100 | ~50,000 | Local iteration. |
| `ci` | 2,000 | 150 | up to ~300k | Every push (`invariant-fuzz` job). |
| `deep` | 10,000 | 200 | ~2,000,000 | Before a release. |

```bash
forge test --match-contract InvariantVault -vvv                       # default
FOUNDRY_PROFILE=ci   forge test --match-contract InvariantVault -vvv   # CI profile
FOUNDRY_PROFILE=deep forge test --match-contract InvariantVault -vvv   # pre-release
```

### Reading a counterexample

When an invariant fails, Forge **shrinks** the failing sequence to a minimal
reproduction and prints it under `[FAIL] invariant_<name>()`. To see this for
yourself — and to capture `docs/counterexample.png` — temporarily break an
invariant, as described in [docs/README.md](README.md#capturing-counterexamplepng).
A green badge is therefore a precise claim: *all six invariants survived the
profile's campaign with zero failures.*

---

## Tier 4 — Exploit replays

`test/exploit/` — replays seven *classes* of real-world DeFi exploit against a
freshly-deployed vault.

| File | Role |
|------|------|
| `ExploitScenarios.sol` | The seven scenarios. Each builds a vault, runs the attack, and classifies the outcome into a `ScenarioResult` struct. |
| `InvariantChecks.sol` | Shared on-chain invariant evaluator the scenarios use to decide whether an attack was caught. |
| `ExploitReplay.t.sol` | The CI gate — one test per scenario, plus a guard test for the reference DETECTED scenario. |

### Outcome classification

Every replay ends in one of three outcomes:

| Outcome | Meaning |
|---------|---------|
| **PREVENTED** | The contract's own code blocked the attack — no state corruption. |
| **DETECTED** | The attack corrupted state, but an invariant caught it the same block. |
| **MISSED** | Value was extracted and *no* invariant noticed — a genuine gap. |

This maps directly onto the project's thesis: static review proves
**PREVENTED**; continuous invariant monitoring catches **DETECTED**;
**MISSED** is the residual risk a point-in-time review leaves behind.

### What the gate enforces

`ExploitReplay.t.sol` fails the build if a scenario:

- **regressed** — its outcome no longer matches its declared `expectedOutcome`; or
- **was MISSED** — state corrupted or value extracted with no invariant catching it.

One extra test, `test_detectedScenarioIsCaughtByAnInvariant`, pins EXP-01 as
the reference **DETECTED** case: if it ever becomes PREVENTED the demo breaks,
and if it becomes MISSED the invariant set has a hole.

The full scenario catalogue (EXP-01…EXP-07, target invariants, expected
outcomes, current result of **6 PREVENTED · 1 DETECTED · 0 MISSED**) is in
[assurance.md](assurance.md#exploit-replays).

```bash
forge test --match-path "test/exploit/*" -vvv   # run the replays
forge script script/ExploitReplay.s.sol         # regenerate the JSON catalogue
```

`ExploitScenarios` inherits forge-std's `CommonBase` (not `Test`), so it can be
shared by both the test harness *and* `ExploitReplay.s.sol` — the script that
emits `assurance/data/exploit-replays.json` for the Assurance Score and the
dashboard.

---

## Formal verification — a known gap

This repo does **not** ship a Certora or Halmos symbolic proof of the six
invariants. The campaign is empirical: 2,000-run invariant fuzz on CI
plus 256-run parameterized fuzz over the constructor space. A symbolic
proof would close the residual "is there *any* sequence we missed"
question — fuzzing can only show none of the runs it tried broke the
property.

The invariants are deliberately shaped to be Certora/Halmos-compatible:
each one is an `assertGe` / `assertEq` over public state with no
external side effects, and `lib/openzeppelin-contracts/lib/halmos-cheatcodes`
is already present in the dependency tree. A future iteration could
prove INV-01, INV-04, and INV-06 symbolically without a contract
rewrite; until then this section documents the gap honestly rather than
silently leaving it.

---

## Assurance-engine tests

The Node assurance engine has its own unit suite —
`assurance/test/*.test.ts`, run with `npm test` (node:test, 22 tests) — that
covers the scoring and traceability logic. See
[assurance/README.md](../assurance/README.md).

---

## Running everything

```bash
# The whole contract suite — 52 tests
forge test -vvv

# What CI runs, in order
FOUNDRY_PROFILE=ci forge test --match-contract InvariantVault -vvv
forge test --match-path "test/exploit/*" -vvv
forge coverage --report summary
cd assurance && npm ci && npm test && npm run check -- --min-score 80
```

See [ci.md](ci.md) for how these map onto the six CI jobs, and
[CONTRIBUTING.md](../CONTRIBUTING.md) for the pre-push checklist.

---

## Related documents

- [invariants.md](invariants.md) — the six invariants under test.
- [ci.md](ci.md) — how the tiers run as CI jobs.
- [assurance.md](assurance.md) — exploit catalogue and the Assurance Score.
- [contracts.md](contracts.md) — the contract these tests exercise.
</content>
