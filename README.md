# Guardian Pipeline

[![Invariant CI](https://github.com/rahilbhavan/guardian-pipeline/actions/workflows/invariant-ci.yml/badge.svg)](https://github.com/rahilbhavan/guardian-pipeline/actions/workflows/invariant-ci.yml)
[![Vault coverage](https://img.shields.io/badge/Vault.sol%20line%20coverage-97%25-brightgreen)](./docs/invariants.md#testing-strategy)
[![Assurance score](https://img.shields.io/badge/assurance%20score-CI--gated%20%E2%89%A580-0052FF)](./docs/assurance.md)
[![Built for Base](https://img.shields.io/badge/Base_L2-0052FF)](https://base.org)
[![Solidity](https://img.shields.io/badge/Solidity-0.8.24-363636)](https://soliditylang.org)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-blue)](./LICENSE)

> A reference implementation of **cross-deployment invariant enforcement**: the
> same mathematical safety properties checked by a Foundry fuzz campaign *before*
> deployment, and by a runtime monitor that mirrors that campaign *after* it.

This is a portfolio / research-demonstration project. It is **not** production
infrastructure, it does **not** custody real value, and nothing here is
currently running as a hosted service — see [Scope & honesty](#scope--honesty).

> **The single most important read in this repo is
> [`docs/assurance.md`](docs/assurance.md).** It explains the Assurance Score,
> the exploit-replay catalogue, and the traceability matrix that ties every
> security-review finding to the invariant and test that covers it — i.e. the
> thing this project is actually about. Everything else is implementation
> detail behind that one idea.

---

## Why this exists

Two things are generally true of smart-contract security in practice:

- A point-in-time audit is a **snapshot**. It attests that the code looked sound
  on the day it was signed; it cannot speak to the code, parameters, or market
  conditions that exist afterwards.
- Pre-deployment invariant fuzzing and post-deployment on-chain monitoring are
  usually built as **separate tools**, often checking separately-written
  properties — so "the thing proven in CI" and "the thing watched on-chain" can
  quietly drift apart.

Guardian Pipeline is a worked implementation of one idea: write the safety
properties **once**, and enforce that exact definition on both sides of
deployment — proven by a Foundry fuzz campaign in CI, and re-checked by a
runtime monitor whose checks mirror the harness function-for-function. The
framing is informed by two papers on DeFi assurance; see [References](#references).

---

## How it works

![Architecture diagram](docs/architecture.svg)

Four layers — three runtime layers plus an assurance layer that scores them:

1. **Pre-deployment (CI/CD)** — Foundry invariant fuzzing runs on every push. A
   green badge means all 6 invariants held across a 2,000-run campaign (up to
   ~300,000 handler calls) without an invariant failing.
2. **Smart contract** — an interest-bearing, over-collateralised lending vault
   (`deposit` · `withdraw` · `borrow` · `repay` · `liquidate` · `accrue`).
   Borrowers pay interest through a borrow index, lenders earn it as a rising
   share price, and under-water positions are liquidated.
3. **Runtime monitor** — a TypeScript daemon (`guardian/`) that, on every block,
   fetches vault state, evaluates the same 6 invariants, and persists any
   violation to Supabase. It is provided as a **runnable reference
   implementation** with full setup instructions; it is not currently deployed
   against a live vault.
4. **Assurance layer** — backtests 7 historical exploit classes, traces every
   security-review finding to the layers that cover it, and rolls the result
   into a single composite **Assurance Score** that CI gates on.

The off-chain evaluator (`guardian/src/evaluator.ts`) is a deliberate 1:1 mirror
of the Solidity `invariant_*` functions in `test/invariant/InvariantVault.t.sol`
— it discovers every account from vault events and reads exact per-user state,
so the off-chain check is the same maths, not a sampled proxy. See
**[docs/architecture.md](docs/architecture.md)**.

---

## The 6 invariants

Not every invariant is equally hard to satisfy, and this project says so
plainly. The **Class** column is the honest distinction:

| ID | Name | Property | Class |
|----|------|----------|-------|
| INV-01 | Protocol solvency | `cash + totalBorrowed ≥ totalSupplyAssets` | **Fuzz-tensioned** — a wrong rounding direction breaks it |
| INV-02 | Supply-share integrity | `totalSupplyShares = Σ userSupplyShares[i]` | Accounting identity — fuzzer regression-checks for a desync |
| INV-03 | Debt-share integrity | `totalBorrowShares = Σ userBorrowShares[i]` | Accounting identity — fuzzer regression-checks for a desync |
| INV-04 | Lender-value floor | `totalSupplyAssets ≥ totalSupplyShares` | Structural — non-trivial proof, confirmed empirically |
| INV-05 | Interest-index floor | `borrowIndex ≥ 1e18` | Structural — true by construction; cheap regression check |
| INV-06 | No uncollateralised debt | `∀u: userSupplyShares[u] == 0 ⇒ userDebt(u) == 0` | **Fuzz-tensioned** — guarded by `withdraw`/`liquidate` logic |

INV-01 and INV-06 are the properties the fuzz campaign genuinely *attacks*;
INV-01 caught a real one-wei solvency leak during development (review finding
GUA-03). INV-04/05 are structural and the harness keeps them as regression
checks. The harness also runs a `DonationHandler` so the donation/inflation
attack class is actually exercised, not just asserted. Full reference, including
what breaks each invariant: **[docs/invariants.md](docs/invariants.md)**.

---

## The assurance layer

A point-in-time audit produces a static document. Guardian Pipeline produces a
**self-computed score** — regenerated by CI on every commit — over three
pre-deployment components. It is a methodology output, not an external
validation (see [Scope & honesty](#scope--honesty)):

| Component | Weight | What it measures |
|-----------|--------|------------------|
| Static verification | 45% | Line/branch coverage + fuzz-campaign size on `Vault.sol` |
| Exploit resistance | 35% | 7 historical exploit classes replayed (EXP-01…07) |
| Finding traceability | 20% | % of review findings bound to ≥1 invariant + harness test + monitor check |

The weights are a deliberate editorial choice, documented in the `score.ts`
header — not presented as empirically derived. Every replayed exploit is
classified **PREVENTED**, **DETECTED**, or **MISSED**; current result:
**6 PREVENTED, 1 DETECTED, 0 MISSED**. CI fails the build if the composite score
drops below **80**. (An earlier design had a fourth "Continuous Monitoring"
component scored from a live deployment — it was removed, since there is no
hosted deployment to score.) See **[docs/assurance.md](docs/assurance.md)**.

---

## Quickstart

**Prerequisites:** [Foundry](https://getfoundry.sh/) and Node.js ≥ 20. The
contract layer and both test suites run with no external services.

```bash
git clone https://github.com/rahilbhavan/guardian-pipeline
cd guardian-pipeline
forge install                        # forge-std + openzeppelin-contracts

forge test                           # 52 tests: unit + parameterized fuzz + invariant + exploit replay
cd assurance && npm install && npm test && cd ..
```

Running the **runtime monitor** and **dashboard** additionally needs an Alchemy
key and a Supabase project (both free tiers); full instructions — keystore
setup, Base Sepolia deployment, starting the bot — are in
**[docs/setup.md](docs/setup.md)**.

---

## The staged detection demo

The runtime monitor can be filmed catching a violation end-to-end. This is a
**staged demo, not a caught attack**: `attack()` lives only on
`AttackableVault` — a demo-only subclass — and is a deliberate one-line flag
that forces an INV-01 violation. It is not an exploit, and the production
`Vault` has no such function.

```bash
cast send $VAULT_ADDRESS "attack()" --account guardian-demo --rpc-url $BASE_SEPOLIA_RPC
```

With the monitor running, it detects the resulting INV-01 violation on the next
block and writes it to Supabase. The demo proves the *plumbing* — fetch →
evaluate → alert — works; it does not claim the monitor catches novel exploits.

---

## CI/CD pipeline

`.github/workflows/invariant-ci.yml` runs **6 jobs** on every push/PR to `main`:

| Job | What it does |
|-----|--------------|
| `build` | `forge build --sizes`; gates all other jobs |
| `invariant-fuzz` | 2,000-run invariant campaign; fails on any `[FAIL]` |
| `coverage` | LCOV report; gates `src/Vault.sol` at ≥ 85% line coverage |
| `static-analysis` | Slither + Aderyn, uploaded as artifacts (non-gating) |
| `assurance` | Exploit replays + composite Assurance Score; gates at ≥ 80 |
| `gas-snapshot` | `forge snapshot --check`; posts the gas diff as a PR comment |

---

## Repo structure

```
guardian-pipeline/
├── src/                  # Solidity contracts (Vault, AttackableVault, MockERC20)
├── test/
│   ├── invariant/        # Foundry fuzz harness + handlers
│   ├── unit/             # Deterministic unit coverage
│   └── exploit/          # 7 historical exploit-class replays
├── script/               # Deployment + exploit-replay scripts
├── security-review/      # Self-conducted security review + machine-readable findings
├── assurance/            # Assurance-Score tooling (Node)
├── supabase/migrations/  # Database schema + RLS policies
├── .github/workflows/    # CI/CD pipeline (6 jobs)
├── guardian/             # TypeScript runtime monitor (viem)
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
| Runtime monitor | TypeScript (strict) · viem · Alchemy WebSocket · pino |
| Persistence | Supabase (Postgres + real-time) |
| Dashboard | React 18 · Vite |
| Build targets | Base Sepolia (contracts) · Vercel config included for the dashboard |

---

## Scope & honesty

This project is built to be read by an engineer, so it states its limits up
front:

- **Not production code.** `Vault.sol` is a teaching example — single asset, no
  price oracle, no bad-debt reserve. Do not custody real value with it. See
  [SECURITY.md](SECURITY.md).
- **Nothing is hosted — no live URL.** The runtime monitor and dashboard are
  runnable reference implementations; this repo does not point at a live
  deployment, has never been adversarially tested against a real attacker, and
  has no incident-replay history against this specific vault. The "continuous"
  in "continuous monitoring" refers to the design pattern the bot implements,
  not to any service this project is operating.
- **The "audit" is a self-review.** [`security-review/`](security-review/) is a
  point-in-time review written by the repository author — not an independent
  third-party audit. Commission one separately before any real deployment.
- **The Assurance Score is self-graded.** The same author writes the
  invariants, picks the exploit set, tags the findings against those
  invariants, *and* grades the result. The score measures methodology maturity
  against an open rubric; it is reproducible, not externally validated. Read
  "A− / 91" as "this codebase grades itself A− against the rubric the codebase
  ships" — not as a third-party certification. The
  [docs/assurance.md](docs/assurance.md#what-this-score-is-not) page spells out
  what the score is and is not in more detail.
- **The detection demo is staged.** `AttackableVault.attack()` is a planted flag
  for filming the monitor, not a real exploit.
- **No formal verification.** The invariant proofs are empirical (Foundry fuzz
  + parameterized constructor fuzz), not symbolic — a Certora/Halmos proof
  would close the residual "is there *any* sequence we missed" question and
  is left as a known gap. See [docs/invariants.md](docs/invariants.md#formal-verification--a-known-gap).

---

## Documentation

| Doc | Contents |
|-----|----------|
| [docs/assurance.md](docs/assurance.md) | **Start here.** Assurance Score, exploit replays, finding traceability |
| [docs/architecture.md](docs/architecture.md) | The four layers and how state flows between them |
| [docs/invariants.md](docs/invariants.md) | All 6 invariants — formulas, classes, failure modes, the four test tiers |
| [docs/contracts.md](docs/contracts.md) | `Vault`, `AttackableVault`, `MockERC20` API |
| [docs/guardian-bot.md](docs/guardian-bot.md) | The runtime monitor, module by module |
| [docs/database.md](docs/database.md) | The Supabase schema, RLS model, and migrations |
| [docs/setup.md](docs/setup.md) | Local setup, deployment, and the staged demo |
| [docs/glossary.md](docs/glossary.md) | Every project identifier and term, defined |
| [SECURITY.md](SECURITY.md) | Threat model, trust boundaries, responsible disclosure |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development workflow and conventions |

The CI/CD pipeline reference lives in the [CI/CD pipeline](#cicd-pipeline)
section above — there is no separate `ci.md`. The four test tiers are
documented in [invariants.md#testing-strategy](docs/invariants.md#testing-strategy).

---

## References

The project's framing is informed by two empirical papers on DeFi audit
markets:

- **Bourveau, Brendel & Schoenfeld (2024)** — *Decentralized Finance (DeFi)
  assurance: early evidence.* Review of Accounting Studies 29(3). Hand-codes
  ~8,500 smart-contract audit reports and documents that this audit market is
  pervasive, value-relevant, and substantively different from conventional
  financial audits.
- **Landsman, Lyandres, Maydew, Rabetti & Zhang (2025)** — *Auditing Smart
  Contracts.* SSRN. Examines determinants and consequences of audits across
  ~8,195 reports and 1,575 protocols; finds outcomes depend on auditor
  characteristics (market share, launch rate, hack rate) more than on the mere
  presence of an audit.

These papers establish that the DeFi audit ecosystem is real and that audit
*effectiveness* is an open empirical question. They do **not** themselves
argue for continuous, multi-layered verification — that framing is this
project's interpretation of one possible design response, not a claim of
either paper. They motivate the question; they are not load-bearing for the
tooling. If you cite this project, read both papers directly first.

---

## Licence

MIT — see [LICENSE](./LICENSE).
