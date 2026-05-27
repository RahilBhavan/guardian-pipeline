-- Guardian Pipeline — alert + block-check idempotency
--
-- Without a unique constraint, a bot restart or transient retry re-inserts
-- the same (vault, block_number, invariant_id) violation N times and inflates
-- the dashboard's alert feed. The router was already retry-safe on the wire,
-- but not idempotent at the row level. This migration closes that gap.
--
-- For `blocks_checked` the conflict key is (vault, block_number) — there is
-- only one inspection result per vault per block, and a re-poll should
-- replace the prior row (e.g. when a future reorg-handling migration adds a
-- `reorged` flag that needs to be updated post-hoc).
--
-- Dedup before constraint: deletes any pre-existing duplicates keeping the
-- oldest row (smallest created_at / checked_at), so the migration is safe
-- to apply on a database that has been collecting duplicates.
--
-- Safe to re-run: every constraint step is `if exists` / `if not exists`.

-- 1. alerts: dedup, then unique
delete from public.alerts a
using public.alerts b
where a.vault = b.vault
  and a.block_number = b.block_number
  and a.invariant_id = b.invariant_id
  and a.created_at > b.created_at;

alter table public.alerts
  drop constraint if exists alerts_vault_block_invariant_unique;
alter table public.alerts
  add  constraint alerts_vault_block_invariant_unique
       unique (vault, block_number, invariant_id);

-- 2. blocks_checked: dedup, then unique
delete from public.blocks_checked a
using public.blocks_checked b
where a.vault = b.vault
  and a.block_number = b.block_number
  and a.checked_at > b.checked_at;

alter table public.blocks_checked
  drop constraint if exists blocks_checked_vault_block_unique;
alter table public.blocks_checked
  add  constraint blocks_checked_vault_block_unique
       unique (vault, block_number);
