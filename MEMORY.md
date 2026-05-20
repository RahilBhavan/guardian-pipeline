# MEMORY.md — Guardian Pipeline

## 2026-05-19 — Built the full project from specs 01–06
What: Implemented all six phases — contracts, Foundry invariant harness, CI
pipeline, Guardian bot (TypeScript/viem), React dashboard, and README.
Why: Specs `01_*`–`06_*.md` defined a self-contained build; goal was a
world-class, fully functional deliverable.
Rejected: n/a — followed the specs as the single source of truth.

## 2026-05-19 — Added a unit test suite (test/unit/VaultUnit.t.sol)
What: 15 deterministic unit tests covering every happy path, every revert, and
the demo-only `attack()` function.
Why: The invariant harness alone gave 89.8% Vault line coverage but only 18%
branch coverage — error paths and `attack()` were never exercised. Unit tests
bring Vault to 100% lines / 100% functions.
Rejected: Relying on the invariant suite alone — left branches unverified.

## 2026-05-19 — InsufficientLiquidity guards are provably unreachable
What: The `InsufficientLiquidity` reverts in `Vault.withdraw()`/`borrow()`
cannot be hit while `collateralRatio` is 80%. Proof: free liquidity
= totalDeposited − totalBorrowed ≥ 0.2·totalDeposited + 0.8·W ≥ W, where W is
any user's share value, so it always covers a single user's withdrawable or
borrowable amount.
Why: Documented so nobody wastes time writing an impossible test. The guards
are kept as defence-in-depth (e.g. a future `collateralRatio` change).
Rejected: Deleting the guards — they cost nothing and protect against future
parameter changes.

## 2026-05-19 — CI coverage gate targets src/Vault.sol, not Total
What: The `coverage` job greps the `src/Vault.sol` row (100%) rather than the
`Total` row (~84%).
Why: `Total` is dragged below 85% by `script/DeployVault.s.sol` (0% — deploy
scripts are not unit-tested) and the test handlers. Spec 02's acceptance
criterion is explicitly `forge coverage --match-contract Vault` ≥ 85%, so the
contract under audit is the correct gate.
Rejected: Gating on `Total` — would fail CI for a non-meaningful reason.

## 2026-05-19 — Optimization & hardening pass
What: Fixed four issues found in review:
1. RLS blocked the bot's inserts — the bot uses the anon key but the migration
   only had SELECT policies. Added INSERT policies; the bot now also prefers an
   optional `SUPABASE_SERVICE_KEY` over the anon key.
2. Evaluator INV-02 passed on an insolvent vault (underflow guarded to 0); the
   Solidity check reverts on that underflow, which Foundry counts as a failure.
   Made the bot mirror it — insolvency now fails INV-02 too.
3. CI `coverage` job ran 500 invariant iterations under coverage instrumentation
   for no gain (unit tests already give Vault 100%). Capped to 25 runs / depth 50.
4. Added a bot startup preflight (RPC reachability, vault bytecode, Supabase
   reachability) so misconfiguration fails fast instead of erroring every block.
Why: Without fix #1 the dashboard would never receive data — the system was not
end-to-end functional.
Rejected: Forcing the bot to require a service key (breaks the spec's anon-only
`.env`); deleting the unreachable liquidity guards (kept as defence-in-depth).

## 2026-05-19 — .gas-snapshot is committed
What: Removed `.gas-snapshot` from `.gitignore`.
Why: The `gas-snapshot` CI job runs `forge snapshot --check`, which needs a
committed baseline to diff against.
Rejected: Keeping it ignored — would make the CI gas-diff meaningless.

## 2026-05-19 — Supabase project provisioned
What: Created the `guardian-pipeline` Supabase project (free tier, $0/mo) in
`us-east-1` and applied `0001_init.sql` (alerts + blocks_checked, RLS, realtime).
- Project ID / ref: `klbqkgyyqkmqoebxbawy`
- URL: `https://klbqkgyyqkmqoebxbawy.supabase.co`
- Org: `zrpnbvgvmaiqklzitfzy` (RahilBhavan's Org)
- Real values written to `guardian/.env` and `dashboard/.env` (both gitignored).
Why: The dashboard needs a live database; the bot needs somewhere to persist.
Note: The user deleted the `tokenscout` project to free a free-tier slot
(2-project cap). Security advisor flags the two `INSERT WITH CHECK (true)`
policies as permissive — see needs-attention below.
Rejected: Reusing the `operator` project (would mix unrelated data).

## 2026-05-20 — Deployed to Base Sepolia + verified live
What: Deployed the contracts to Base Sepolia (chain 84532) and confirmed the
Guardian bot monitors them end-to-end.
- Vault:      `0x7f59c92a5C1827BF0A601E1164c393dff3D644a4`
- MockERC20:  `0xd56e5BfFea640868cd421Ac43dec37c5c8c062f2`
- Deployer/attacker wallet: `0xd48f0Dd19a19A2Ce1d87C1292A3832216B8b5646`
  (key in gitignored root `.env` — TESTNET ONLY)
Verified — healthy path: bot wrote 20 consecutive `blocks_checked` rows to
Supabase, all 8 invariants healthy, ~96ms avg detection latency.
Verified — violation path: called `attack()` (tx in block 41749983); the bot
detected INV-01/02/05/07 on that same block in 60ms and wrote 4 `alerts` rows
per block. Discord 400'd (placeholder webhook) but the bot logged and continued.
The deployed vault is now permanently in a violated state — redeploy for a
fresh demo (`forge script script/DeployVault.s.sol --broadcast ...`).
Bug fixed: `loadConfig` used `??` for the Supabase key, which does not fall
back on an empty-string `SUPABASE_SERVICE_KEY`. Changed to `||`.

## 2026-05-20 — Security hardening pass
What: Locked down Supabase RLS (removed public `insert with check (true)`
policies; added migration `0002_lockdown_insert_rls.sql`); bot now *requires*
`SUPABASE_SERVICE_KEY` for writes and no longer falls back to the anon key.
Removed raw `DEPLOYER_PRIVATE_KEY`/`ATTACKER_KEY` from root `.env` in favour of
a Foundry encrypted keystore (`--account guardian-demo`). Added a
`block.chainid == 8453` guard to `Vault.attack()`, `ReentrancyGuard` on the
four mutating Vault functions, address validation in the bot's `loadConfig`,
SHA-pinned CI actions, Foundry `nightly`→`stable`, and CSP/security headers in
`vercel.json`.
Why: The anon key ships in the public dashboard bundle — open insert policies
let any visitor forge alerts. Plaintext keys and an unguarded mainnet backdoor
are unacceptable even on testnet.
Rejected: Keeping the anon-key write fallback (defeats the lockdown); bumping
Vite 5→8 to clear the esbuild advisory (dev-server-only issue, major breaking
change — see needs-attention).

## 2026-05-20 — Built the Assurance Layer (Phase 7 — features 1, 2, 3)
What: Added a third pillar — the assurance layer — implementing audit-finding
traceability, a composite Assurance Score, and historical exploit-class
backtesting. New artifacts:
- `audit/` — illustrative point-in-time audit report + machine-readable
  `findings.json` (8 findings, each bound to its continuous-assurance layers).
- `test/exploit/` + `script/ExploitReplay.s.sol` — 7 exploit-class replays
  (EXP-01..07), each classified PREVENTED / DETECTED / MISSED. Result: 6
  PREVENTED, 1 DETECTED (`attack()`), 0 MISSED.
- `assurance/` — a new TypeScript package (sibling of `guardian/`/`dashboard/`)
  with the traceability resolver, the score engine, and the `assurance` CLI
  (`report` / `trace` / `check`). 22 `node:test` unit tests.
- 3 new dashboard panels: AssuranceScore, TraceabilityMatrix, ExploitReplay.
- New `assurance` CI job gating on no MISSED exploit and score >= 80.
Current score: 92/100, grade A- (Continuous Monitoring component unavailable —
see needs-attention). Spec: `07_assurance_layer.md`.
Why: The project's two cited papers argue for continuous, multi-layered
assurance and note static audits lack runtime evidence; this layer makes the
project measure and demonstrate that thesis rather than only embody it.
Rejected: A Supabase migration for assurance data (kept it JSON-artifact-based
so no DB migration / deploy is needed); a JS test-runner dependency (used the
built-in `node:test`).
Note: `src/Vault.sol` was hardened by a concurrent session mid-build (added
`ReentrancyGuard` + a `block.chainid` mainnet backstop on `attack()`). The
assurance layer was reconciled against the final code — `audit/findings.json`
GUA-01 is now status `Mitigated`, GUA-02 status `Resolved`, and all `location`
line numbers were corrected. All 31 Foundry tests still pass.

## Open decisions / needs attention
- ROTATE the Base Sepolia demo key — its plaintext value was exposed in chat
  history this session. Generate a fresh testnet wallet and re-import via
  `cast wallet import guardian-demo --interactive`; update `ATTACKER_ADDRESS`
  and redeploy if needed.
- `guardian/.env` `SUPABASE_SERVICE_KEY` is blank — bot will not start until
  the service-role key is pasted in (Supabase dashboard > Settings > API).
- Run `supabase/migrations/0002_lockdown_insert_rls.sql` against the live
  `klbqkgyyqkmqoebxbawy` project to remove the open insert policies.
- `dashboard` has 2 moderate npm audit findings (esbuild GHSA-67mh-4wv8-2f99,
  dev-server only). Fix requires Vite 5→8 — deferred as a breaking change; not
  exploitable in the deployed static build.
- README badge/clone URLs use `rahilbhavan/guardian-pipeline` as a placeholder
  — replace with the real GitHub path once the repo is created.
- `YOUR_LOOM_URL` and `YOUR_VERCEL_URL` in the README are placeholders.
- `docs/counterexample.png` must be captured manually (see `docs/README.md`).
- GitHub secrets `BASE_SEPOLIA_RPC` / `BASE_MAINNET_RPC` must be set for CI.
- Assurance Score's Continuous Monitoring component reads `blocks_checked` via
  `guardian/.env` — currently unavailable because the Supabase key there is
  blank, so the score (92, A-) is computed over 3 of 4 layers. Populate the key
  and run the Guardian to light up the 4th layer.
- If `src/Vault.sol` changes, re-run `cd assurance && npm run report` and review
  `audit/findings.json` — `location` line numbers and GUA-01/GUA-02 status are
  pinned to the current source and may need updating.
