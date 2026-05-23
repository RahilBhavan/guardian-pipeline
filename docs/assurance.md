# The assurance layer

A point-in-time audit produces a static document that is stale the moment it is
signed. Guardian Pipeline produces a **self-computed Assurance Score** —
recomputed by the `assurance` CI job on every commit — that summarises how
well the contract is covered by the repository's own pre-deployment evidence.
"Self-computed" is load-bearing: see [What this score is **not**](#what-this-score-is-not)
before reading the headline number.

The framing is informed by two empirical papers on DeFi audit markets —
**Bourveau, Brendel & Schoenfeld (2024)**, which documents ~8,500 audit
reports as pervasive and value-relevant, and **Landsman et al. (2025)**, which
finds post-deployment outcomes depend on auditor characteristics rather than
on the mere presence of an audit. Neither paper itself argues for "continuous,
multi-layered verification" — that framing is this project's interpretation of
one design response to the open question both papers raise about audit
effectiveness. The score is a worked demonstration of that interpretation, not
a claim to have settled the question. See the [References section of the
README](../README.md#references).

---

## The Assurance Score

A composite 0–100 metric, the weighted average of three **pre-deployment**
components — every input is evidence the repository produces on its own in CI:

| Component | Weight | Measures | Source |
|-----------|--------|----------|--------|
| Static verification | 45% | Line/branch coverage + fuzz-campaign size on `Vault.sol` | `forge coverage`, `foundry.toml` |
| Exploit resistance | 35% | 7 historical exploit classes replayed | `test/exploit/` |
| Finding traceability | 20% | % of review findings bound to a re-runnable check | `security-review/findings.json` |

**On the weights.** They are a deliberate editorial choice, documented in the
`assurance/src/score.ts` header — *not* an empirically derived constant. Static
verification is the broadest evidence, so it carries the most weight. They are
fixed in the open so the score is reproducible and the bias is explicit.

**Scope.** An earlier design added a fourth "Continuous Monitoring" component
scored from a live Guardian deployment. It was removed: this project ships the
runtime monitor as a runnable reference implementation, not a hosted service, so
there is no live deployment to score. The Assurance Score is a pre-deployment
metric only.

**Grade:** A+ (97–100), A (93–96), A− (90–92), B+ (87–89), B (83–86),
B− (80–82), C+ (77–79), … — see `gradeFor` in `assurance/src/score.ts`.

**Current score: 91/100 → grade A−** (Static 82 · Exploit 100 · Traceability
93.8). Regenerate it with the commands [below](#running-it-locally); the live
figures are in `assurance/data/assurance-report.json`.

**CI gate:** the `assurance` job runs `npm run check -- --min-score 80` and
**fails the build** if the composite score drops below 80.

The full report is emitted as `assurance/data/assurance-report.json` and
`assurance-report.md`, and bundled into the dashboard build.

---

## What this score is **not**

Every input that goes into the score is produced by this repository. The same
author writes the invariants, picks the exploit set, tags the findings against
those invariants, picks the weights, and grades the output. The methodology is
documented in the open and the inputs are reproducible — that part is honest —
but the score is **not**:

- **An audit.** No independent party has reviewed this code. `security-review/`
  is written by the repository author. Commission a real audit before any real
  deployment.
- **External validation.** Nothing about an 80, 91, or 100 here means a
  separate, motivated reviewer has tried and failed to break the contract.
  Lifting the score is a code-and-process exercise inside this repo, not a
  result earned against an adversary.
- **A live-deployment outcome.** The score is computed entirely from CI
  artefacts. It does not — and *cannot* — speak to incident-free runtime,
  because there is no live deployment to score. An earlier draft included a
  fourth "Continuous Monitoring" component sourced from a hosted Guardian
  instance; it was removed because the hosted instance does not exist.
- **A measure of the runtime monitor's effectiveness.** The monitor ships as a
  runnable reference implementation. The score covers properties the monitor
  is *designed* to catch; it does not measure properties it *has* caught
  against real traffic.
- **An audit rebuttal.** "A−" is what the project's own rubric returns for the
  project's own code. Treat it as evidence the methodology is reproducible —
  not as evidence the code is safe.

The right way to read the headline figure is: *"this codebase grades itself A−
against the rubric the codebase ships."* Everything load-bearing about the
score is on either side of that sentence.

---

## Exploit replays

`test/exploit/` replays 7 *classes* of real-world DeFi exploit against the
vault. Each is classified by outcome:

- **PREVENTED** — the contract's own code blocked the attack; no state
  corruption.
- **DETECTED** — the attack corrupted state, but an invariant caught it in the
  same block.
- **MISSED** — value was extracted and *no* invariant noticed. A genuine gap.

| ID | Exploit class | Target invariants | Expected | Why |
|----|---------------|-------------------|----------|-----|
| EXP-01 | Privileged solvency break | INV-01 | DETECTED | `AttackableVault.attack()` inflates `totalSupplyAssets`; INV-01 catches it same-block |
| EXP-02 | First-depositor inflation | INV-01, INV-04 | PREVENTED | `totalSupplyAssets` is stored, not derived from balance — donations cannot inflate the share price |
| EXP-03 | Bad-debt collateral strip | INV-01, INV-06 | PREVENTED | `withdraw` re-checks the collateral cap on the post-withdrawal balance and reverts |
| EXP-04 | Reserve liquidity drain | INV-01 | PREVENTED | free liquidity provably covers any single LP balance; `withdraw` reverts gracefully otherwise |
| EXP-05 | Over-borrow beyond cap | INV-01 | PREVENTED | `borrow` reverts with `CollateralCapExceeded` past 80% LTV |
| EXP-06 | Interest-driven liquidation | INV-01, INV-06 | PREVENTED | interest pushes a position under water; `liquidate` clears it and all six invariants hold throughout |
| EXP-07 | Rounding-dust extraction | INV-01 | PREVENTED | Ceil-divided borrows and realised-drop repayments leave no recoverable dust |

**Current result: 6 PREVENTED · 1 DETECTED · 0 MISSED** → exploit-resistance
score 100/100. CI fails if any scenario regresses (an outcome worse than
expected) or is MISSED.

EXP-01 is intentionally the reference DETECTED scenario: it is a staged,
deliberately-planted breach (`AttackableVault.attack()`) used to show the
runtime monitor catching an insolvency the contract code itself permitted. It
demonstrates the *detection plumbing*; it is not a novel exploit.

---

## Finding traceability

`security-review/` holds a self-conducted, point-in-time security review and a
machine-readable `findings.json`. ("Self-conducted" means written by the
repository author — it is not an independent third-party audit.) The assurance
tooling resolves each finding against the assurance layers and assigns a
coverage tier. "Runtime monitor" below means the property is implemented as a
check in `guardian/src/evaluator.ts` — the deployable monitor — not that a
monitor is currently running:

- **fully-assured** — covered by ≥ 1 invariant **and** ≥ 1 harness test **and**
  a runtime-monitor check.
- **monitored-only** — covered by the runtime monitor but not provable by the
  harness.
- **harness-only** — fuzz-proven but not covered by the runtime monitor.
- **gap** — a security-relevant finding with no layer covering it.
- **not-applicable** — non-security finding (e.g. gas).

| ID | Finding | Severity | Tier |
|----|---------|----------|------|
| GUA-01 | Demo insolvency backdoor isolated to `AttackableVault` | Critical | fully-assured |
| GUA-02 | Reentrancy exposure on state-mutating functions | Medium | monitored-only |
| GUA-03 | Full-close repayment could erode the solvency margin by one wei | High | fully-assured |
| GUA-04 | Liquidation seizing all collateral must clear the full debt | Medium | fully-assured |
| GUA-05 | Sustained interest can make a redemption exceed idle cash | Low | fully-assured |
| GUA-06 | Share price is immune to direct token donations | Informational | fully-assured |
| GUA-07 | A full-close repayment may charge one wei above `userDebt()` | Informational | fully-assured |
| GUA-08 | Deeply under-water positions can leave residual bad debt | Low | fully-assured |

**Summary:** 8 findings, all 8 security-relevant — 7 fully-assured and 1
monitored-only (GUA-02: the `ReentrancyGuard` blocks the class structurally, but
the non-callback `MockERC20` means the harness cannot reproduce a reentrant
sequence, so it is covered by the runtime monitor rather than fuzz-proven).
**0 gaps** → weighted traceability coverage **93.8%** (7 × 1.0 + 1 × 0.5 over 8).

---

## Running it locally

```bash
# Replay the exploit scenarios
forge test --match-path "test/exploit/*" -vvv

# Regenerate the exploit catalogue + coverage inputs
forge script script/ExploitReplay.s.sol
forge coverage --report summary --no-match-coverage "(script|test)"

# Compute the Assurance Score
cd assurance && npm ci && npm run check -- --min-score 80
```

The output report feeds the dashboard's **Assurance Score**, **Traceability
Matrix**, and **Exploit Replay** panels.

---

## Related documents

- [architecture.md](architecture.md) — the assurance layer among the four layers.
- [invariants.md](invariants.md) — the six invariants violations roll up from.
- [invariants.md#testing-strategy](invariants.md#testing-strategy) — the four test tiers including exploit replay.
- [../README.md#cicd-pipeline](../README.md#cicd-pipeline) — the `assurance` CI job that gates on the score.
- [../assurance/README.md](../assurance/README.md) — the assurance engine's CLI.
