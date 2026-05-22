# Architecture

Guardian Pipeline enforces one set of mathematical invariants across the entire
lifecycle of a DeFi protocol — before deployment and after. This document
explains the four layers and how state flows between them.

![Architecture diagram](architecture.svg)

---

## The core idea

A protocol's safety can be expressed as a set of **invariants** — properties
that must hold in every reachable state (e.g. *the vault can never owe more
than it holds*). Guardian Pipeline writes those invariants **once**, then
enforces the identical definition in two places:

- **Before deployment** — as Foundry `invariant_*` functions, fuzzed against
  hundreds of thousands of randomised call sequences.
- **After deployment** — as a TypeScript evaluator that re-checks the same
  formulas against live on-chain state, every block.

`guardian/src/evaluator.ts` is a deliberate 1:1 mirror of
`test/invariant/InvariantVault.t.sol`. If the two ever diverge, the project has
failed its own thesis — so the 8 invariant IDs (`INV-01`…`INV-08`) are shared
verbatim across both.

---

## Layer 1 — Pre-deployment (CI/CD)

**Trigger:** every `push` and `pull_request` to `main`.

Foundry's invariant fuzzer drives the vault through random call sequences via
three handler contracts (`DepositHandler`, `BorrowHandler`, `WarpHandler`) and
asserts all 8 invariants after each step.

| Profile | Runs | Depth | Use |
|---------|------|-------|-----|
| `default` | 500 | 100 | Local iteration |
| `ci` | 2,000 | 150 | Every push (~300,000 calls) |
| `deep` | 10,000 | 200 | Pre-release |

A green CI badge is a claim: *all 8 invariants survived the campaign with zero
reverts.* The full job breakdown is in [setup.md](setup.md) and the
[root README](../README.md#cicd-pipeline).

## Layer 2 — Smart contract

`src/Vault.sol` — a minimal over-collateralised lending vault. Users deposit a
single ERC-20, receive ERC-4626-style shares, and may borrow up to 80% of their
collateral value.

- **State:** `totalDeposited`, `totalBorrowed`, `totalShares`, `sharePrice`
  (fixed 1:1 peg at `1e18`), `collateralRatio` (fixed `80_00` bps), and
  per-user `userShares` / `userBorrowed` maps.
- **Mutating functions:** `deposit`, `withdraw`, `borrow`, `repay` — all
  `nonReentrant`, all reverting on a zero amount.
- **`attack()`** — a demo-only backdoor callable only by the `attacker`
  address. It forces `totalBorrowed = totalDeposited + 1`, breaking INV-01. It
  reverts on Base mainnet (`block.chainid == 8453`) so the backdoor can never
  be triggered in production.

`src/MockERC20.sol` is a plain 18-decimal test token (`mUSD`) with unrestricted
`mint` — intentionally hook-free, so the harness need not model ERC-777-style
reentrancy.

The full contract API — every function, event, error, and storage slot — is in
[contracts.md](contracts.md).

## Layer 3 — Runtime guardian

`guardian/` — a TypeScript daemon that monitors the deployed vault on Base L2.

```
watchBlockNumber ─▶ fetchVaultState ─▶ evaluateInvariants ─▶ router
   (viem, ~2s)        (1 multicall)        (8 checks)         │
                                                              ├─▶ blocks_checked  (every block)
                                                              └─▶ alerts          (on violation)
```

1. **Poll** — a viem WebSocket client subscribes to new block numbers
   (`BLOCK_POLL_INTERVAL_MS`, default 2,000 ms). A re-entrancy flag skips a
   block if the previous check is still running.
2. **Fetch** — `fetcher.ts` reads all 6 state values in a single `multicall`.
3. **Evaluate** — `evaluator.ts` runs the 8 invariant checks against the
   snapshot. Detection latency is `Date.now()` before fetch vs. after evaluate.
4. **Route** — `router.ts` writes one `blocks_checked` row per block (liveness
   + latency history) and one `alerts` row per violation. Database failures are
   logged and swallowed — a monitor must never crash on its own alert path.

The bot requires the Supabase **service-role** key: RLS denies inserts to the
public anon key, so only the server-side bot can write.

Module-by-module detail is in [guardian-bot.md](guardian-bot.md); the schema it
writes to is in [database.md](database.md).

## Layer 4 — Assurance

The assurance layer turns the other three into a single auditable number — the
**Assurance Score** (0–100) — recomputed on every commit by the `assurance` CI
job. It backtests 7 historical exploit classes, traces 8 audit findings to the
layers that cover them, and gates CI at a minimum score of 80. Full detail in
[assurance.md](assurance.md).

---

## Data flow at a glance

```
git push ──▶ GitHub Actions ──▶ Forge fuzz + Slither/Aderyn + Assurance Score
                                          │ validates
                            Vault.sol (deployed to Base Sepolia)
                                          │ monitors
        Alchemy RPC ──▶ Guardian bot ──▶ Supabase ──▶ React dashboard
                                                      (real-time, <1 block)
```

| Component | Reads from | Writes to |
|-----------|-----------|-----------|
| Guardian bot | Base L2 (via Alchemy) | Supabase `alerts`, `blocks_checked` |
| Dashboard | Supabase (anon key, real-time) | — |
| CI assurance job | Forge output, `audit/findings.json` | `assurance/data/*` |

---

## Related documents

- [invariants.md](invariants.md) — the 8 invariants in full
- [contracts.md](contracts.md) — the `Vault` / `MockERC20` API reference
- [guardian-bot.md](guardian-bot.md) — the off-chain bot, module by module
- [database.md](database.md) — the Supabase schema and RLS model
- [testing.md](testing.md) — the three test tiers
- [ci.md](ci.md) — the six-job CI/CD pipeline
- [assurance.md](assurance.md) — the Assurance Score and exploit replays
- [setup.md](setup.md) — running every layer locally
- [glossary.md](glossary.md) — terminology
