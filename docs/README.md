# Documentation

The complete documentation set for Guardian Pipeline. New here? Read the
[root README](../README.md) for the project's thesis, then start with
[architecture.md](architecture.md).

---

## Start here

| Document | What it covers |
|----------|----------------|
| [architecture.md](architecture.md) | The four layers and how state flows between them — the mental model for everything else. |
| [invariants.md](invariants.md) | All six invariants — formulas, failure modes, and which layer enforces each. |

## Reference

Reference-grade detail on each component, accurate to the source.

| Document | What it covers |
|----------|----------------|
| [contracts.md](contracts.md) | `Vault.sol` + `MockERC20.sol` API — every function, event, error, and storage slot. |
| [guardian-bot.md](guardian-bot.md) | The off-chain bot, module by module — the per-block lifecycle, config, error handling. |
| [database.md](database.md) | The Supabase schema — both tables, indexes, the RLS model, real-time, migrations. |
| [testing.md](testing.md) | The four test tiers — unit, parameterized fuzz, invariant fuzz, exploit replays — and how to read a counterexample. |
| [ci.md](ci.md) | The six-job CI/CD pipeline — the job graph, what each job gates, secrets, artifacts. |
| [assurance.md](assurance.md) | The Assurance Score, the exploit-replay catalogue, and finding traceability. |

## Operations

| Document | What it covers |
|----------|----------------|
| [setup.md](setup.md) | End-to-end local setup, Base Sepolia deployment, and the demo. ~15 minutes. |

## Project

| Document | What it covers |
|----------|----------------|
| [../SECURITY.md](../SECURITY.md) | Threat model, trust boundaries, the `attack()` demo flag, responsible disclosure. |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Development workflow, conventions, CI gates, the PR checklist. |
| [glossary.md](glossary.md) | Every project identifier and term, defined in one place. |

---

## Reading paths

Pick the trail that matches what you are doing:

- **Understand the project** → [architecture.md](architecture.md) →
  [invariants.md](invariants.md) → [assurance.md](assurance.md)
- **Run it locally** → [setup.md](setup.md) →
  [guardian-bot.md](guardian-bot.md) → [database.md](database.md)
- **Review the contract** → [contracts.md](contracts.md) →
  [invariants.md](invariants.md) → [testing.md](testing.md) →
  [../SECURITY.md](../SECURITY.md)
- **Contribute a change** → [../CONTRIBUTING.md](../CONTRIBUTING.md) →
  [testing.md](testing.md) → [ci.md](ci.md)

---

## Documentation map

```
README.md (root)            project thesis, quickstart, the 6 invariants at a glance
├─ docs/architecture.md      the four layers, state flow
├─ docs/invariants.md        INV-01..06 — formulas, failure modes, coverage
├─ docs/contracts.md         Vault + MockERC20 API reference
├─ docs/guardian-bot.md      the off-chain bot, module by module
├─ docs/database.md          Supabase schema + RLS
├─ docs/testing.md           unit / invariant / exploit-replay tiers
├─ docs/ci.md                the six-job CI pipeline
├─ docs/assurance.md         the Assurance Score + exploit catalogue
├─ docs/setup.md             local setup, deployment, the demo
├─ docs/glossary.md          terminology
├─ SECURITY.md               threat model + disclosure
└─ CONTRIBUTING.md           workflow + conventions
```

---

## Assets

| File | Status | How to produce |
|------|--------|----------------|
| `architecture.svg` | committed | Hand-authored SVG of the multi-layer pipeline. |
| `architecture.png` | optional | Export `architecture.svg` to PNG if a raster is needed. |
| `counterexample.png` | screenshot | See [below](#capturing-counterexamplepng). |
| `aderyn-report.md` | generated | Produced by the `static-analysis` CI job (or `aderyn .` locally). |

### Capturing `counterexample.png`

The fuzz harness is only convincing if you can see it *fail*. To produce the
counterexample screenshot:

1. In `src/Vault.sol`, temporarily add a forced violation to `borrow()` — for
   example, inflate the lender-side claim with no matching assets:

   ```solidity
   // BUG: forced INV-01 violation — delete after screenshot
   totalSupplyAssets += amount * 1_000;
   ```

2. Run the deep profile:

   ```bash
   FOUNDRY_PROFILE=deep forge test --match-contract InvariantVault -vvv
   ```

3. Forge prints a shrunk counterexample call sequence under
   `[FAIL] invariant_solvency()`. Screenshot that terminal output and save it
   here as `counterexample.png`.

4. **Restore `borrow()`** and re-run the suite to confirm all six invariants
   pass again.
</content>
