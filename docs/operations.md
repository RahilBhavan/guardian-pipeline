# Operations and proof

Guardian remains a portfolio/research demo. The public dashboard is
<https://guardian-pipeline.vercel.app>; it shows a labelled recorded run while the
hosted monitor is retired. Do not label it live until backend readback and recent
`blocks_checked` rows have been verified.

## OpenTelemetry

Set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` to an OTLP/HTTP **JSON** trace receiver
(e.g. `https://collector.example/v1/traces`), or use standard
`OTEL_EXPORTER_OTLP_ENDPOINT` with its `/v1/traces` suffix. Standard
`OTEL_EXPORTER_OTLP_HEADERS` supplies authentication server-side. Set
`OTEL_SERVICE_NAME` if desired. The default is disabled, with no outbound exports.

The daemon exports block-check/startup failure categories, the one-pass runner
exports fatal failures, and HA exports each attempted block transaction and
iteration/startup failures. Exceptions are categorized: raw provider errors may
contain RPC keys, so their text, URLs and position data are not exported. Existing
server-side logs retain diagnostics. Export failure cannot advance a checkpoint.

`npm test --prefix guardian` forces a failure, receives a real OTLP request on a
local HTTP collector, verifies ERROR status and checks that secret-like text was
not sent. This proves exporter wiring, not delivery to a managed external account.

## Two redundant workers

`guardian/src/ha.ts` is the opt-in **transactional worker**. The original daemon
and scheduled single-pass runner remain single-writer entry points: never run
those alongside HA for the same vault. Both HA workers must use the same database,
chain and canonical vault. Use separate databases for different chains because the
existing schema keys observations by vault address only.

```sh
# Server-side environment; never expose DATABASE_URL to the dashboard.
RPC_URL=https://your-archive-capable-base-rpc
DATABASE_URL=postgresql://... # enforce TLS for remote hosts
CHAIN=base-sepolia           # or base; verified against RPC chain ID
VAULT_ADDRESS=0x...
DEBT_ASSET=0x...
VAULT_DEPLOY_BLOCK=...
# Run this command on two hosts with identical env, under your service manager:
cd guardian && npm run ha
# Or after npm run build: npm run start:ha
```

No new migration is needed; apply migrations 0001–0004. A PostgreSQL transaction
advisory lock protects one vault, including reads, evaluation, alerts, block row
and checkpoint. Only a committed block advances the cursor. Standbys retry every
two seconds. If a worker dies or loses its connection, PostgreSQL rolls back and
releases its lock. The other worker starts from the persisted cursor and checks
every intervening block in order. There is no lease to expire while an old worker
is still writing. No gap is silently clamped.

Fresh databases replay from the deployment block, which can be very slow for an
old vault. For an existing checkpoint, validate that its user set was discovered
from **all** history; the old scheduled monitor's bounded LOOKBACK can omit users
on a fresh start or long gap. Never seed a cursor with a truncated user set and
claim full mirror coverage. No reorg reconciliation is implemented. A hung worker
holds its transaction until it disconnects: production operators still need
process supervision, timeouts, health monitoring and managed failover validation.

Proof: initialize a **disposable** PostgreSQL DB with the four migrations and a
`supabase_realtime` publication, then run:

```sh
TEST_DATABASE_URL=postgresql://... make guardian-ha-test
```

The test starts two OS processes with the production lock/transaction code,
kills the lock owner during block 3 and asserts exactly blocks 1–6 and checkpoint
6 exist, including exactly two expected violations at block 4. An injected
checkpoint-write failure also proves alert/block writes roll back together.
It uses fixture snapshots, not RPC snapshots. CI provides an isolated
PostgreSQL service; never point this test at a live project.

## Restore the hosted demo

1. Connect Supabase and create/select the replacement demo project. Apply the
   existing migrations 0001–0004 and check RLS. Public keys may read alert/block
   tables, may not insert, and may not read `vault_state_previous`.
2. Set Actions variable `SUPABASE_URL`, secret `SUPABASE_SERVICE_KEY`, and a valid
   `ALCHEMY_KEY`. Remove/replace credentials for the deleted project.
3. Bootstrap **complete** historical user discovery before enabling the old
   scheduled runner, or deploy two HA workers on a persistent host with a complete
   checkpoint. The public shared AttackableVault may already be attacked; only
   its operator may stage `attack()` or deploy a replacement.
4. For the scheduled option restore `schedule: [{cron: '*/5 * * * *'}]`, enable the
   Guardian Monitor workflow, and verify three actual scheduled runs each write
   a recent row. GitHub scheduling is best effort, not a per-block daemon.
5. Set Vercel `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and
   `VITE_GUARDIAN_LIVE=true`, rebuild/deploy, and verify a recent block from the
   browser. Keep the recorded mode until this is verified.

No replacement Supabase project, hosted collector or two-host deployment has been
verified by the local tests. Keep issue #47's external acceptance checks open
until actual account and runtime evidence is available.
