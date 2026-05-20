-- Guardian Pipeline — Supabase schema
-- Run in the Supabase SQL editor, or apply via the Supabase CLI.

-- Table: alerts
-- One row per invariant violation event.
create table public.alerts (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  vault        text not null,
  block_number bigint not null,
  block_ts     timestamptz,
  invariant_id text not null,          -- e.g. 'INV-01'
  invariant_name text not null,
  passed       boolean not null default false,
  actual_value text,                   -- stored as text (uint256 exceeds Postgres bigint)
  bound_value  text,
  description  text,
  detection_latency_ms integer
);

-- Table: blocks_checked
-- One row per block the Guardian inspected (for latency + liveness monitoring).
create table public.blocks_checked (
  id              uuid primary key default gen_random_uuid(),
  checked_at      timestamptz not null default now(),
  block_number    bigint not null,
  vault           text not null,
  all_passed      boolean not null,
  latency_ms      integer,
  violations_count integer not null default 0
);

create index alerts_created_at_idx on public.alerts (created_at desc);
create index blocks_checked_checked_at_idx on public.blocks_checked (checked_at desc);

-- Row-level security — public read-only access for the dashboard's anon key.
alter table public.alerts enable row level security;
alter table public.blocks_checked enable row level security;

create policy "Public read alerts"
  on public.alerts for select using (true);

create policy "Public read blocks"
  on public.blocks_checked for select using (true);

-- Writes (inserts) are intentionally NOT granted to anon or authenticated.
-- The Guardian bot must run with the service-role key, which bypasses RLS
-- entirely — so no insert policy is needed for it to write.
--
-- Do NOT add a `with check (true)` insert policy here: the anon key is public
-- (it ships inside the dashboard's browser bundle), so any visitor could then
-- forge invariant violations and fake block-checks straight into these tables.
-- With RLS enabled and no insert policy, anon insert is denied by default.

-- Stream inserts to dashboard subscribers in real time.
alter publication supabase_realtime add table public.alerts;
alter publication supabase_realtime add table public.blocks_checked;
