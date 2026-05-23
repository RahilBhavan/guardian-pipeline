# Guardian Pipeline — Claude Code Root Spec

## What this project is

A DeFi security pipeline with two integrated layers:

1. **CI/CD invariant fuzz harness** — Foundry runs randomised call sequences against an interest-bearing lending vault on every git push, asserting mathematical invariants hold before deployment.
2. **Off-chain Guardian bot** — A TypeScript daemon, shipped as a runnable reference implementation, that — when run against a deployed vault on Base L2 — monitors the same invariants and persists any violation to Supabase.

A third **assurance layer** ties the two together: it maps each security-review finding to the invariant and exploit-replay test that covers it, and emits an assurance score consumed by the dashboard and CI.

**Research grounding** (verified against the source papers as of 2026-05-22):
- Bourveau, Brendel & Schoenfeld (2024), *Decentralized Finance (DeFi) assurance: early evidence*, Review of Accounting Studies 29(3) — hand-codes ~8,500 DeFi audit reports; documents the market as pervasive, value-relevant, and distinct from conventional financial audits.
- Landsman, Lyandres, Maydew, Rabetti & Zhang (2025), *Auditing Smart Contracts*, SSRN — examines ~8,195 audit reports across 1,575 protocols; finds post-deployment outcomes depend on auditor characteristics (market share, launch rate, hack rate) rather than the mere presence of an audit.

Neither paper itself argues for "continuous, multi-layered verification" — that is *this project's* interpretation of one possible design response to the question both papers raise (how to make audit effectiveness more measurable). Never put that framing in either paper's mouth in README/docs/code.

This project is a **reference implementation** of one such design — a portfolio / research-demonstration build, not production infrastructure and not a hosted service.

---

## Repo structure

```
Guard/
├── CLAUDE.md                     ← this file
├── README.md  CONTRIBUTING.md  SECURITY.md  LICENSE
├── ERRORS.md  MEMORY.md          ← session logs (see ~/.claude/CLAUDE.md Memory Protocol)
├── foundry.toml  foundry.lock
├── slither.config.json  .aderyn.toml   ← static-analysis configs
├── vercel.json
├── .github/workflows/invariant-ci.yml
├── src/
│   ├── Vault.sol                 ← interest-bearing lending vault
│   ├── AttackableVault.sol       ← demo-only subclass with the attack() demo flag
│   └── MockERC20.sol
├── test/
│   ├── unit/VaultUnit.t.sol
│   ├── invariant/
│   │   ├── InvariantVault.t.sol
│   │   └── handlers/{Deposit,Borrow,Liquidate,Warp,Donation}Handler.sol
│   └── exploit/
│       ├── ExploitReplay.t.sol
│       ├── ExploitScenarios.sol
│       └── InvariantChecks.sol
├── script/{DeployVault,ExploitReplay}.s.sol
├── guardian/                     ← off-chain monitoring bot
│   ├── package.json  tsconfig.json  .env.example
│   └── src/{bot,fetcher,evaluator,router,types}.ts
├── dashboard/                    ← Vite + React dashboard (deployed to Vercel)
│   ├── package.json  index.html  vite.config.ts  tsconfig.json
│   └── src/
│       ├── main.tsx  App.tsx  supabase.ts  assurance.ts  types.ts
│       ├── data/assurance-report.json
│       └── components/{InvariantHealth,AlertFeed,LatencyBadge,
│                       AssuranceScore,ExploitReplay,TraceabilityMatrix}.tsx
├── assurance/                    ← assurance-scoring CLI (audit ↔ invariant traceability)
│   ├── package.json  tsconfig.json
│   ├── src/{cli,score,traceability,findings,invariants,exploits,sources,report}.ts
│   ├── test/{score,traceability}.test.ts
│   └── data/{assurance-report.json,assurance-report.md,exploit-replays.json,history.jsonl}
├── security-review/              ← self-conducted point-in-time security review
│   ├── findings.json
│   └── Vault-Security-Review.md
├── supabase/migrations/{0001_init,0002_lockdown_insert_rls}.sql
└── docs/                         ← canonical documentation — start at docs/README.md
    └── README.md  architecture.md  architecture.svg  contracts.md  invariants.md
        testing.md  ci.md  guardian-bot.md  database.md  assurance.md  setup.md  glossary.md
```

---

## Key constraints (enforce these in every file)

| Constraint | Value |
|---|---|
| Solidity | `^0.8.24` |
| Foundry | latest stable |
| Node.js | `>=20` |
| TypeScript | strict mode |
| Chain target | Base Sepolia (testnet) + Base mainnet fork via Anvil |
| RPC provider | Alchemy |
| Chain ID (Base Sepolia) | `84532` |
| Alert surface | Supabase real-time → dashboard |
| Dashboard deploy | Vercel |
| DB | Supabase (Postgres) |

---

## What NOT to do

- Do not use `pragma solidity ^0.8.0` — pin to `^0.8.24`.
- Do not use `ethers.js` — use `viem` throughout the Guardian bot.
- Do not use `create-react-app` — use Vite.
- Do not write mock invariant checks — the TypeScript evaluator must call the actual deployed contract via `readContract` to fetch state.
- Do not use `console.log` in production bot paths — use a structured logger (`pino`).
- Do not hardcode the Alchemy key anywhere — always read from `process.env`.
- Do not install Hardhat — this project is Foundry-only for the contract layer.
- Do not expose the Supabase service-role key to the browser — the bot writes with it server-side; the dashboard reads with the anon key only.

---

## Commit cadence — durable authorization

When working through a multi-item punch list (the kind produced by a critical
review or a `/loop`-style task plan), commit **and** push to `origin` after each
item is implemented and verified. One commit per item — never batch multiple
items into one commit.

This standing authorization covers ordinary work pushes on a feature branch:

- Run the relevant local check first (`forge test`, package `npm test`,
  `tsc --noEmit`, or `npm run build` — whichever the item touches). Do not
  commit if the check fails.
- Use conventional-commit prefixes (`feat:` / `fix:` / `refactor:` / `docs:` /
  `test:` / `chore:`) — match the existing log style.
- Stage files explicitly by path; never `git add -A` / `git add .`.
- Push to the current branch's upstream — never to `main` directly, never
  force-push, never `--no-verify`.
- After pushing, state the commit SHA and the next item in one line, then
  proceed to the next item without re-asking permission.

This authorization does **not** extend to: merging PRs, force-pushing, pushing
to `main`, opening/closing PRs from the CLI, or any of the other hard stops in
`~/.claude/CLAUDE.md`. Those still require a fresh in-session confirmation.

---

## Documentation

`docs/` is the single source of truth — start at `docs/README.md`. The original
phase spec files (`specs/01_*`–`07_*.md`) were build scaffolding and were removed
in commit `0ed2d5b` once the system was built.

---

## Environment variables

Create a `.env` in `guardian/` before running the bot. The canonical list with
inline notes is `guardian/.env.example`:

```env
ALCHEMY_KEY=your_alchemy_api_key_here
VAULT_ADDRESS=0x...deployed_vault_address
TOKEN_ADDRESS=0x...deployed_mock_erc20_address
VAULT_DEPLOY_BLOCK=0            # deployment block — start of the per-user event scan
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=...        # service-role key — bypasses RLS, server-side only, never commit
BLOCK_POLL_INTERVAL_MS=2000
CHAIN=base-sepolia
```

The dashboard reads its own `dashboard/.env` (`VITE_`-prefixed: Supabase URL,
anon key, vault address). See `dashboard/.env.example`.

---

## Demo script

The Loom demo follows this exact sequence:

1. Show green CI badge in GitHub Actions tab.
2. Open two windows side-by-side: Guardian bot running in one, the dashboard in the other.
3. Open a third terminal. Run:
   ```bash
   cast send $VAULT_ADDRESS "attack()" --account guardian-demo --rpc-url $BASE_SEPOLIA_RPC
   ```
   (`attack()` lives on `AttackableVault` — the deployed demo vault.)
4. Guardian detects on the next block (~2 s). Dashboard turns red within one block.
5. Show the dashboard alert: invariant name, block number, violated condition.

Total runtime: under 90 seconds of footage.
