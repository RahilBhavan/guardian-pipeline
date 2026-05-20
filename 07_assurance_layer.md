# Phase 7 — Assurance Layer

> Builds the assurance layer: audit-finding traceability, the Assurance Score,
> and historical exploit-class backtesting. Produces `audit/`, the `assurance/`
> TypeScript package, `test/exploit/` + `script/ExploitReplay.s.sol`, three new
> dashboard panels, and the `assurance` CI job.

---

## Why this phase exists

Phases 1–6 build a working two-layer pipeline (CI fuzz harness + live Guardian
bot). This phase makes the project *demonstrate* — and *measure* — the thesis
its two cited papers point at, rather than merely embodying it.

| Paper | Claim | What this phase adds |
|---|---|---|
| Bourveau et al. (2024) | Assurance value comes from continuous, multi-layered verification. | A composite **Assurance Score** that quantifies four independent layers. |
| Landsman et al. (2025) | Static point-in-time audits show little evidence of preventing runtime exploits. | **Exploit replays** (runtime evidence) and a **traceability map** turning a static audit into continuous checks. |

---

## Feature 1 — Audit → Invariant Traceability

A static audit is a snapshot. This feature binds every finding to the assurance
layers that keep it verified afterwards.

- `audit/Vault-Security-Review.md` — an illustrative point-in-time audit report
  in the format of a real security review (8 findings, Critical → Gas).
- `audit/findings.json` — the machine-readable registry. Each finding carries a
  `continuousAssurance` block: `{ invariants, harnessTests, liveMonitors,
  exploitReplays, rationale }`.
- `assurance/src/traceability.ts` — resolves every finding into a coverage tier:

  | Tier | Condition |
  |---|---|
  | `fully-assured` | proven by the harness **and** watched live (weight 1.0) |
  | `monitored-only` / `harness-only` | one continuous layer only (weight 0.5) |
  | `gap` | security-relevant, no continuous coverage (weight 0) |
  | `not-applicable` | not a security property, e.g. a gas finding (excluded) |

  It also flags **dangling references** — a finding pointing at an invariant,
  test or replay that does not exist.

**Coverage** = weighted sum over security-relevant findings ÷ their count.

## Feature 2 — Quantified Assurance Score

A composite 0–100 score + letter grade, in `assurance/src/score.ts` (pure,
unit-tested functions):

```
Assurance Score = 0.30 · Static Verification    (coverage + fuzz intensity)
                + 0.25 · Exploit Resistance     (exploit-replay catch rate)
                + 0.25 · Continuous Monitoring  (live uptime + latency)
                + 0.20 · Audit Traceability     (Feature 1 coverage)
```

- Each component reports `available`. Unavailable components are dropped and the
  weights re-normalised — the score reflects only evidence actually gathered.
- A MISSED exploit caps Exploit Resistance at 50; a coverage gap caps Audit
  Traceability at 60.
- Grades: A+ (≥97) … F (<60).

## Feature 3 — Historical Exploit Backtesting

Foundry replays of seven known DeFi exploit *classes* against the Vault, each
classified by the **three-outcome model**:

| Outcome | Meaning |
|---|---|
| `PREVENTED` | The contract's own code blocked the attack — no state corruption. |
| `DETECTED` | The attack corrupted state, but an invariant caught it same-block. |
| `MISSED` | The attack extracted value and **no** invariant noticed — a real gap. |

Classification uses two independent oracles per scenario: the eight invariants
(→ DETECTED) and a per-scenario harm oracle (→ MISSED). `MISSED` fails the build.

- `test/exploit/InvariantChecks.sol` — non-reverting evaluation of all 8 invariants.
- `test/exploit/ExploitScenarios.sol` — the 7 scenarios (EXP-01..07).
- `test/exploit/ExploitReplay.t.sol` — the CI gate; asserts no regression, no MISSED.
- `script/ExploitReplay.s.sol` — emits `assurance/data/exploit-replays.json`.

Current catalogue: EXP-01 DETECTED (the privileged `attack()` backdoor),
EXP-02..07 PREVENTED, 0 MISSED.

---

## File map

```
audit/
  Vault-Security-Review.md       illustrative point-in-time audit report
  findings.json                  machine-readable finding registry (Feature 1)
test/exploit/
  InvariantChecks.sol            non-reverting 8-invariant evaluation
  ExploitScenarios.sol           7 exploit-class scenarios
  ExploitReplay.t.sol            CI gate — regression + MISSED guard
script/
  ExploitReplay.s.sol            emits the exploit-replay catalogue JSON
assurance/
  package.json  tsconfig.json  README.md
  src/
    invariants.ts                canonical INV-01..08 catalogue
    findings.ts                  load + type the audit registry
    exploits.ts                  load + summarise the exploit catalogue
    traceability.ts              Feature 1 resolver
    score.ts                     Feature 2 score engine (pure)
    sources.ts                   gather coverage / fuzz / Supabase inputs
    report.ts                    assemble + render the report
    cli.ts                       the `assurance` command
  test/
    score.test.ts  traceability.test.ts    node:test unit tests
  data/
    exploit-replays.json         (generated) Feature 3 output
    assurance-report.json/.md    (generated) full report
    history.jsonl                (generated) score history
dashboard/src/
  data/assurance-report.json     bundled report for the panels
  assurance.ts                   typed view of the report
  components/
    AssuranceScore.tsx           Feature 2 panel
    TraceabilityMatrix.tsx       Feature 1 panel
    ExploitReplay.tsx            Feature 3 panel
```

## CI

A new `assurance` job in `.github/workflows/invariant-ci.yml`:

```
forge test test/exploit/*   →  forge script ExploitReplay  →  forge coverage  →  assurance check
  gate: no MISSED/regression    writes exploit-replays.json    coverage summary   gate: score ≥ 80
```

## Acceptance criteria

- `forge test --match-path "test/exploit/*"` — all scenarios pass, 0 MISSED.
- `cd assurance && npm test` — score + traceability unit tests pass.
- `npm run typecheck` clean in both `assurance/` and `dashboard/`.
- `assurance check --min-score 80` exits 0 and writes the report artifacts.
- `dashboard` builds with the three new panels rendering the bundled report.

## Constraints

- Solidity `^0.8.24`; Foundry-only contract layer; `viem`/strict-TS elsewhere.
- The assurance engine never mocks: it reads real `forge coverage`, the real
  exploit-replay output, and the real `audit/findings.json`.
- No database migration and no deployment are required — assurance data flows
  through JSON artifacts. Live monitoring degrades gracefully when Supabase
  credentials are absent.
