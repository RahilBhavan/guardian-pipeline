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

**Grade:** A+ (95–100), A (90–94), A− (85–89), B+ (80–84), B (75–79), …

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
| EXP-01 | Privileged solvency break | INV-01, INV-07 | DETECTED | `attack()` forces insolvency; invariants catch it same-block |
| EXP-02 | ERC-4626 first-depositor inflation | INV-04, INV-06 | PREVENTED | Fixed `sharePrice` prevents share dilution |
| EXP-03 | Bad-debt collateral strip | INV-05, INV-01 | PREVENTED | `withdraw` re-checks the collateral cap |
| EXP-04 | Reserve liquidity drain | INV-02 | PREVENTED | At 80% ratio, free liquidity always covers any single LP |
| EXP-05 | Over-borrow beyond cap | INV-05 | PREVENTED | `borrow` reverts with `CollateralCapExceeded` |
| EXP-06 | Repay-exceeds-debt underflow | INV-01 | PREVENTED | `repay` reverts with `RepayExceedsDebt` |
| EXP-07 | Rounding-dust extraction | INV-06 | PREVENTED | Fixed `sharePrice` makes mint/redeem symmetric |

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
| GUA-01 | Privileged `attack()` can force insolvency | Critical | fully-assured |
| GUA-02 | Reentrancy exposure | Medium | monitored-only |
| GUA-03 | `sharePrice`/`collateralRatio` mutability | Low | fully-assured |
| GUA-04 | Zero-share deposit if `sharePrice > amount` | Low | fully-assured |
| GUA-05 | `InsufficientLiquidity` guards unreachable | Informational | fully-assured |
| GUA-06 | Token donations desync `tokenBalance` | Informational | fully-assured |
| GUA-07 | `collateralRatio` could be immutable (gas) | Gas | not-applicable |
| GUA-08 | No interest accrual / bad-debt reserve | Medium | fully-assured |

**Summary:** 8 findings, 7 security-relevant, 6 fully-assured, 1 monitored-only
(GUA-02 — reentrancy is resolved in code but the hook-free `MockERC20` means
the harness cannot exercise it), **0 gaps** → traceability coverage **92.9%**.

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
- [invariants.md](invariants.md) — the eight invariants violations roll up from.
- [testing.md](testing.md) — the exploit-replay tier in detail.
- [ci.md](ci.md) — the `assurance` CI job that gates on the score.
- [../assurance/README.md](../assurance/README.md) — the assurance engine's CLI.
