# Guardian Pipeline: 12 lending-vault invariants checked in CI and by a runtime monitor

[![Invariant CI](https://github.com/RahilBhavan/guardian-pipeline/actions/workflows/invariant-ci.yml/badge.svg)](https://github.com/RahilBhavan/guardian-pipeline/actions/workflows/invariant-ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Live:** https://guardian.rahilbhavan.com

![The live dashboard's assurance panels on 2026-10-21: an AMC score of 94/100, 8 of 8 review findings traced to a re-runnable check, and 10 of 10 exploit replays prevented](docs/dashboard.png)

Guardian Pipeline is a Solidity lending vault with 12 safety invariants. A Foundry invariant harness tests the invariants in CI before deployment. A TypeScript monitor re-checks the same 12 invariants against a demo vault on Base Sepolia, a test network that holds no real value, and writes any violation to Supabase for a React dashboard. An assurance layer replays 10 exploit classes, traces each self-review finding to a test, and computes a methodology score that CI gates on.

## Results

- **92 Foundry tests** in `test/`: 39 unit and boundary, 8 parameterized fuzz, 13 invariant (the 12 named invariants plus a reentrancy check for finding GUA-01), 9 differential, 10 exploit replays and 13 mutation tests. The mutation tests break the vault on purpose for INV-07 to INV-12 and assert that the matching invariant catches each break.
- **12 invariants** (INV-01 to INV-12). CI runs them as a 2,000-run invariant campaign at depth 150 on every push and pull request to `main` (`foundry.toml`, `[profile.ci.invariant]`). A scheduled 10,000-run profile is in `.github/workflows/deep-fuzz.yml`. Plain fuzz tests use 256 runs.
- **The solvency invariant (INV-01) caught a real bug during development.** A full-close repayment eroded the solvency margin by one wei. The self-review records it as GUA-02, High, Resolved (`security-review/findings.json`).
- **The runtime monitor mirrors all 12 invariants.** `guardian/src/evaluator.ts` has one check per invariant, and the `mirror-parity` CI job fails if the monitor and the harness drift apart.
- **`src/Vault.sol` has 100% line coverage** (130 of 130 lines, 28 of 31 branches), observed with `forge coverage` on 2026-10-21. CI fails below 85% line coverage.
- **The self-review lists 8 findings**, GUA-01 to GUA-08: 3 resolved and 5 acknowledged (`security-review/findings.json`).
- **The Assurance Methodology Coverage (AMC) score was 94/100 (grade A)** on 2026-06-10 at commit `b349ec8` (`assurance/data/assurance-report.json`). AMC measures how fully the project applied its own verification method. It is self-graded and is not a security rating. See [docs/assurance.md](docs/assurance.md).

The two sentences below are generated from `security-review/findings.json` and `assurance/data/exploit-replays.json`. The `invariant-ci` workflow fails if they drift.

<!-- TRACEABILITY_BEGIN -->

**Finding traceability:** 8/8 security-relevant findings fully assured · 0 monitored-only · 0 harness-only · 0 gap · 100.0% weighted coverage.

<!-- TRACEABILITY_END -->

<!-- EXPLOIT_SUMMARY_BEGIN -->

**10 mechanism replays, 10 PREVENTED, 0 MISSED.**

<!-- EXPLOIT_SUMMARY_END -->

## How it works

1. `src/Vault.sol` is an interest-bearing, over-collateralised, two-asset lending vault. Lenders supply the debt asset. Borrowers post a separate collateral asset that an `IPriceOracle` prices. The demo uses `src/MockOracle.sol`.
2. `test/invariant/InvariantVault.t.sol` drives the vault through random call sequences with eight handlers and asserts the 12 invariants after each call.
3. `guardian/src/evaluator.ts` evaluates the same 12 invariants against live vault state. `guardian/src/bot.ts` runs it once per block. `guardian/src/once.ts` runs it once, from the scheduled workflow `.github/workflows/guardian-monitor.yml`. Violations go to Supabase (`supabase/migrations/`).
4. `dashboard/` is a React 18 and Vite app that reads Supabase. Vercel builds it from `vercel.json`.
5. `assurance/` computes the AMC score from coverage, the exploit replays in `test/exploit/` and the finding bindings in `security-review/findings.json`.
6. `.github/workflows/invariant-ci.yml` runs 7 jobs: build, mirror parity, invariant fuzz, coverage, static analysis (Slither and Aderyn), assurance and gas snapshot. The job table is in [docs/architecture.md](docs/architecture.md#ci-jobs).

## Run it

You need [Foundry](https://getfoundry.sh/) (checked with forge 1.8.6) and Node.js 20 or later. The `guardian/` monitor needs Node.js 22 or later. The contracts and both TypeScript test suites need no external services.

```bash
git clone https://github.com/RahilBhavan/guardian-pipeline
cd guardian-pipeline
forge install
forge test
cd assurance && npm install && npm test && cd ..
cd guardian && npm install && npm test && cd ..
```

Observed on 2026-10-21 with forge 1.8.6 and Node.js 26.8.1:

- `forge test` passed all 92 test functions. Forge prints "80 tests" because it reports the 13 `invariant_*` functions of `InvariantVault` as one suite entry. Each of the 13 prints its own `[PASS]` line.
- `assurance`: 50 of 50 tests passed.
- `guardian`: 66 of 66 tests passed.

To run the invariant campaign with the CI profile (2,000 runs, depth 150). On 2026-10-21 this run made 300,000 handler calls in 135 s, and all 13 invariant functions passed:

```bash
FOUNDRY_PROFILE=ci forge test --match-contract InvariantVault -vvv
```

The monitor and the dashboard need an Alchemy key and a Supabase project. The monitor reads `ALCHEMY_KEY`, `VAULT_ADDRESS`, `DEBT_ASSET`, `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`. The dashboard reads `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. Deployment, keystore setup and the staged detection demo are in [docs/setup.md](docs/setup.md). The public demo addresses are in [demo/README.md](demo/README.md).

## Repository layout

- `src/`: Solidity: `Vault`, `AttackableVault` (demo-only), the oracle interface and mocks, and `attackable/` exploit targets.
- `test/`: Foundry unit, fuzz, invariant, differential, exploit-replay, mutation and Echidna tests.
- `script/`: Foundry scripts for deployment and the exploit-replay catalogue.
- `scripts/`: demo address lookup and the staged detection demo.
- `security-review/`: the self-conducted review and its machine-readable findings.
- `assurance/`: the Node.js tool that computes the AMC score and checks traceability.
- `guardian/`: the TypeScript runtime monitor (viem).
- `dashboard/`: the React and Vite monitoring dashboard.
- `supabase/`: database migrations and row-level security policies.
- `demo/`: public Base Sepolia addresses.
- `docs/`: reference and explanation pages.
- `.github/workflows/`: CI, the deep fuzz, the monitor and the oracle keeper.

## Documentation

- [docs/README.md](docs/README.md): index of the pages below.
- [docs/assurance.md](docs/assurance.md): the AMC score, the exploit replays, finding traceability and what the score does not measure.
- [docs/architecture.md](docs/architecture.md): the four layers, how state flows between them and the CI job table.
- [docs/invariants.md](docs/invariants.md): each invariant's formula, class and failure mode, and the test tiers.
- [docs/contracts.md](docs/contracts.md): the Solidity API.
- [docs/guardian-bot.md](docs/guardian-bot.md): the runtime monitor, module by module, and its environment variables.
- [docs/database.md](docs/database.md): the Supabase schema, row-level security and migrations.
- [docs/setup.md](docs/setup.md): local setup, Base Sepolia deployment and the staged demo.
- [docs/glossary.md](docs/glossary.md): project identifiers and terms.
- [docs/explainer.html](docs/explainer.html): an interactive explainer page.
- [docs/social.md](docs/social.md): launch posts for X.

## Scope and limits

- This is an independent portfolio and research demo. It is not production code and has no affiliation with Base, Coinbase or any protocol named in the exploit replays.
- `Vault.sol` is a teaching example. It uses a permissionless `MockOracle`, has no bad-debt reserve and has no governance. Do not use it to hold real value. See [SECURITY.md](SECURITY.md).
- The security review is a self-review by the repository author, not a third-party audit.
- The AMC score is self-graded. The same author writes the invariants, picks the exploit set, binds the findings and grades the result.
- Fuzzing does not prove the invariants. No Certora or Halmos proof exists. See [docs/invariants.md](docs/invariants.md#formal-verification--a-known-gap).
- The monitor is a best-effort reference implementation, not a service with an uptime promise. Its scheduled workflow last ran on 2026-08-23, and GitHub has since disabled it for inactivity. On 2026-10-21 the live dashboard showed "Guardian down" and no recent checks.
- The staged demo is not an exploit. `AttackableVault.attack()` is a demo-only flag that forces an INV-01 violation so you can watch the monitor alert.

## License

MIT. See [LICENSE](LICENSE).

Part of [Rahil Bhavan's projects](https://github.com/RahilBhavan).
