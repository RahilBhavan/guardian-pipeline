# Contributing

Thanks for your interest in Guardian Pipeline. This guide covers the
development workflow and the conventions CI enforces.

---

## Getting started

See [docs/setup.md](docs/setup.md) for full environment setup. The short
version:

```bash
forge install
cd guardian && npm install && cd ..
cd dashboard && npm install && cd ..
forge test --match-contract InvariantVault -vvv
```

## Workflow

1. **Branch** — never commit to `main`. Use `feat/…`, `fix/…`, `docs/…`,
   `refactor/…`, `test/…`, or `chore/…`.
2. **Commit** — [Conventional Commits](https://www.conventionalcommits.org/):
   `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`.
3. **Keep PRs small** — under ~400 lines of diff where possible; split larger
   work.
4. **Open a PR** — CI must be green before review (see *CI gates* below).

## The one rule that matters most

**The invariants must stay mirrored.** The 8 invariant IDs (`INV-01`…`INV-08`)
are defined identically in three places:

- `test/invariant/InvariantVault.t.sol` — the Foundry harness
- `guardian/src/evaluator.ts` — the off-chain evaluator
- `test/exploit/` — the exploit-replay harness

If you change an invariant's definition in one, you **must** change it in all
three. The whole project rests on the pre-deployment check and the runtime
check being byte-for-byte the same property. A PR that diverges them will be
rejected.

## Code conventions

| Area | Convention |
|------|------------|
| Solidity | Pin `pragma solidity ^0.8.24` — never `^0.8.0` |
| Contracts | Foundry only — no Hardhat |
| Bot | `viem` — never `ethers.js` |
| Bot logging | Structured `pino` — no `console.log` in bot paths |
| Dashboard | Vite — never `create-react-app` |
| TypeScript | Strict mode; no `any`, no `@ts-ignore` |
| Secrets | Read from `process.env`; never hardcode keys; never commit `.env` |
| NatSpec | Every public contract function and every invariant is documented |

## CI gates

`.github/workflows/invariant-ci.yml` runs 6 jobs on every push/PR to `main`.
A PR is mergeable only when all gating jobs pass:

| Job | Gate |
|-----|------|
| `build` | `forge build` succeeds |
| `invariant-fuzz` | 2,000-run campaign, zero `[FAIL]` |
| `coverage` | `src/Vault.sol` ≥ 85% line coverage |
| `assurance` | composite Assurance Score ≥ 80 |
| `static-analysis` | Slither + Aderyn run (non-gating, artifacts uploaded) |
| `gas-snapshot` | `forge snapshot --check` (non-gating, posts a PR diff) |

Run them locally before pushing:

```bash
FOUNDRY_PROFILE=ci forge test --match-contract InvariantVault -vvv
forge coverage --report summary
forge test --match-path "test/exploit/*" -vvv
cd guardian && npm run typecheck && cd ..
```

## PR checklist

- [ ] Branch is not `main`; commits follow Conventional Commits
- [ ] Invariant changes (if any) are mirrored across all three layers
- [ ] `forge test` and `npm run typecheck` pass locally
- [ ] New behaviour has tests; NatSpec updated for contract changes
- [ ] Docs in `docs/` updated if behaviour or setup changed
- [ ] No secrets, no `console.log` in bot paths, no `any`

## Reporting issues

Open a GitHub issue with: what you expected, what happened, and the minimal
steps to reproduce. For a suspected invariant gap, include the call sequence
and the affected `INV-…` ID.
