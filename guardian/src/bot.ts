/**
 * bot.ts — Guardian entry point.
 *
 * Subscribes to new Base L2 blocks, fetches vault state, evaluates all eight
 * invariants, and routes any violation to Discord and Supabase — typically
 * within one block (~2s) of the breach.
 */
import 'dotenv/config';
import { createPublicClient, webSocket, type Chain, type PublicClient } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import pino from 'pino';
import { createClient } from '@supabase/supabase-js';
import { fetchVaultState } from './fetcher.js';
import { evaluateInvariants } from './evaluator.js';
import { sendDiscordAlert, logAlertToSupabase, logBlockCheck } from './router.js';
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
    'TOKEN_ADDRESS',
    'DISCORD_WEBHOOK_URL',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_KEY',
  ];
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
  }

  // Validate address-shaped vars up front so a typo fails at startup with a
  // clear message, not as an obscure RPC error on every block.
  const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
  for (const key of ['VAULT_ADDRESS', 'TOKEN_ADDRESS']) {
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
    tokenAddress: process.env.TOKEN_ADDRESS as `0x${string}`,
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL as string,
    supabaseUrl: process.env.SUPABASE_URL as string,
    supabaseKey,
    blockPollIntervalMs: Number(process.env.BLOCK_POLL_INTERVAL_MS ?? 2000),
    chain,
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  logger.info(
    {
      chain: config.chain,
      vault: config.vaultAddress,
      supabaseAuth: 'service-role',
    },
    'Guardian starting',
  );

  // Widen to `Chain` so the client type does not become a chain-specific union.
  const chain: Chain = config.chain === 'base' ? base : baseSepolia;
  const client: PublicClient = createPublicClient({
    chain,
    transport: webSocket(config.rpcUrl),
  });

  const supabase = createClient(config.supabaseUrl, config.supabaseKey);

  // Preflight — fail fast (or warn loudly) instead of logging an obscure error
  // on every block when the RPC, vault address, or database is misconfigured.
  const blockNumber = await client.getBlockNumber();
  logger.info({ blockNumber: blockNumber.toString() }, 'RPC connection OK');

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

  // Prevent overlapping checks if a block arrives before the previous finishes.
  let checking = false;

  async function onBlock(blockNumber: bigint): Promise<void> {
    if (checking) {
      logger.debug({ block: blockNumber.toString() }, 'Skipping block — previous check still running');
      return;
    }
    checking = true;
    const startedAt = Date.now();

    try {
      const state = await fetchVaultState(client, config.vaultAddress, config.tokenAddress, blockNumber);
      const results = evaluateInvariants(state);
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

        const payload: AlertPayload = {
          vaultAddress: config.vaultAddress,
          blockNumber,
          timestamp: state.timestamp,
          violations,
          detectedAt: Date.now(),
          detectionLatencyMs,
        };

        await Promise.allSettled([
          sendDiscordAlert(config.discordWebhookUrl, payload, logger),
          logAlertToSupabase(supabase, payload, logger),
        ]);
      } else {
        logger.debug(
          { block: blockNumber.toString(), allPassed: true, detectionLatencyMs },
          'All invariants healthy',
        );
      }
    } catch (err) {
      logger.error({ err, block: blockNumber.toString() }, 'Block check failed');
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

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'Guardian shutting down');
    unwatch();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Guardian crashed during startup');
  process.exit(1);
});
