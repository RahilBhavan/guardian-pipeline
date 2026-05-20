# Guardian Pipeline — Assurance Report

> **Assurance Score: 92/100 — grade A-**  
> Generated 2026-05-20T12:08:15.611Z

The Assurance Score quantifies what the cited papers argue for: continuous, multi-layered verification. Each component is one independent layer — static proof, exploit resistance, live monitoring, and audit traceability — and the composite is the empirical evidence a point-in-time audit cannot provide.

## Score components

| Component | Score | Weight | Detail |
|---|---|---|---|
| Static Verification | 84.6 | 30% | Vault.sol 100% line / 83.3% branch; fuzz campaign 2000x150 (intensity 64/100) |
| Exploit Resistance | 100 | 25% | 7/7 exploit classes resisted (6 prevented, 1 detected, 0 missed) |
| Continuous Monitoring | n/a | 25% | Supabase monitoring history unavailable — component excluded from the composite |
| Audit Traceability | 92.9 | 20% | 92.9% weighted coverage of security-relevant findings |

## Audit traceability matrix

6/7 security-relevant findings fully assured · 92.9% weighted coverage.

| Finding | Severity | Coverage | Invariants | Harness | Live | Replays |
|---|---|---|---|---|---|---|
| GUA-01 Privileged attack() function can force protocol insolvency | Critical | fully assured | INV-01, INV-07 | 2 | INV-01, INV-07 | EXP-01 |
| GUA-02 Reentrancy exposure on state-mutating functions | Medium | monitored only | INV-02 | 0 | INV-02 | — |
| GUA-08 No interest accrual leaves the vault unable to build a bad-debt reserve | Medium | fully assured | INV-01, INV-07 | 2 | INV-01, INV-07 | EXP-03 |
| GUA-03 sharePrice and collateralRatio are mutable storage with no setter | Low | fully assured | INV-03 | 1 | INV-03 | — |
| GUA-04 Zero-share deposit possible if sharePrice ever exceeds the deposit amount | Low | fully assured | INV-04, INV-06 | 2 | INV-04, INV-06 | EXP-02 |
| GUA-05 InsufficientLiquidity guards are provably unreachable at an 80% collateral ratio | Informational | fully assured | INV-02 | 1 | INV-02 | EXP-04 |
| GUA-06 Direct token donations desynchronise tokenBalance from accounting | Informational | fully assured | INV-02 | 1 | INV-02 | EXP-04 |
| GUA-07 collateralRatio could be immutable to save an SLOAD per borrow/withdraw | Gas | n/a | — | 0 | — | — |

## Exploit-replay catalogue

6 prevented · 1 detected · 0 missed — 100.0% resistance.

| Scenario | Exploit class | Outcome | Safety-net invariants |
|---|---|---|---|
| EXP-01 Privileged solvency break | Access control / privileged-function abuse | DETECTED | INV-01, INV-07 |
| EXP-02 ERC-4626 first-depositor inflation | Share-price manipulation | PREVENTED | INV-04, INV-06 |
| EXP-03 Bad-debt collateral strip | Undercollateralised borrowing | PREVENTED | INV-05, INV-01 |
| EXP-04 Reserve liquidity drain | Reserve / liquidity mismatch | PREVENTED | INV-02 |
| EXP-05 Over-borrow beyond collateral cap | Collateralisation bypass | PREVENTED | INV-05 |
| EXP-06 Repay-exceeds-debt underflow | Accounting underflow | PREVENTED | INV-01 |
| EXP-07 Rounding-dust extraction | Rounding-error accumulation | PREVENTED | INV-06 |

## Research grounding

- **Bourveau et al. (2024), Decentralized Finance (DeFi) assurance: early evidence** — Across 8,500+ audit reports, assurance value comes from continuous, multi-layered verification rather than any single technique.
- **Landsman et al. (2025), Auditing Smart Contracts** — Static, point-in-time audits show little empirical evidence of preventing runtime exploits.

## CI gate

**PASS** against a minimum score of 80.
