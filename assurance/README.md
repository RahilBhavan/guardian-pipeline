# Guardian Assurance Engine

The assurance layer of the Guardian Pipeline. It turns the project's thesis —
*continuous, multi-layered assurance closes the gap a static audit leaves* —
into measurable, gated artifacts.

It implements three features:

1. **Audit → Invariant Traceability** — binds every static audit finding to the
   invariants, harness tests, live monitors and exploit replays that keep it
   verified after the audit's snapshot date.
2. **Quantified Assurance Score** — a composite 0–100 score (plus letter grade)
   over four independent assurance layers.
3. **Historical Exploit Backtesting** — replays of known DeFi exploit classes
   against the Vault, each classified PREVENTED / DETECTED / MISSED.

## Research grounding

- **Bourveau et al. (2024)**, *DeFi assurance: early evidence* — value comes
  from continuous, multi-layered verification, not any single technique.
- **Landsman et al. (2025)**, *Auditing Smart Contracts* — static point-in-time
  audits show little empirical evidence of preventing runtime exploits.

The Assurance Score is the empirical, multi-layered metric the first paper
argues for; the exploit-replay catalogue is the runtime evidence the second
found missing from static audits.

## Commands

```bash
npm install            # first time

npm run report         # gather all evidence, compute the score, write artifacts
npm run trace          # print the audit-finding traceability matrix only
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
| `--no-supabase` | Skip the live-monitoring query (use in CI without credentials). |
| `--md` | Also print the Markdown report. |

## How the score works

```
Assurance Score = 0.30 · Static Verification
                + 0.25 · Exploit Resistance
                + 0.25 · Continuous Monitoring
                + 0.20 · Audit Traceability
```

| Component | Measures | Source |
|---|---|---|
| **Static Verification** | `src/Vault.sol` line/branch coverage + fuzz-campaign intensity | `forge coverage`, `foundry.toml` |
| **Exploit Resistance** | Share of exploit classes resisted (PREVENTED or DETECTED) | `assurance/data/exploit-replays.json` |
| **Continuous Monitoring** | Guardian liveness, detection latency, recency | Supabase `blocks_checked` |
| **Audit Traceability** | Weighted coverage of security-relevant audit findings | `audit/findings.json` |

A component whose data source cannot be reached is marked **unavailable** and
dropped; the remaining weights are re-normalised, so the score always reflects
only evidence that was actually gathered. MISSED exploits and uncovered findings
cap their components and fail the CI gate.

## Inputs and outputs

```
Inputs
  audit/findings.json                   static audit registry (Feature 1)
  assurance/data/exploit-replays.json    emitted by forge script (Feature 3)
  assurance/data/coverage-summary.txt    forge coverage summary (optional)
  foundry.toml                           CI fuzz profile
  guardian/.env                          Supabase credentials (optional)

Outputs
  assurance/data/assurance-report.json   full machine-readable report
  assurance/data/assurance-report.md     Markdown report
  assurance/data/history.jsonl           appended score history
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
