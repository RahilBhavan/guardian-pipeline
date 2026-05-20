-- Guardian Pipeline — RLS lockdown
--
-- Remediation for databases provisioned with an earlier version of
-- 0001_init.sql, which granted public `insert with check (true)` policies on
-- both tables. Because the anon key is public (it ships in the dashboard's
-- browser bundle), those policies let any visitor forge invariant violations
-- and fake block-checks. This migration removes them.
--
-- After this runs, only the service-role key can write (it bypasses RLS).
-- Run the Guardian bot with SUPABASE_SERVICE_KEY. The dashboard keeps working:
-- the public SELECT policies are left untouched, so anon reads still succeed.
--
-- Safe to run on a fresh database too — `if exists` makes it a no-op there.

drop policy if exists "Guardian insert alerts" on public.alerts;
drop policy if exists "Guardian insert blocks" on public.blocks_checked;
