-- Guardian — Vault State History
-- Persists the most recent {VaultState} observation per vault so the
-- delta invariants INV-07 (solvencyMonotone) and INV-09
-- (debtMonotoneUnderAccrual) have a prior snapshot to compare against
-- across bot restarts.
--
-- Single row per vault, overwritten on every block. The dashboard does
-- not read this table; it exists purely so the bot can survive a restart
-- without losing one block of delta coverage. RLS is enabled with no
-- policies, so anon and authenticated keys cannot read the per-user
-- positions — only the service-role key (which the bot uses) can.

create table public.vault_state_previous (
  vault                  text primary key,
  block_number           bigint not null,
  block_ts               bigint not null,           -- unix seconds; bigint matches the on-chain timestamp domain
  cash                   text not null,             -- uint256 as text, mirrors public.alerts.actual_value
  total_supply_assets    text not null,
  total_supply_shares    text not null,
  total_borrow_shares    text not null,
  total_borrowed         text not null,
  borrow_index           text not null,
  collateral_ratio       text not null,
  last_accrual_time      text not null,
  liquidation_bonus      text not null,
  max_staleness          text not null,
  oracle_last_updated_at text not null,
  users_jsonb            jsonb not null,            -- [{address, supplyShares, borrowShares, collateral}] as text-encoded uint256
  updated_at             timestamptz not null default now()
);

-- The guardian writes with the service-role key (bypasses RLS). Per-user
-- positions are not public — keep them off the anon API. With RLS on and
-- no policy, anon/authenticated select is denied.
alter table public.vault_state_previous enable row level security;
