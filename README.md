# Guardian Pipeline

[![Invariant CI](https://github.com/rahilbhavan/guardian-pipeline/actions/workflows/invariant-ci.yml/badge.svg)](https://github.com/rahilbhavan/guardian-pipeline/actions/workflows/invariant-ci.yml)
[![Vault coverage](https://img.shields.io/badge/Vault%20coverage-100%25-brightgreen)](./docs/assurance.md)
[![Assurance score](https://img.shields.io/badge/assurance%20score-gated%20%E2%89%A580-0052FF)](./docs/assurance.md)
[![Built on Base](https://img.shields.io/badge/Base_L2-0052FF)](https://base.org)
[![Solidity](https://img.shields.io/badge/Solidity-0.8.24-363636)](https://soliditylang.org)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue)](./LICENSE)

> An automated DeFi assurance pipeline that closes the gap between
> pre-deployment invariant fuzz testing and live on-chain monitoring — proving
> the *same* mathematical property before deployment and enforcing it after.

**Demo video:** [Watch 3-min Loom ↗](YOUR_LOOM_URL) · **Live dashboard:** [guardian-pipeline.vercel.app ↗](YOUR_VERCEL_URL)

---

## Why this exists

Two empirical findings motivate this project:

- **Bourveau et al. (2024)** — *Decentralized Finance (DeFi) assurance: early
  evidence.* Across 8,500+ smart-contract audit reports, **continuous,
  multi-layered assurance** — not one-time audits — is the distinguishing
  characteristic of protocols that survive.
- **Landsman et al. (2025)** — *Auditing Smart Contracts.* Traditional
  point-in-time static audits show **little empirical evidence of preventing
  runtime exploits** — flash-loan attacks, dynamic balance manipulation, and
  other economic exploits land *after* the audit is signed off.

**The gap:** no open-source tool unifies (a) pre-deployment invariant fuzz
testing in CI with (b) live on-chain monitoring that enforces those *same*
invariants post-launch. Guardian Pipeline builds both, and proves the property
checked before deployment is byte-for-byte the property monitored after it.

---

## How it works

![Architecture diagram](docs/architecture.svg)

Three runtime layers, plus an assurance layer that scores them:

1. **Pre-deployment (CI/CD)** — Foundry invariant fuzzing runs on every push.
   A green badge means all 8 invariants held across 2,000+ randomised call
   sequences (~300,000 calls) with zero reverts.
2. **Smart contract** — a minimal over-collateralised lending vault
   (`deposit` · `withdraw` · `borrow` · `repay`) whose 8 invariants are
   documented as NatSpec and exercised by Foundry handlers.
3. **Runtime guardian** — a TypeScript daemon on Base L2. On every block it
   fetches vault state, evaluates the same 8 invariants, and persists any
   violation to Supabase — surfaced on the live dashboard within one block
   (~2 s) of the breach.
4. **Assurance layer** — backtests 7 historical exploit classes, traces audit
   findings to the layers that cover them, and rolls everything into a single
   composite **Assurance Score** that CI gates on.

The off-chain evaluator (`guardian/src/evaluator.ts`) is a deliberate 1:1
mirror of the Solidity `invariant_*` functions in
`test/invariant/InvariantVault.t.sol`. The same maths, on both sides of
deployment. See **[docs/architecture.md](docs/architecture.md)**.

---

## The 8 invariants

| ID | Name | Property | Severity |
|----|------|----------|----------|
| INV-01 | Solvency | `totalBorrowed ≤ totalDeposited` | Critical |
| INV-02 | Liquidity buffer | `tokenBalance(vault) ≥ totalDeposited − totalBorrowed` | Critical |
| INV-03 | Share price floor | `sharePrice ≥ 1e18` | High |
| INV-04 | Share accounting | `totalShares = Σ userShares[i]` | High |
| INV-05 | Collateral cap | `∀u: userBorrowed[u] ≤ userShares[u] × sharePrice / 1e18 × collateralRatio` | High |
| INV-06 | No share inflation | `sharePrice × totalShares / 1e18 ≤ totalDeposited` | Medium |
| INV-07 | Non-negative net | `totalDeposited ≥ totalBorrowed` | Medium |
| INV-08 | Zero-state consistency | `totalShares == 0 ⇔ totalDeposited == 0` | Low |

Each invariant is asserted by a `public view` function in the Foundry harness
and mirrored in `evaluator.ts`. INV-04 and INV-05 use aggregate proxies
off-chain (the bot has no per-user event index in the MVP). Full reference,
including what breaks each one and which layer catches it:
**[docs/invariants.md](docs/invariants.md)**.

---

## The assurance layer

A point-in-time audit produces a PDF. Guardian Pipeline produces a **living
score** — recomputed on every commit — composed of four independent layers:

| Layer | Weight | What it measures |
|-------|--------|------------------|
| Static verification | 30% | Line/branch coverage + fuzz intensity on `Vault.sol` |
| Exploit resistance | 25% | 7 historical exploit classes replayed (EXP-01…07) |
| Continuous monitoring | 25% | Live uptime, liveness, and detection latency |
| Audit traceability | 20% | % of audit findings provably covered by ≥1 invariant + harness test + live monitor |

Every replayed exploit is classified **PREVENTED** (code blocked it),
**DETECTED** (state corrupted, but an invariant caught it same-block), or
**MISSED** (value extracted, no invariant noticed — a gap). Current result:
**6 PREVENTED, 1 DETECTED, 0 MISSED.** CI fails the build if the composite
score drops below **80**. See **[docs/assurance.md](docs/assurance.md)**.

---

## Quickstart

**Prerequisites:** [Foundry](https://getfoundry.sh/), Node.js ≥ 20, an Alchemy
API key, and a Supabase project (all free tiers work).

```bash
git clone https://github.com/rahilbhavan/guardian-pipeline
cd guardian-pipeline
forge install                        # forge-std + openzeppelin-contracts
cd guardian && npm install && cd ..
cd dashboard && npm install && cd ..

# Run the invariant suite locally
forge test --match-contract InvariantVault -vvv
```

Full deploy-and-run instructions — keystore setup, Base Sepolia deployment,
Supabase provisioning, starting the bot and dashboard — are in
**[docs/setup.md](docs/setup.md)**.

### See it catch a violation

With the vault deployed and the Guardian bot running:

```bash
cast send $VAULT_ADDRESS "attack()" \
  --account guardian-demo \
  --rpc-url $BASE_SEPOLIA_RPC
```

`attack()` is a demo-only backdoor that forces the vault insolvent (it reverts
on Base mainnet). The Guardian detects the INV-01 violation on the next block,
writes it to Supabase, and the dashboard turns red — all within ~2 seconds.

---

## CI/CD pipeline

`.github/workflows/invariant-ci.yml` runs **6 jobs** on every push/PR to `main`:

| Job | What it does |
|-----|--------------|
| `build` | `forge build --sizes`; gates all other jobs |
| `invariant-fuzz` | 2,000-run invariant campaign; fails on any `[FAIL]` |
| `coverage` | LCOV report; gates `src/Vault.sol` at ≥ 85% line coverage |
| `static-analysis` | Slither + Aderyn, uploaded as artifacts |
| `assurance` | Exploit replays + composite Assurance Score; gates at ≥ 80 |
| `gas-snapshot` | `forge snapshot --check`; posts the gas diff as a PR comment |

---

## Repo structure

```
guardian-pipeline/
├── src/                  # Solidity contracts (Vault, MockERC20)
├── test/
│   ├── invariant/        # Foundry fuzz harness + handlers
│   ├── unit/             # Deterministic unit coverage
│   └── exploit/          # 7 historical exploit-class replays
├── script/               # Deployment + exploit-replay scripts
├── audit/                # Illustrative audit report + machine-readable findings
├── assurance/            # Assurance-Score tooling (Node)
├── supabase/migrations/  # Database schema + RLS policies
├── .github/workflows/    # CI/CD pipeline (6 jobs)
├── guardian/             # TypeScript Guardian bot (viem)
├── dashboard/            # React + Vite monitoring dashboard
└── docs/                 # Architecture, invariants, setup, assurance
```

---

## Tech stack

| Layer | Tools |
|-------|-------|
| Smart contracts | Solidity 0.8.24 · OpenZeppelin v5 · Foundry / Forge · Anvil · Cast |
| Static analysis | Slither · Aderyn |
| CI/CD | GitHub Actions (6 jobs) |
| Guardian bot | TypeScript (strict) · viem · Alchemy WebSocket · pino |
| Persistence & alerting | Supabase (Postgres + real-time) → dashboard |
| Dashboard | React 18 · Vite · Supabase real-time |
| Deploy | Vercel (dashboard) · Base Sepolia (contracts) |

---

## Documentation

| Doc | Contents |
|-----|----------|
| [docs/architecture.md](docs/architecture.md) | The four layers and how data flows between them |
| [docs/invariants.md](docs/invariants.md) | All 8 invariants — formulas, failure modes, coverage |
| [docs/setup.md](docs/setup.md) | End-to-end local setup, deployment, and the demo |
| [docs/assurance.md](docs/assurance.md) | Assurance Score, exploit replays, audit traceability |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development workflow and conventions |

---

## Licence

MIT — see [LICENSE](./LICENSE).
