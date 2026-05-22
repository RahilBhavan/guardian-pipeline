# Guardian Pipeline — Assurance Report

> **Assurance Score: 91/100 — grade A-**  
> Generated 2026-05-22T22:20:19.653Z · commit `8cea9c2`

The Assurance Score rolls the repository's pre-deployment evidence into one reproducible number — static verification, exploit-replay resistance, and the traceability of every security-review finding to a re-runnable check. It is a demonstration of the continuous, multi-layered assurance the cited research argues for: recomputed on every commit rather than fixed at a point in time.

## Score components

| Component | Score | Weight | Detail |
|---|---|---|---|
| Static Verification | 82 | 45% | Vault.sol 97.2% line / 78.3% branch; fuzz campaign 2000x150 (intensity 64/100) |
| Exploit Resistance | 100 | 35% | 7/7 exploit classes resisted (6 prevented, 1 detected, 0 missed) |
| Finding Traceability | 93.8 | 20% | 93.8% weighted coverage of security-relevant findings |

## Finding traceability matrix

7/8 security-relevant findings fully assured · 93.8% weighted coverage.

| Finding | Severity | Coverage | Invariants | Harness | Live | Replays |
|---|---|---|---|---|---|---|
| GUA-01 Demo insolvency backdoor isolated to a separate contract | Critical | fully assured | INV-01 | 1 | INV-01 | EXP-01 |
| GUA-03 Full-close repayment could erode the solvency margin by one wei | High | fully assured | INV-01 | 1 | INV-01 | — |
| GUA-02 Reentrancy exposure on state-mutating functions | Medium | monitored only | INV-01 | 0 | INV-01 | — |
| GUA-04 Liquidation seizing all collateral must clear the full debt | Medium | fully assured | INV-06 | 1 | INV-06 | EXP-06 |
| GUA-05 Sustained interest can make a lender redemption exceed idle cash | Low | fully assured | INV-01 | 1 | INV-01 | EXP-04 |
| GUA-08 Deeply under-water positions can leave residual bad debt | Low | fully assured | INV-01 | 1 | INV-01 | EXP-06 |
| GUA-06 Share price is immune to direct token donations | Informational | fully assured | INV-01, INV-04 | 2 | INV-01, INV-04 | EXP-02 |
| GUA-07 A full-close repayment may charge up to one wei above userDebt() | Informational | fully assured | INV-01 | 1 | INV-01 | — |

## Exploit-replay catalogue

6 prevented · 1 detected · 0 missed — 100.0% resistance.

| Scenario | Exploit class | Outcome | Safety-net invariants |
|---|---|---|---|
| EXP-01 Privileged solvency break | Access control / privileged-function abuse | DETECTED | INV-01 |
| EXP-02 ERC-4626 first-depositor inflation | Share-price manipulation | PREVENTED | INV-01, INV-04 |
| EXP-03 Bad-debt collateral strip | Undercollateralised borrowing | PREVENTED | INV-01, INV-06 |
| EXP-04 Reserve liquidity drain | Reserve / liquidity mismatch | PREVENTED | INV-01 |
| EXP-05 Over-borrow beyond collateral cap | Collateralisation bypass | PREVENTED | INV-01 |
| EXP-06 Interest-driven liquidation | Under-collateralisation via interest accrual | PREVENTED | INV-01, INV-06 |
| EXP-07 Rounding-dust extraction | Rounding-error accumulation | PREVENTED | INV-01 |

## Research grounding

- **Bourveau et al. (2024), Decentralized Finance (DeFi) assurance: early evidence** — Across 8,500+ audit reports, assurance value comes from continuous, multi-layered verification rather than any single technique.
- **Landsman et al. (2025), Auditing Smart Contracts** — Static, point-in-time audits show little empirical evidence of preventing runtime exploits.

## CI gate

**PASS** against a minimum score of 80.
