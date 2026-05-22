# Guardian bot reference

The Guardian bot (`guardian/`) is the runtime half of the pipeline: a
TypeScript daemon that watches a deployed `Vault` on Base L2, re-checks all
six invariants on every block, and persists any violation to Supabase within
one block (~2 s) of the breach.

This document is the module-by-module reference. For the bigger picture see
[architecture.md](architecture.md#layer-3--runtime-guardian); for running it
see [setup.md](setup.md#6-configure-and-start-the-guardian-bot).

---

## At a glance

| | |
|---|---|
| **Language** | TypeScript, strict mode, ESM (`"type": "module"`) |
| **Chain client** | [`viem`](https://viem.sh) — `viem`, never `ethers.js` |
| **RPC** | Alchemy WebSocket (`wss://…g.alchemy.com/v2/<key>`) |
| **Persistence** | Supabase (`@supabase/supabase-js`), service-role key |
| **Logging** | `pino` + `pino-pretty` — structured, never `console.log` |
| **Runtime** | Node ≥ 20. `npm run dev` (tsx) or `npm run build && npm start` (tsup → ESM) |
| **Entry point** | `guardian/src/bot.ts` |

### Module map

```
bot.ts        orchestration — config, clients, block loop, lifecycle
  ├─ fetcher.ts     event scan + one multicall → a VaultState snapshot
  ├─ evaluator.ts   VaultState → 6 InvariantResults  (1:1 mirror of the harness)
  ├─ router.ts      InvariantResults → Supabase rows  (alerts + blocks_checked)
  └─ types.ts       shared interfaces — no logic
```

The bot is intentionally a straight pipeline: **fetch → evaluate → route**, one
pass per block. There is no queue, no retry loop, no in-memory history — the
dashboard derives all history from Supabase.

---

## The per-block lifecycle

`bot.ts` subscribes to new block numbers with `client.watchBlockNumber`. Each
block runs `onBlock`:

```
new block ─▶ re-entrancy guard ─▶ incremental user scan ─▶ fetchVaultState ─▶ evaluateInvariants ─▶ split
              (skip if busy)       (new event addresses)    (1 multicall)        (6 checks)          │
                                                                                                     ├─▶ logBlockCheck   (always)
                                                                                                     └─▶ logAlertToSupabase (if violations)
```

1. **Re-entrancy guard.** A module-level `checking` boolean skips a block if
   the previous check is still running — Base produces blocks every ~2 s, and a
   slow RPC round-trip must never let two checks overlap.
2. **Incremental user scan.** Any addresses that appeared in `Deposited`,
   `Borrowed` or `Liquidated` events since the last checked block are added to
   the known-user set, so the per-user invariants see the exact current actors.
3. **Fetch.** `fetchVaultState` reads the snapshot (one multicall — see below).
4. **Evaluate.** `evaluateInvariants` runs the six checks. Detection latency
   is measured as `Date.now()` before the fetch versus after evaluation.
5. **Route.** `logBlockCheck` writes one `blocks_checked` row for *every*
   block (liveness + latency history). If any invariant failed,
   `logAlertToSupabase` writes one `alerts` row per violation.
6. **Always finish.** A `finally` block clears `checking`; a `try/catch` around
   the whole body logs and swallows any error so one bad block never kills the
   daemon.

---

## `bot.ts`

The orchestrator. Responsibilities:

### Configuration — `loadConfig()`

Reads and validates the environment, returning a fully-resolved
[`BotConfig`](#typests). It **throws at startup** — the bot never runs
partially configured.

| Variable | Required | Purpose |
|----------|----------|---------|
| `ALCHEMY_KEY` | yes | Alchemy API key; interpolated into the WebSocket URL. |
| `VAULT_ADDRESS` | yes | Deployed vault. Validated against `/^0x[0-9a-fA-F]{40}$/`. |
| `TOKEN_ADDRESS` | yes | The vault's ERC-20 asset. Same address validation. |
| `SUPABASE_URL` | yes | Supabase project URL. |
| `SUPABASE_SERVICE_KEY` | yes | **Service-role** key — bypasses RLS so the bot can insert. |
| `VAULT_DEPLOY_BLOCK` | no | Block the vault was deployed at — the start of the event scan that seeds the user set. Defaults to `0`. |
| `BLOCK_POLL_INTERVAL_MS` | no | Block poll interval; defaults to `2000`. |
| `CHAIN` | no | `base-sepolia` (default) or `base`. Selects the Alchemy host and viem chain. |

Address-shaped variables are regex-checked up front, so a typo fails fast with
a clear message instead of surfacing as an obscure RPC error on every block.

> **Why the service-role key?** Supabase RLS grants `select` to everyone but
> grants `insert` to no one (see [database.md](database.md#row-level-security)).
> The service-role key bypasses RLS, so only the server-side bot can write.
> The public anon key — which ships in the dashboard's browser bundle — cannot
> forge alerts. Keep `SUPABASE_SERVICE_KEY` server-side only.

### Startup preflight

Before watching blocks, `main()` runs three checks and logs the outcome of
each, so a misconfiguration is obvious immediately rather than per-block:

| Check | On failure |
|-------|------------|
| `getBlockNumber()` | RPC is unreachable — startup throws. |
| `getCode(VAULT_ADDRESS)` | No bytecode at the address — logs a `warn`; the bot still starts (the address may deploy later). |
| `select` from `blocks_checked` | Supabase unreachable — logs a `warn`; the bot still starts. |

A healthy start logs, in order: `RPC connection OK`, `Vault contract verified
on-chain`, `Supabase connection OK`, `Guardian live — watching Base blocks`.

### User-set seeding

After the preflight, `main()` scans the vault's full event history — from
`VAULT_DEPLOY_BLOCK` to the current head — with `discoverUsers`, seeding the
known-user set with every address that has ever deposited, borrowed, or taken
part in a liquidation. The per-user invariants (INV-02, INV-03, INV-06) are
checked against this set; an incremental scan each block keeps it current.

### Lifecycle

`watchBlockNumber` is started with `emitOnBegin: true` (so the first check
happens immediately, not after one interval). `SIGINT` and `SIGTERM` handlers
call the returned `unwatch()` and exit cleanly. A startup crash is caught by
the top-level `main().catch(...)`, logged at `fatal`, and exits non-zero.

---

## `fetcher.ts`

Turns a block number into a [`VaultState`](#typests) snapshot, and discovers
the users that snapshot must cover.

- **Event-driven user discovery.** `discoverUsers` scans the vault's
  `Deposited`, `Borrowed` and `Liquidated` logs between two blocks and returns
  every address that has ever held a position — depositors, borrowers, and
  liquidation beneficiaries. The bot seeds this set from full history at
  startup and tops it up incrementally each block.
- **One RPC round-trip per block.** The six aggregate vault reads
  (`totalSupplyAssets`, `totalSupplyShares`, `totalBorrowShares`,
  `totalBorrowed`, `borrowIndex`, `collateralRatio`) plus the vault's ERC-20
  `balanceOf`, plus two reads (`userSupplyShares`, `userBorrowShares`) per
  discovered user, are batched into a single `client.multicall({ allowFailure:
  false, blockNumber, contracts: [...] })`. `allowFailure: false` means any
  failed sub-call rejects the whole call — a partial snapshot is never
  evaluated.
- **Pinned to `blockNumber`.** Every read is taken at the exact block the
  subscription delivered, so the snapshot is internally consistent.
- **Minimal ABIs.** `VAULT_ABI` declares only the view getters and events the
  bot reads; `ERC20_ABI` declares only `balanceOf`. Smaller ABIs, smaller
  surface.
- `blockTimestamp` is the block's own timestamp, fetched alongside the
  multicall — used for the `alerts.block_ts` column.

---

## `evaluator.ts`

The heart of the project's thesis: a **1:1 mirror** of the Solidity
`invariant_*` functions in `test/invariant/InvariantVault.t.sol`. The property
fuzzed before deployment is the same property monitored after it — and because
the fetcher reads the *exact* per-user positions discovered from vault events,
the share-sum and uncollateralised-debt checks are genuine 1:1 mirrors, not
sampled approximations.

`evaluateInvariants(state)` returns six [`InvariantResult`](#typests) objects
in `INV-01`…`INV-06` order. Each `inv0N` function is pure — same state in, same
result out.

| Fn | Invariant | Check |
|----|-----------|-------|
| `inv01` | Protocol solvency | `cash + totalBorrowed >= totalSupplyAssets` |
| `inv02` | Supply-share integrity | `totalSupplyShares === Σ userSupplyShares` |
| `inv03` | Debt-share integrity | `totalBorrowShares === Σ userBorrowShares` |
| `inv04` | Lender-value floor | `totalSupplyAssets >= totalSupplyShares` |
| `inv05` | Interest-index floor | `borrowIndex >= 1e18` |
| `inv06` | No uncollateralised debt | no account with `supplyShares === 0` holds `borrowShares > 0` |

How the per-user checks work:

- **INV-02 / INV-03** sum `supplyShares` (resp. `borrowShares`) across every
  user in the fetched `VaultState.users` array and compare to the on-chain
  aggregate. The user array is the exact set the fetcher discovered from
  `Deposited` / `Borrowed` / `Liquidated` events, so the sum identity is
  evaluated against the real population, not a proxy.
- **INV-06** filters the same user array for any account holding zero supply
  shares yet non-zero borrow shares; `actualValue` reports the count of
  offending accounts, which must be `0`.

All arithmetic uses native `bigint` (`1_000_000_000_000_000_000n`) — no
floating point, so the maths matches the EVM's exactly.

---

## `router.ts`

Persists results to Supabase. Two exported functions, one rule:

> **A monitor must never crash on its own alert path.** Every database call is
> wrapped in `try/catch`; failures are logged and swallowed. A Supabase outage
> degrades the bot to detect-but-don't-persist — it never takes the daemon down.

### `logAlertToSupabase(supabase, payload, logger)`

Maps each violation in the payload to one row and bulk-inserts them into
`alerts`. `uint256` values (`actualValue`, `boundValue`) are stored as **text**
— they exceed Postgres `bigint` range. `blockNumber` is narrowed to `Number`
for the `bigint`-typed `block_number` column (safe for any realistic block
height). On success it logs the row count; on error it logs and returns.

### `logBlockCheck(supabase, params, logger)`

Inserts exactly one `blocks_checked` row per block — pass *or* fail — recording
`all_passed`, `latency_ms`, and `violations_count`. This is what gives the
dashboard its liveness indicator and latency sparkline. In `bot.ts` it is
called with `void` (fire-and-forget): block-check bookkeeping must never delay
evaluation of the next block.

See [database.md](database.md) for the full column reference.

---

## `types.ts`

Shared interfaces only — no logic.

| Type | Purpose |
|------|---------|
| `InvariantId` | String-literal union `'INV-01'`…`'INV-06'`. |
| `UserPosition` | One account's per-user position: `address`, `supplyShares`, `borrowShares`. |
| `VaultState` | One block's snapshot: the six aggregate vault reads, `cash`, the `users` array, `blockNumber`, `blockTimestamp`. |
| `InvariantResult` | One invariant's outcome: `id`, `name`, `passed`, `actualValue`, `boundValue`, `description`. |
| `AlertPayload` | A bundle of violations plus `blockNumber`, `timestamp`, `detectedAt`, `detectionLatencyMs`, ready to persist. |
| `BotConfig` | Fully-resolved, validated runtime config returned by `loadConfig()`. |

---

## Operational notes

- **Detection latency** = wall-clock ms from *before* the state fetch to
  *after* evaluation. It is dominated by the RPC round-trip; evaluation itself
  is sub-millisecond. It is written to both tables and charted on the dashboard.
- **No historical backfill.** The bot only sees blocks that arrive while it is
  running. To monitor a vault from genesis you would replay past blocks — out
  of scope for the MVP.
- **One vault per process.** `VAULT_ADDRESS` is singular. Monitoring several
  vaults means several processes (or a refactor to a vault list).
- **`npm start` vs `npm run dev`.** `dev` runs the TypeScript directly via
  `tsx watch`. `start` runs the compiled `dist/bot.js`; if `dist/` is stale,
  rebuild with `npm run build` first.

---

## Related documents

- [architecture.md](architecture.md) — where the bot sits among the four layers.
- [contracts.md](contracts.md) — the `Vault` state the bot reads.
- [invariants.md](invariants.md) — the six invariants and which layer enforces each.
- [database.md](database.md) — the Supabase tables the bot writes.
- [setup.md](setup.md) — configuring and running the bot.
</content>
