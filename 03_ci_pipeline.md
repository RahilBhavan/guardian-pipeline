# Spec 03 — GitHub Actions CI/CD Pipeline

**Paste this into Claude and say:** "Write the GitHub Actions workflow file and all supporting config exactly as specified. Output full file contents with file path headers."

---

## Context

The Solidity contracts and Foundry harness from Specs 01–02 already exist. This spec adds:
- `.github/workflows/invariant-ci.yml` — the main pipeline.
- `slither.config.json` — Slither static analysis config.
- `.aderyn.toml` — Aderyn config.
- Badge snippet for `README.md`.

The pipeline runs on every push to `main` and every pull request. Total target runtime: under 4 minutes on `ubuntu-latest`.

---

## File 1: `.github/workflows/invariant-ci.yml`

### Trigger

```yaml
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
```

### Jobs — run in this order

#### Job 1: `build`

```yaml
build:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
      with:
        submodules: recursive

    - name: Install Foundry
      uses: foundry-rs/foundry-toolchain@v1
      with:
        version: nightly

    - name: Install deps
      run: forge install

    - name: Build contracts
      run: forge build --sizes
```

`--sizes` prints contract bytecode sizes — useful for spotting bloat early.

#### Job 2: `invariant-fuzz` (depends on `build`)

```yaml
invariant-fuzz:
  needs: build
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
      with:
        submodules: recursive

    - name: Install Foundry
      uses: foundry-rs/foundry-toolchain@v1
      with:
        version: nightly

    - name: Install deps
      run: forge install

    - name: Run invariant fuzz tests
      env:
        BASE_SEPOLIA_RPC: ${{ secrets.BASE_SEPOLIA_RPC }}
        FOUNDRY_PROFILE: ci
      run: |
        forge test --match-contract InvariantVault -vvv 2>&1 | tee invariant-results.txt
        # Fail the job if any invariant failed
        if grep -q "\[FAIL\]" invariant-results.txt; then
          echo "::error::Invariant violation detected"
          exit 1
        fi

    - name: Upload fuzz results
      if: always()
      uses: actions/upload-artifact@v4
      with:
        name: invariant-results
        path: invariant-results.txt
```

#### Job 3: `coverage` (depends on `build`)

```yaml
coverage:
  needs: build
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
      with:
        submodules: recursive

    - name: Install Foundry
      uses: foundry-rs/foundry-toolchain@v1

    - name: Install deps
      run: forge install

    - name: Generate coverage report
      run: forge coverage --report lcov --report summary 2>&1 | tee coverage-summary.txt

    - name: Check minimum coverage
      run: |
        # Extract line coverage percentage and enforce >= 85%
        LINE_COV=$(grep "Lines" coverage-summary.txt | grep -oP '\d+\.\d+(?=%)' | head -1)
        echo "Line coverage: ${LINE_COV}%"
        if (( $(echo "$LINE_COV < 85" | bc -l) )); then
          echo "::error::Line coverage ${LINE_COV}% is below the 85% threshold"
          exit 1
        fi

    - name: Upload coverage
      uses: actions/upload-artifact@v4
      with:
        name: coverage-report
        path: lcov.info
```

#### Job 4: `static-analysis` (depends on `build`, runs in parallel with `coverage`)

```yaml
static-analysis:
  needs: build
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
      with:
        submodules: recursive

    - name: Install Foundry
      uses: foundry-rs/foundry-toolchain@v1

    - name: Install deps
      run: forge install

    - name: Install Slither
      run: pip3 install slither-analyzer --break-system-packages

    - name: Run Slither
      run: |
        slither . --config-file slither.config.json --checklist 2>&1 | tee slither-report.md || true
        # Upload even if slither finds issues (we want the report)

    - name: Install Aderyn
      run: cargo install aderyn 2>/dev/null || true

    - name: Run Aderyn
      run: |
        aderyn . --output docs/aderyn-report.md 2>&1 || true

    - name: Upload static analysis reports
      uses: actions/upload-artifact@v4
      with:
        name: static-analysis-reports
        path: |
          slither-report.md
          docs/aderyn-report.md
```

#### Job 5: `gas-snapshot` (depends on `invariant-fuzz`)

```yaml
gas-snapshot:
  needs: invariant-fuzz
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
      with:
        submodules: recursive

    - name: Install Foundry
      uses: foundry-rs/foundry-toolchain@v1

    - name: Install deps
      run: forge install

    - name: Run gas snapshot
      run: forge snapshot --check 2>&1 | tee gas-diff.txt || true

    - name: Comment gas diff on PR
      if: github.event_name == 'pull_request'
      uses: actions/github-script@v7
      with:
        script: |
          const fs = require('fs');
          const diff = fs.readFileSync('gas-diff.txt', 'utf8');
          github.rest.issues.createComment({
            issue_number: context.issue.number,
            owner: context.repo.owner,
            repo: context.repo.repo,
            body: `## Gas snapshot diff\n\`\`\`\n${diff}\n\`\`\``
          });
```

---

## File 2: `slither.config.json`

```json
{
  "detectors_to_exclude": "naming-convention,solc-version",
  "filter_paths": "lib/,test/,script/",
  "compile_force_framework": "foundry",
  "foundry_compile_all": false,
  "checklist": true
}
```

Exclude `naming-convention` (we follow our own convention) and `solc-version` (pinned in `foundry.toml`). Filter out `lib/` and `test/` — only analyse `src/`.

---

## File 3: `.aderyn.toml`

```toml
[general]
src = "src"
out = "out"
exclude = ["lib", "test", "script"]

[output]
markdown = "docs/aderyn-report.md"
```

---

## GitHub Secrets to configure

Add these in the repo → Settings → Secrets and variables → Actions:

| Secret name | Value |
|---|---|
| `BASE_SEPOLIA_RPC` | `https://base-sepolia.g.alchemy.com/v2/YOUR_ALCHEMY_KEY` |
| `BASE_MAINNET_RPC` | `https://base-mainnet.g.alchemy.com/v2/YOUR_ALCHEMY_KEY` |

---

## README badge snippet

Add to the top of `README.md` after creating the workflow:

```markdown
[![Invariant CI](https://github.com/YOUR_USERNAME/guardian-pipeline/actions/workflows/invariant-ci.yml/badge.svg)](https://github.com/YOUR_USERNAME/guardian-pipeline/actions/workflows/invariant-ci.yml)
[![Coverage](https://img.shields.io/badge/coverage-≥85%25-brightgreen)](./docs/)
```

---

## Acceptance criteria

- Pipeline completes in under 4 minutes on `ubuntu-latest`.
- All 5 jobs show green on a clean push to `main`.
- Gas snapshot diff is posted as a PR comment when a PR is opened.
- Slither report appears in the Actions artifacts download.
- A deliberate invariant violation (temporarily break `borrow()`) causes `invariant-fuzz` to fail with `::error::Invariant violation detected` in the Actions log.
