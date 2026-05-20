# Guardian Pipeline — Claude Code Root Spec

## What this project is

An automated DeFi security pipeline with two integrated layers:

1. **CI/CD invariant fuzz harness** — Foundry runs 10,000+ randomised call sequences against a lending vault on every git push, asserting mathematical invariants hold before deployment.
2. **Off-chain Guardian bot** — A TypeScript daemon that monitors the same invariants live on Base L2 after deployment, alerting Discord and updating a dashboard within one block of a violation.

**Research grounding** (cite both in the README):
- Bourveau et al. (2024) *Decentralized Finance (DeFi) assurance: early evidence* — continuous multi-layered assurance across 8,500+ audit reports.
- Landsman et al. (2025) *Auditing Smart Contracts* — static point-in-time audits show little empirical evidence of preventing runtime exploits.

This project is the open-source tool that closes the gap both papers identify.

---

## Repo structure (build exactly this)

```
guardian-pipeline/
├── CLAUDE.md                    ← this file
├── README.md                    ← populated in Phase 6
├── foundry.toml
├── .github/
│   └── workflows/
│       └── invariant-ci.yml
├── src/
│   └── Vault.sol
├── test/
│   └── invariant/
│       ├── InvariantVault.t.sol
│       └── handlers/
│           ├── DepositHandler.sol
│           ├── BorrowHandler.sol
│           └── WarpHandler.sol
├── script/
│   └── DeployVault.s.sol
├── guardian/
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── bot.ts
│   │   ├── fetcher.ts
│   │   ├── evaluator.ts
│   │   ├── router.ts
│   │   └── types.ts
│   └── .env.example
├── dashboard/
│   ├── package.json
│   ├── index.html
│   ├── vite.config.ts
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       └── components/
│           ├── InvariantHealth.tsx
│           ├── AlertFeed.tsx
│           └── LatencyBadge.tsx
└── docs/
    ├── architecture.png         ← screenshot of the SVG diagram
    └── counterexample.png       ← Forge counterexample terminal output
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
| Alert channel | Discord webhook |
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

---

## Spec files

Build each phase in order. Each spec is self-contained — paste it into a Claude session and say "build this exactly".

| File | Phase | What it produces |
|---|---|---|
| `specs/01_vault_contracts.md` | 1 | `src/Vault.sol` + all handler contracts |
| `specs/02_foundry_harness.md` | 2 | `foundry.toml` + `InvariantVault.t.sol` |
| `specs/03_ci_pipeline.md` | 3 | `.github/workflows/invariant-ci.yml` |
| `specs/04_guardian_bot.md` | 4 | All `guardian/src/` TypeScript files |
| `specs/05_dashboard.md` | 5 | `dashboard/src/` React app + Supabase schema |

---

## Environment variables

Create a `.env` in `guardian/` before running the bot:

```env
ALCHEMY_KEY=your_alchemy_api_key
BASE_SEPOLIA_RPC=https://base-sepolia.g.alchemy.com/v2/${ALCHEMY_KEY}
VAULT_ADDRESS=0x...deployed_vault_address
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=...
BLOCK_POLL_INTERVAL_MS=2000
INVARIANT_CHECK_DELAY_BLOCKS=1
```

---

## Demo script (Phase 6)

The Loom demo follows this exact sequence:

1. Show green CI badge in GitHub Actions tab.
2. Open two terminals side-by-side: Guardian bot running in left, Discord open in right.
3. Open a third terminal. Run:
   ```bash
   cast send $VAULT_ADDRESS "attack()" --private-key $ATTACKER_KEY --rpc-url $BASE_SEPOLIA_RPC
   ```
4. Guardian detects on the next block (~2 s). Discord alert fires. Dashboard turns red.
5. Show the alert embed: invariant name, block number, violated condition.

Total runtime: under 90 seconds of footage.
