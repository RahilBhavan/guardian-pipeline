/**
 * bot.ts — Guardian entry point.
 *
 * Subscribes to new Base L2 blocks, fetches vault state, evaluates all six
 * invariants, and persists any violation to Supabase — typically within one
 * block (~2s) of the breach — where the dashboard surfaces it in real time.
 *
 * Operational surface:
 *   - /healthz + /metrics on HEALTH_PORT (see health.ts).
 *   - RPC circuit breaker: opens after BREAKER_OPEN_AT consecutive block-check
 *     failures, suppresses fetches while open, probes the RPC every
 *     BREAKER_PROBE_INTERVAL_MS, closes after two consecutive probe successes.
 *   - DB-insert escalation lives in router.ts and reports through the same
 *     shared GuardianState.
 */
import 'dotenv/config';
import { createPublicClient, webSocket, type Chain, type PublicClient } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import pino from 'pino';
import { createClient } from '@supabase/supabase-js';
import { discoverUsers, fetchVaultState } from './fetcher.js';
import { evaluateInvariants } from './evaluator.js';
import { logAlertToSupabase, logBlockCheck } from './router.js';
import { createGuardianState, startHealthServer, type GuardianState } from './health.js';
import type { AlertPayload, BotConfig } from './types.js';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: { target: 'pino-pretty', options: { translateTime: 'SYS:standard' } },
});

/**
 * Read, validate and resolve runtime configuration from the environment.
 * Throws immediately if a required variable is missing — the bot never
 * starts in a partially-configured state.
 */
function loadConfig(): BotConfig {
  const required = [
    'ALCHEMY_KEY',
    'VAULT_ADDRESS',
    'DEBT_ASSET',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_KEY',
  ];
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
  }

  // Validate address-shaped vars up front so a typo fails at startup with a
  // clear message, not as an obscure RPC error on every block.
  const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
  for (const key of ['VAULT_ADDRESS', 'DEBT_ASSET']) {
    if (!ADDRESS_RE.test(process.env[key] as string)) {
      throw new Error(`Invalid ${key}: expected a 0x-prefixed 40-hex-character address`);
    }
  }

  const chain = (process.env.CHAIN ?? 'base-sepolia') as 'base-sepolia' | 'base';
  const alchemyHost = chain === 'base' ? 'base-mainnet' : 'base-sepolia';
  const rpcUrl = `wss://${alchemyHost}.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}`;

  // The bot writes alerts and block-checks, so it requires the service-role key.
  // RLS denies inserts to the anon key (see supabase/migrations) — the anon key
  // is public and must never be trusted for writes. The service-role key
  // bypasses RLS and must be kept secret (server-side env only, never shipped
  // to the browser).
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY as string;

  return {
    rpcUrl,
    vaultAddress: process.env.VAULT_ADDRESS as `0x${string}`,
    debtAsset: process.env.DEBT_ASSET as `0x${string}`,
    deployBlock: BigInt(process.env.VAULT_DEPLOY_BLOCK ?? '0'),
    supabaseUrl: process.env.SUPABASE_URL as string,
    supabaseKey,
    blockPollIntervalMs: Number(process.env.BLOCK_POLL_INTERVAL_MS ?? 2000),
    chain,
  };
}

/**
 * Operational env knobs not exposed on BotConfig — they only matter to the
 * runtime surface (health server + circuit breaker), not to the on-chain or
 * persistence layer.
 */
function loadOpsConfig(): {
  healthPort: number;
  maxHealthyBlocks: number;
  breakerOpenAt: number;
  breakerProbeIntervalMs: number;
} {
  return {
    healthPort: Number(process.env.HEALTH_PORT ?? 9090),
    maxHealthyBlocks: Number(process.env.MAX_HEALTHY_BLOCKS ?? 30),
    breakerOpenAt: Number(process.env.BREAKER_OPEN_AT ?? 10),
    breakerProbeIntervalMs: Number(process.env.BREAKER_PROBE_INTERVAL_MS ?? 30_000),
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const ops = loadOpsConfig();
  logger.info(
    { chain: config.chain, vault: config.vaultAddress, supabaseAuth: 'service-role' },
    'Guardian starting',
  );

  // Widen to `Chain` so the client type does not become a chain-specific union.
  const chain: Chain = config.chain === 'base' ? base : baseSepolia;
  const client: PublicClient = createPublicClient({
    chain,
    transport: webSocket(config.rpcUrl),
  });

  const supabase = createClient(config.supabaseUrl, config.supabaseKey);

  // Shared mutable state — every counter and gauge the health server exposes
  // lives here; bot.ts + router.ts mutate it in place. Created before the
  // preflight so its observability is live even during slow startups.
  const state: GuardianState = createGuardianState({
    blockPollIntervalMs: config.blockPollIntervalMs,
    maxHealthyBlocks: ops.maxHealthyBlocks,
  });

  const healthServer = await startHealthServer(state, logger, ops.healthPort);

  // Preflight — fail fast (or warn loudly) instead of logging an obscure error
  // on every block when the RPC, vault address, or database is misconfigured.
  const headBlock = await client.getBlockNumber();
  logger.info({ blockNumber: headBlock.toString() }, 'RPC connection OK');

  const code = await client.getCode({ address: config.vaultAddress });
  if (!code || code === '0x') {
    logger.warn(
      { vault: config.vaultAddress },
      'No contract code at VAULT_ADDRESS — verify the address; per-block reads will fail until corrected',
    );
  } else {
    logger.info('Vault contract verified on-chain');
  }

  const { error: dbError } = await supabase.from('blocks_checked').select('id').limit(1);
  if (dbError) {
    logger.warn({ error: dbError.message }, 'Supabase reachability check failed — alerts may not persist');
  } else {
    logger.info('Supabase connection OK');
  }

  // Seed the user set from every vault event since deployment. INV-02/03/06 are
  // checked against this set, kept current by an incremental scan each block.
  const knownUsers = new Set<`0x${string}`>();
  for (const user of await discoverUsers(client, config.vaultAddress, config.deployBlock, headBlock)) {
    knownUsers.add(user);
  }
  let lastScannedBlock = headBlock;
  logger.info({ users: knownUsers.size }, 'Seeded user set from vault history');

  // Prevent overlapping checks if a block arrives before the previous finishes.
  let checking = false;

  // Track consecutive block-check failures so a persistently dead RPC escalates
  // instead of spamming the same error every block. The thresholds re-log at
  // a widening cadence — first failure is loud, subsequent failures are quiet
  // until a milestone is hit. On the first success after a failure run, log a
  // recovery line so the operator sees the gap closed.
  const FAILURE_ESCALATION_THRESHOLDS = new Set([1, 5, 25, 100, 500]);

  // ---- Circuit breaker ----------------------------------------------------
  //
  // Once block-check failures cross `breakerOpenAt`, open the breaker: the
  // block subscription stops calling fetch/evaluate and we instead poll a
  // single cheap RPC call (`getBlockNumber`) every `probeIntervalMs`. Two
  // consecutive successful probes close the breaker; one failure resets the
  // success count. Only one probe is in flight at a time. While open, the
  // bot does not spam a dead RPC every block — the SRE called that out as
  // the headline missing behaviour and it is mirrored in `breakerState`.
  let probing = false;
  let probeTimer: NodeJS.Timeout | null = null;
  let probeSuccesses = 0;

  function openBreaker(reason: 'failure_threshold' | 'probe_failed'): void {
    if (state.breakerState === 'open') return;
    state.breakerState = 'open';
    state.circuitBreakerOpen = 1;
    probeSuccesses = 0;
    logger.error(
      {
        reason,
        consecutiveFailures: state.consecutiveBlockCheckFailures,
        probeIntervalMs: ops.breakerProbeIntervalMs,
      },
      'RPC circuit breaker OPEN — block checks suppressed; probing for recovery',
    );
    scheduleProbe();
  }

  function closeBreaker(): void {
    if (state.breakerState === 'closed') return;
    state.breakerState = 'closed';
    state.circuitBreakerOpen = 0;
    probeSuccesses = 0;
    if (probeTimer) {
      clearTimeout(probeTimer);
      probeTimer = null;
    }
    logger.info('RPC circuit breaker CLOSED — resuming normal block checks');
  }

  function scheduleProbe(): void {
    if (probeTimer) return;
    probeTimer = setTimeout(() => {
      probeTimer = null;
      void probeRpc();
    }, ops.breakerProbeIntervalMs);
  }

  async function probeRpc(): Promise<void> {
    if (probing || state.breakerState === 'closed') return;
    probing = true;
    try {
      await client.getBlockNumber();
      probeSuccesses += 1;
      logger.info({ probeSuccesses }, 'Circuit-breaker probe succeeded');
      if (probeSuccesses >= 2) {
        closeBreaker();
        return;
      }
    } catch (err) {
      probeSuccesses = 0;
      logger.warn({ err }, 'Circuit-breaker probe failed — staying open');
    } finally {
      probing = false;
    }
    if (state.breakerState === 'open') scheduleProbe();
  }

  async function onBlock(blockNumber: bigint): Promise<void> {
    // Breaker open — do not hammer the RPC. The probe loop is the only
    // outbound RPC traffic until it closes.
    if (state.breakerState === 'open') {
      logger.debug({ block: blockNumber.toString() }, 'Skipping block — circuit breaker open');
      return;
    }
    if (checking) {
      logger.debug({ block: blockNumber.toString() }, 'Skipping block — previous check still running');
      return;
    }
    checking = true;
    const startedAt = Date.now();
    state.blockChecksTotal += 1;

    try {
      // Pick up any accounts that appeared since the last checked block.
      if (blockNumber > lastScannedBlock) {
        const fresh = await discoverUsers(
          client,
          config.vaultAddress,
          lastScannedBlock + 1n,
          blockNumber,
        );
        for (const user of fresh) knownUsers.add(user);
        lastScannedBlock = blockNumber;
      }

      const vaultState = await fetchVaultState(
        client,
        config.vaultAddress,
        config.debtAsset,
        blockNumber,
        [...knownUsers],
      );
      const results = evaluateInvariants(vaultState);
      const violations = results.filter((r) => !r.passed);
      const detectionLatencyMs = Date.now() - startedAt;

      // Record every checked block so the dashboard can show latency + liveness.
      void logBlockCheck(
        supabase,
        {
          vaultAddress: config.vaultAddress,
          blockNumber,
          allPassed: violations.length === 0,
          latencyMs: detectionLatencyMs,
          violationsCount: violations.length,
        },
        logger,
        state,
      );

      if (violations.length > 0) {
        logger.error(
          {
            block: blockNumber.toString(),
            violations: violations.map((v) => v.id),
            detectionLatencyMs,
          },
          'INVARIANT VIOLATION DETECTED',
        );

        for (const v of violations) state.violationsDetectedTotal[v.id] += 1;

        const payload: AlertPayload = {
          vaultAddress: config.vaultAddress,
          blockNumber,
          timestamp: vaultState.blockTimestamp,
          violations,
          detectedAt: Date.now(),
          detectionLatencyMs,
        };

        await logAlertToSupabase(supabase, payload, logger, state);
      } else {
        logger.debug(
          { block: blockNumber.toString(), allPassed: true, detectionLatencyMs },
          'All invariants healthy',
        );
      }

      // Success: update health gauges and reset failure counters.
      state.blockCheckLatencyMs = detectionLatencyMs;
      state.lastBlockChecked = Number(blockNumber);
      state.lastBlockCheckedAt = new Date().toISOString();

      if (state.consecutiveBlockCheckFailures > 0) {
        logger.info(
          {
            recoveredAfter: state.consecutiveBlockCheckFailures,
            block: blockNumber.toString(),
          },
          'Block checks recovered after consecutive failures',
        );
        state.consecutiveBlockCheckFailures = 0;
      }
    } catch (err) {
      state.consecutiveBlockCheckFailures += 1;
      state.blockChecksFailedTotal += 1;
      const n = state.consecutiveBlockCheckFailures;
      const escalate = FAILURE_ESCALATION_THRESHOLDS.has(n);
      const fields = { err, block: blockNumber.toString(), consecutiveFailures: n };
      if (escalate) {
        logger.error(
          fields,
          `Block check failed (${n} consecutive — investigate RPC/network)`,
        );
      } else {
        logger.debug(fields, 'Block check failed');
      }
      if (n >= ops.breakerOpenAt && state.breakerState === 'closed') {
        openBreaker('failure_threshold');
      }
    } finally {
      checking = false;
    }
  }

  const unwatch = client.watchBlockNumber({
    pollingInterval: config.blockPollIntervalMs,
    emitOnBegin: true,
    onBlockNumber: (blockNumber) => {
      void onBlock(blockNumber);
    },
    onError: (err) => logger.error({ err }, 'Block subscription error'),
  });

  logger.info('Guardian live — watching Base blocks');

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Guardian shutting down');
    if (probeTimer) {
      clearTimeout(probeTimer);
      probeTimer = null;
    }
    unwatch();
    // Close health server first so probes stop hitting a daemon that is
    // tearing down its RPC client.
    healthServer.close(() => {
      process.exit(0);
    });
    // Belt-and-braces: if close() hangs (held-open keep-alive sockets), exit
    // after a short grace period.
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Guardian crashed during startup');
  process.exit(1);
});
