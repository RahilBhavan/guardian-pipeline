## Learned User Preferences

- Treat Guardian Pipeline as a portfolio/research demo, not production infrastructure; keep README honesty about scope.
- Lead public messaging with the cross-deployment invariant thesis (Foundry CI + runtime mirror), not self-graded AMC scores.
- Ship a short visual demo (screen recording or GIF) before tweeting or sharing widely.
- Use `https://guardian-pipeline.vercel.app` for public links when the custom domain has TLS issues.
- Provide discoverable public demo addresses so others can try without deploying (`demo/addresses.json`, `make demo-addresses`).
- Host the Guardian bot always-on when a live public demo matters; local-only bot is insufficient for visitors.
- Commit and push only when explicitly requested.

## Learned Workspace Facts

- Guardian Pipeline mirrors 12 DeFi invariants in Foundry CI and `guardian/src/evaluator.ts`, with mirror-parity enforced in CI.
- Local workspace is `Guard`; GitHub repo is `RahilBhavan/guardian-pipeline`.
- Canonical demo registry: `demo/addresses.json`; lookup via `scripts/lookup-demo-addresses.mjs` or `make demo-addresses`.
- Cursor subagent `guardian-demo` (`.cursor/agents/guardian-demo.md`) answers demo address and setup questions.
- Shared Base Sepolia demo vault: `0x718C5A3cf2E75A0011118949C9401511ebF3cf1F` (deploy block `41858023`).
- Dashboard is a static Vite build on Vercel; reliable URL is `https://guardian-pipeline.vercel.app`.
- Guardian bot is a long-running Node/WebSocket process and cannot run on Vercel; use Railway, Fly.io, or local for live monitoring.
- Supabase backs alerts and `blocks_checked`; free-tier projects auto-pause after inactivity and must be restored for live dashboard data.
- Staged `attack()` on `AttackableVault` is one-way and requires the operator keystore; redeploy for a fresh demo vault.
