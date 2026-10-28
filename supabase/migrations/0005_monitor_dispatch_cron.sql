-- Guardian — Scheduled Monitor Trigger
-- GitHub runs the Guardian Monitor's own `*/5` schedule hours late on this
-- repository, so the monitor falls behind 0.2 s Base Sepolia blocks. pg_cron
-- starts the workflow through GitHub's workflow-dispatch API every 5 minutes.
--
-- Before this job can succeed, store a fine-grained GitHub token with only
-- Actions read/write on this repository in Supabase Vault (never in git):
--   select vault.create_secret('<token>', 'github_monitor_dispatch_token');
-- Check deliveries with:
--   select status_code, created from net._http_response order by created desc limit 5;

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net;

select cron.schedule('guardian-monitor-dispatch', '*/5 * * * *', $job$
  select net.http_post(
    url := 'https://api.github.com/repos/RahilBhavan/guardian-pipeline/actions/workflows/guardian-monitor.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                     where name = 'github_monitor_dispatch_token'),
      'Accept', 'application/vnd.github+json',
      'User-Agent', 'guardian-pipeline-cron',
      'X-GitHub-Api-Version', '2022-11-28'),
    body := '{"ref":"main"}'::jsonb)
$job$);
