# Guardian Pipeline — Assurance Report

> **Assurance Score: 82/100 — grade B-**  
> Generated 2026-05-27T18:07:06.738Z · commit `6b58700`

The Assurance Score rolls the repository's pre-deployment evidence into one reproducible number — static verification, exploit-replay resistance, and the traceability of every security-review finding to a re-runnable check. It is a worked demonstration of one design response — recomputing assurance on every commit — to the open empirical question both cited papers raise about audit effectiveness. The "continuous, multi-layered" framing is this project's, not a claim of either paper.

## Score components

| Component | Score | Weight | Detail |
|---|---|---|---|
| Static Verification | 60 | 45% | Vault.sol 100% line / 100% branch; fuzz campaign 0x0 (intensity 0/100); runs.json missing — capped at 60 |
| Exploit Resistance | 100 | 35% | 7/7 exploit classes resisted (7 prevented, 0 detected, 0 missed) |
| Finding Traceability | 100 | 20% | 100% weighted coverage of security-relevant findings |

## Finding traceability matrix

8/8 security-relevant findings fully assured · 100.0% weighted coverage.

| Finding | Severity | Coverage | Invariants | Harness | Live | Replays |
|---|---|---|---|---|---|---|
| GUA-02 Full-close repayment could erode the solvency margin by one wei | High | fully assured | INV-01 | 1 | INV-01 | — |
| GUA-01 Reentrancy exposure on state-mutating functions | Medium | fully assured | INV-01 | 1 | INV-01 | — |
| GUA-03 Liquidation seizing all collateral must clear the full debt | Medium | fully assured | INV-06 | 1 | INV-06 | EXP-05, EXP-07 |
| GUA-08 Vault trusts the oracle implicitly — no staleness, deviation or circuit-breaker checks | Medium | fully assured | INV-01, INV-06 | 2 | INV-01, INV-06 | EXP-03, EXP-07 |
| GUA-04 Sustained interest can make a lender redemption exceed idle cash | Low | fully assured | INV-01 | 1 | INV-01 | — |
| GUA-07 Deeply under-water positions can leave residual bad debt | Low | fully assured | INV-01 | 1 | INV-01 | EXP-05, EXP-07 |
| GUA-05 Share price and collateral accounting are immune to direct token donations | Informational | fully assured | INV-01, INV-04 | 2 | INV-01, INV-04 | EXP-01 |
| GUA-06 A full-close repayment may charge up to one wei above userDebt() | Informational | fully assured | INV-01 | 1 | INV-01 | — |

## Exploit-replay catalogue

7 prevented · 0 detected · 0 missed — 100.0% resistance.

| Scenario | Exploit class | Outcome | Safety-net invariants |
|---|---|---|---|
| EXP-01 ERC-4626 first-depositor inflation | Share-price manipulation | PREVENTED | INV-01, INV-04 |
| EXP-02 Euler 2023 - donateToReserves health bypass | Health-check bypass on collateral reduction | PREVENTED | INV-01, INV-06 |
| EXP-03 Cream 2021 - oracle staleness defense | Oracle suppression / stale price | PREVENTED | INV-11 |
| EXP-04 Over-borrow beyond collateral cap | Collateralisation bypass | PREVENTED | INV-01 |
| EXP-05 Interest-driven liquidation | Under-collateralisation via interest accrual | PREVENTED | INV-01, INV-06 |
| EXP-06 bZx Sep 2020 - cross-account state mutation | Cross-account access (transferFrom typo) | PREVENTED | INV-06 |
| EXP-07 Oracle price-drop liquidation | Collateral-value collapse | PREVENTED | INV-01, INV-06 |

## Research grounding

- **Bourveau, Brendel & Schoenfeld (2024), Decentralized Finance (DeFi) assurance: early evidence (Review of Accounting Studies 29(3))** — Hand-codes ~8,500 DeFi audit reports; documents the market as pervasive, value-relevant, and substantively different from conventional financial audits.
- **Landsman, Lyandres, Maydew, Rabetti & Zhang (2025), Auditing Smart Contracts (SSRN)** — Across ~8,195 reports and 1,575 protocols, finds post-deployment outcomes depend on auditor characteristics (market share, launch rate, hack rate) rather than on the mere presence of an audit.

## CI gate

**PASS** against a minimum score of 80.
