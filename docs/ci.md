# CI/CD pipeline reference

`.github/workflows/invariant-ci.yml` is the pre-deployment half of the
pipeline. It runs on **every `push` and `pull_request` to `main`** and turns
the green badge into a precise, falsifiable claim: *all eight invariants
survived a 300,000-call fuzz campaign, the contract is covered, the exploit
catalogue did not regress, and the composite Assurance Score cleared 80.*

---

## Job graph

Six jobs. `build` runs first; four jobs fan out from it; `gas-snapshot` waits
on the fuzz job.

```
          ┌─ invariant-fuzz ──┐
          ├─ coverage         │
build ────┼─ static-analysis  │
          ├─ assurance        │
          └───────────────────┴─▶ gas-snapshot
                (needs: invariant-fuzz)
```

Every job runs on `ubuntu-latest`, checks out with `submodules: recursive`
(forge-std + OpenZeppelin are git submodules), and installs Foundry via the
pinned `foundry-rs/foundry-toolchain` action. All third-party actions are
**pinned to a commit SHA** — a supply-chain hardening measure so a moved tag
cannot silently change what runs.

---

## Jobs

### `build`

```bash
forge install
forge build --sizes
```

Compiles every contract and prints bytecode sizes. It is the gate for the four
fan-out jobs — nothing else runs until the project compiles.

### `invariant-fuzz`

The headline job. Runs the invariant suite under the **`ci` profile**
(`FOUNDRY_PROFILE: ci` → 2,000 runs × depth 150, ~300,000 calls):

```bash
forge test --match-contract InvariantVault -vvv | tee invariant-results.txt
grep -q "\[FAIL\]" invariant-results.txt && exit 1   # fail on any violation
```

The full log is uploaded as the `invariant-results` artifact (`if: always()`,
so it is available even on failure). **Gating.**

### `coverage`

```bash
forge coverage --report lcov --report summary | tee coverage-summary.txt
```

Runs with a **capped fuzz budget** (`FOUNDRY_INVARIANT_RUNS: 25`,
`FOUNDRY_INVARIANT_DEPTH: 50`) — the unit suite already drives `src/Vault.sol`
to 100% line coverage, so a full campaign here would only add runtime. The
`invariant-fuzz` job owns the real campaign.

The gate parses the line-coverage percentage for `src/Vault.sol` and **fails
if it is below 85%** — only the contract under audit is gated; the deploy
script and test handlers are intentionally excluded. The LCOV report is
uploaded as the `coverage-report` artifact. **Gating.**

### `static-analysis`

Runs two Solidity static analysers:

- **Slither** — `slither . --config-file slither.config.json --checklist`.
- **Aderyn** — `aderyn . --output docs/aderyn-report.md`.

Both run with a trailing `|| true` — this job is **non-gating**. Its purpose is
evidence, not enforcement: the reports are uploaded as the
`static-analysis-reports` artifact for human review and feed the audit
narrative in [assurance.md](assurance.md). **Non-gating.**

### `assurance`

The feature layer's gate. Runs the full assurance pipeline in order:

```
forge test test/exploit/*   →  fail on a regressed or MISSED exploit
forge script ExploitReplay  →  writes assurance/data/exploit-replays.json
forge coverage (capped)     →  writes assurance/data/coverage-summary.txt
npm ci && npm run check     →  composite Assurance Score, gate at ≥ 80
```

`npm run check` is invoked with `--min-score 80 --no-supabase`. The
`--no-supabase` flag drops the Continuous Monitoring component — CI has no live
credentials — and the score is re-normalised over the three available layers.
The report (`assurance-report.json` / `.md`, `exploit-replays.json`) is
uploaded as the `assurance-report` artifact. **Gating** — fails the build on a
MISSED exploit or a sub-80 score. See [assurance.md](assurance.md).

### `gas-snapshot`

```bash
forge snapshot --check | tee gas-diff.txt || true
```

Compares current gas usage against the committed `.gas-snapshot` baseline
(`.gas-snapshot` is deliberately *not* gitignored — it is the baseline). On a
pull request, a follow-up step posts the diff as a PR comment via
`actions/github-script`. The `|| true` keeps it **non-gating** — a gas change
is surfaced for review, never an automatic block. **Non-gating.**

---

## Gating summary

| Job | Gates the build? | What it enforces |
|-----|------------------|------------------|
| `build` | ✅ | Contracts compile. |
| `invariant-fuzz` | ✅ | Zero `[FAIL]` across the 2,000-run campaign. |
| `coverage` | ✅ | `src/Vault.sol` ≥ 85% line coverage. |
| `assurance` | ✅ | No regressed/MISSED exploit; Assurance Score ≥ 80. |
| `static-analysis` | ❌ | Runs Slither + Aderyn; uploads reports. |
| `gas-snapshot` | ❌ | Reports the gas diff; comments on PRs. |

---

## Secrets and configuration

| Secret | Used by | Purpose |
|--------|---------|---------|
| `BASE_SEPOLIA_RPC` | `invariant-fuzz` | Wired into the env in case a test forks Base Sepolia. The invariant suite is self-contained, so the campaign passes without it. |

The pipeline needs **no deployment keys** — it never broadcasts a transaction.
Deployment is a manual, local step (see [setup.md](setup.md)).

---

## Artifacts

Every run uploads its evidence, downloadable from the GitHub Actions run page:

| Artifact | From | Contents |
|----------|------|----------|
| `invariant-results` | `invariant-fuzz` | Full fuzz campaign log. |
| `coverage-report` | `coverage` | `lcov.info`. |
| `static-analysis-reports` | `static-analysis` | Slither + Aderyn reports. |
| `assurance-report` | `assurance` | Assurance Score JSON/MD + exploit catalogue. |

---

## Running the gates locally

Reproduce the gating jobs before pushing — see also the checklist in
[CONTRIBUTING.md](../CONTRIBUTING.md#ci-gates):

```bash
FOUNDRY_PROFILE=ci forge test --match-contract InvariantVault -vvv
forge coverage --report summary
forge test --match-path "test/exploit/*" -vvv
cd assurance && npm ci && npm run check -- --min-score 80 --no-supabase
```

---

## Related documents

- [testing.md](testing.md) — the three test tiers these jobs run.
- [assurance.md](assurance.md) — the Assurance Score the `assurance` job gates.
- [architecture.md](architecture.md#layer-1--pre-deployment-cicd) — CI as Layer 1.
</content>
