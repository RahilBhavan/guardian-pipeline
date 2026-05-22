# Database reference

Guardian Pipeline uses one Supabase (Postgres) project as the boundary between
the bot and the dashboard. The bot **writes**, the dashboard **reads**, and
Postgres real-time pushes every insert to the dashboard with no polling.

This document is the schema reference. The migrations live in
[`supabase/migrations/`](../supabase/migrations); applying them is covered in
[setup.md](setup.md#5-provision-supabase).

---

## Why a database at all?

The bot and the dashboard are separate processes — often on separate machines.
Supabase gives the project three things at once:

1. **Durable history.** Every checked block and every violation is persisted,
   so the dashboard can render latency trends and an alert feed even after a
   restart.
2. **Real-time fan-out.** Postgres logical replication streams new rows to the
   dashboard over a WebSocket — an alert appears the instant the bot inserts it.
3. **A trust boundary.** Row-level security lets the dashboard read with a
   public key while making writes impossible for anyone but the bot.

---

## Tables

### `alerts`

One row per invariant violation. The bot inserts a batch (one row per failed
invariant) whenever a block fails.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` | Primary key, `gen_random_uuid()`. |
| `created_at` | `timestamptz` | Insert time, `now()`. Drives the dashboard's "most recent" ordering. |
| `vault` | `text` | The monitored vault address. |
| `block_number` | `bigint` | Block at which the violation was observed. |
| `block_ts` | `timestamptz` | Wall-clock time of the state read (nullable). |
| `invariant_id` | `text` | e.g. `INV-01`. |
| `invariant_name` | `text` | e.g. `Protocol solvency`. |
| `passed` | `boolean` | Always `false` for an alert row (default `false`). |
| `actual_value` | `text` | The observed value. **Stored as text** — `uint256` exceeds Postgres `bigint`. |
| `bound_value` | `text` | The bound it violated, also text. |
| `description` | `text` | Human-readable statement of the invariant. |
| `detection_latency_ms` | `integer` | Fetch-to-evaluation latency for the block. |

**Index:** `alerts_created_at_idx` on `(created_at desc)` — the dashboard's
alert feed queries newest-first.

> **Why `text` for numbers?** A Solidity `uint256` can hold values far larger
> than Postgres `bigint` (`2^63 − 1`). Storing `actual_value` / `bound_value`
> as text preserves them exactly; the dashboard parses them with `BigInt` when
> it needs to compare or format.

### `blocks_checked`

One row per block the Guardian inspected — pass *or* fail. This is the
liveness and latency log.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` | Primary key, `gen_random_uuid()`. |
| `checked_at` | `timestamptz` | Insert time, `now()`. |
| `block_number` | `bigint` | The inspected block. |
| `vault` | `text` | The monitored vault address. |
| `all_passed` | `boolean` | `true` if all six invariants held. |
| `latency_ms` | `integer` | Fetch-to-evaluation latency (nullable). |
| `violations_count` | `integer` | Number of failed invariants this block (default `0`). |

**Index:** `blocks_checked_checked_at_idx` on `(checked_at desc)`.

The dashboard uses this table two ways: the latest row's `checked_at` proves
the bot is **alive**, and the recent `latency_ms` series feeds the latency
**sparkline**.

---

## Row-level security

RLS is the project's write-side trust boundary. Both tables have RLS
**enabled**, with exactly two policies:

```sql
create policy "Public read alerts"  on public.alerts          for select using (true);
create policy "Public read blocks"  on public.blocks_checked  for select using (true);
```

- **`select` is public.** The dashboard reads with the Supabase **anon** key.
  That key ships inside the browser bundle, so it must only ever be trusted for
  reads.
- **`insert` is granted to no one.** There is no insert policy. With RLS
  enabled, an operation with no matching policy is **denied by default** — so
  the anon key cannot write.
- **The bot bypasses RLS.** The Guardian runs with the **service-role** key,
  which bypasses RLS entirely. It needs no insert policy to write.

> **The attack this prevents.** If an insert policy granted `with check (true)`,
> anyone holding the public anon key — i.e. any dashboard visitor — could forge
> invariant violations and fake block-checks straight into the tables,
> destroying the integrity of the monitoring record. The schema comments in
> `0001_init.sql` call this out explicitly so nobody re-adds such a policy.

---

## Real-time

Both tables are added to the `supabase_realtime` publication:

```sql
alter publication supabase_realtime add table public.alerts;
alter publication supabase_realtime add table public.blocks_checked;
```

This makes Postgres stream every `insert` to subscribed clients. The dashboard
(`dashboard/src/App.tsx`) loads both tables once on mount, then opens real-time
subscriptions — so a new alert reaches the screen the moment the bot commits
it, with no page refresh and no polling.

---

## Migrations

Apply them **in order**, either in the Supabase SQL editor or via the Supabase
CLI.

| File | Purpose |
|------|---------|
| `0001_init.sql` | Creates `alerts` and `blocks_checked`, their indexes, enables RLS with the two public-read policies, and adds both tables to the real-time publication. |
| `0002_lockdown_insert_rls.sql` | Remediation migration. `drop policy if exists` for any public insert policy left by an earlier schema version. Safe to run on a fresh database — `if exists` makes it a no-op there. |

`0002` exists because an earlier draft of `0001` granted public
`insert with check (true)` policies. Any database provisioned from that draft
must run `0002` to lock writes back down to the service-role key. The current
`0001` never creates those policies, so on a fresh setup `0002` simply
confirms there is nothing to remove.

---

## Data flow

```
Guardian bot ──(service-role key, INSERT)──▶  alerts
                                              blocks_checked
                                                  │
                                          Postgres real-time
                                                  │
Dashboard  ◀──(anon key, SELECT + subscribe)──────┘
```

| Component | Key | Operations |
|-----------|-----|------------|
| Guardian bot | service-role | `insert` into both tables |
| Dashboard | anon (public) | `select` + real-time `subscribe` on both tables |

---

## Related documents

- [guardian-bot.md](guardian-bot.md#routerts) — how the bot writes these rows.
- [architecture.md](architecture.md#layer-3--runtime-guardian) — the bot/database/dashboard flow.
- [setup.md](setup.md#5-provision-supabase) — provisioning the project.
</content>
