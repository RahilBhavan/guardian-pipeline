# Guardian Assurance Engine

The assurance layer of the Guardian Pipeline. It takes the project's idea —
*bind every review finding to a check that re-runs on every commit* — and turns
it into measurable, CI-gated artifacts.

It implements three features:

1. **Finding → Invariant Traceability** — binds every security-review finding to
   the invariants, harness tests, runtime-monitor checks and exploit replays
   that keep it verified after the review's snapshot date.
2. **Quantified Assurance Score** — a composite 0–100 score (plus letter grade)
   over three pre-deployment assurance components.
3. **Historical Exploit Backtesting** — replays of known DeFi exploit classes
   against the Vault, each classified PREVENTED / DETECTED / MISSED.

## Research grounding

- **Bourveau, Brendel & Schoenfeld (2024)**, *DeFi assurance: early evidence*
  (Review of Accounting Studies 29(3)) — hand-codes ~8,500 audit reports;
  documents the DeFi audit market as pervasive and value-relevant.
- **Landsman, Lyandres, Maydew, Rabetti & Zhang (2025)**, *Auditing Smart
  Contracts* (SSRN) — across ~8,195 reports and 1,575 protocols, finds
  post-deployment outcomes depend on auditor characteristics, not just on
  whether an audit happened.

These establish that the audit ecosystem is real and that audit effectiveness
is an open empirical question. The "continuous, multi-layered" framing is
*this project's* interpretation of one design response — not a claim of either
paper. They motivate the work; they are not load-bearing for the tooling.

## Commands

```bash
npm install            # first time

npm run report         # gather all evidence, compute the score, write artifacts
npm run trace          # print the finding traceability matrix only
npm run check          # same as report, but exits non-zero if the CI gate fails
npm test               # unit tests for the score + traceability engines
npm run typecheck      # tsc --noEmit
```

Flags (pass after `--`, e.g. `npm run check -- --min-score 85`):

| Flag | Effect |
|---|---|
| `--min-score <n>` | CI gate threshold (default 80). |
| `--coverage <path>` | Read a pre-generated `forge coverage --report summary` file. |
| `--run-forge` | Run `forge coverage` directly if no coverage file is present. |
| `--md` | Also print the Markdown report. |

## How the score works

```
Assurance Score = 0.45 · Static Verification
                + 0.35 · Exploit Resistance
                + 0.20 · Finding Traceability
```

| Component | Measures | Source |
|---|---|---|
| **Static Verification** | `src/Vault.sol` line/branch coverage + fuzz-campaign intensity | `forge coverage`, `foundry.toml` |
| **Exploit Resistance** | Share of exploit classes resisted (PREVENTED or DETECTED) | `assurance/data/exploit-replays.json` |
| **Finding Traceability** | Weighted coverage of security-relevant review findings | `security-review/findings.json` |

The weights are a deliberate editorial choice, not an empirically derived
constant — see the rationale in the `score.ts` header. They are fixed in the
open so the score is reproducible and the bias is explicit.

This is a **pre-deployment** score: every component is evidence the repository
can produce on its own in CI. An earlier design added a fourth "Continuous
Monitoring" component scored from a live Guardian deployment; it was removed,
because the project ships the runtime monitor as a runnable reference
implementation, not a hosted service, so there is no live deployment to score.

A component whose data source genuinely cannot be reached (e.g. no coverage
file) is marked **unavailable** and dropped; the remaining weights are
re-normalised, so the score always reflects only evidence that was actually
gathered. MISSED exploits and uncovered findings cap their components and fail
the CI gate.

## Inputs and outputs

```
Inputs
  security-review/findings.json          security-review registry (Feature 1)
  assurance/data/exploit-replays.json     emitted by forge script (Feature 3)
  assurance/data/coverage-summary.txt     forge coverage summary (optional)
  foundry.toml                            CI fuzz profile

Outputs
  assurance/data/assurance-report.json    full machine-readable report
  assurance/data/assurance-report.md      Markdown report
  assurance/data/history.jsonl            appended score history
  dashboard/src/data/assurance-report.json   bundled for the dashboard panels
```

## Regenerating the exploit catalogue

The exploit-replay catalogue is produced by the Foundry layer:

```bash
forge test --match-path "test/exploit/*"   # CI gate — fails on a MISSED exploit
forge script script/ExploitReplay.s.sol    # writes assurance/data/exploit-replays.json
```

## Pipeline order

```
forge test test/exploit/*   →  forge script ExploitReplay  →  forge coverage  →  assurance check
   (gate: no MISSED)            (writes exploit JSON)          (coverage txt)     (gate: score ≥ min)
```

This sequence runs as the `assurance` job in `.github/workflows/invariant-ci.yml`.
