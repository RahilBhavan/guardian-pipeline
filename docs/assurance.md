# The assurance layer

A point-in-time audit produces a PDF that is stale the moment it is signed.
Guardian Pipeline produces a **living Assurance Score** — recomputed by the
`assurance` CI job on every commit — that quantifies how well the protocol is
actually covered, right now.

This is the project's direct answer to **Landsman et al. (2025)**: static
audits show little evidence of preventing runtime exploits, so assurance must
be continuous, multi-layered, and measurable.

---

## The Assurance Score

A composite 0–100 metric, the weighted average of four independent layers:

| Component | Weight | Measures | Source |
|-----------|--------|----------|--------|
| Static verification | 30% | Line/branch coverage + fuzz intensity on `Vault.sol` | `forge coverage` |
| Exploit resistance | 25% | 7 historical exploit classes replayed | `test/exploit/` |
| Continuous monitoring | 25% | Live uptime, liveness, detection latency | Supabase history |
| Audit traceability | 20% | % of findings provably covered | `audit/findings.json` |

**Degradation:** the continuous-monitoring component needs live Supabase
history. In CI there is none, so that component is marked unavailable and the
score is re-normalised over the three available layers (`--no-supabase`).

**Grade:** A+ (97–100), A (93–96), A− (90–92), B+ (87–89), B (83–86),
B− (80–82), C+ (77–79), … — see `gradeFor` in `assurance/src/score.ts`.

**Current score: 92/100 → grade A−.**

**CI gate:** the `assurance` job runs `npm run check -- --min-score 80` and
**fails the build** if the composite score drops below 80.

The full report is emitted as `assurance/data/assurance-report.json` and
`assurance-report.md`, and rendered live on the dashboard.

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

EXP-01 is intentionally the reference DETECTED scenario: it proves the runtime
layer catches what the code itself permits — exactly the
audit-misses-runtime-exploit gap the research describes.

---

## Audit traceability

`audit/` holds an illustrative point-in-time audit report and a
machine-readable `findings.json`. The assurance tooling resolves each finding
against the continuous-assurance layers and assigns a coverage tier:

- **fully-assured** — covered by ≥ 1 invariant **and** ≥ 1 harness test **and**
  ≥ 1 live monitor.
- **monitored-only** — covered live but not provable by the harness.
- **harness-only** — fuzzed but not monitored live.
- **gap** — a security-relevant finding with no continuous coverage.
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
sequence, so it is monitored live rather than fuzz-proven). **0 gaps** →
weighted traceability coverage **93.8%** (7 × 1.0 + 1 × 0.5 over 8).

---

## Running it locally

```bash
# Replay the exploit scenarios
forge test --match-path "test/exploit/*" -vvv

# Regenerate the exploit catalogue + coverage inputs
forge script script/ExploitReplay.s.sol
forge coverage --report summary --no-match-coverage "(script|test)"

# Compute the Assurance Score
cd assurance && npm ci && npm run check -- --min-score 80 --no-supabase
```

The output report feeds the dashboard's **Assurance Score**, **Traceability
Matrix**, and **Exploit Replay** panels.

---

## Related documents

- [architecture.md](architecture.md) — the assurance layer among the four layers.
- [invariants.md](invariants.md) — the six invariants violations roll up from.
- [testing.md](testing.md) — the exploit-replay tier in detail.
- [ci.md](ci.md) — the `assurance` CI job that gates on the score.
- [../assurance/README.md](../assurance/README.md) — the assurance engine's CLI.
