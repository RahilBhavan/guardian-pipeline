/**
 * once.ts — single-pass Guardian check.
 *
 * A one-shot variant of the bot's per-block work (see bot.ts `onBlock`) for
 * environments that cannot host a long-running daemon — notably the free
 * GitHub Actions schedule (.github/workflows/guardian-monitor.yml).
 *
 * It checks the latest block once and exits:
 *   1. seed the user set from the persisted prior state (no full-history rescan),
 *   2. incrementally scan only the gap since the last run for new users +
 *      liquidations (bounded by LOOKBACK so a long gap can't blow up one run),
 *   3. fetch vault state at head, evaluate all 12 invariants,
 *   4. persist the block-check, any alerts, and the new prior state, then exit.
 *
 * Uses an HTTP RPC transport (not the daemon's WebSocket) so the process has no
 * open socket to keep it alive after the single check completes.
 */
import 'dotenv/config';
import { createPublicClient, http, type Chain, type PublicClient } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import pino from 'pino';
import { createClient } from '@supabase/supabase-js';
import {
  discoverUsers,
  fetchLiquidationsInRange,
  fetchOracleAddress,
  fetchVaultState,
} from './fetcher.js';
import { evaluateInvariants } from './evaluator.js';
import { loadPreviousState, savePreviousState } from './stateHistory.js';
import { logAlertToSupabase, logBlockCheck } from './router.js';
import { createGuardianState } from './health.js';
import type { AlertPayload, PriorVaultState } from './types.js';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: { target: 'pino-pretty', options: { translateTime: 'SYS:standard' } },
});

/**
 * Widest gap (in blocks) a single run will scan for new users / liquidations.
 * Seeded users come from the prior state, so this only bounds discovery of
 * accounts that appeared since the last run; a larger gap is clamped and
 * logged rather than scanned in full.
 */
const LOOKBACK = 300n;

/**
 * Pause between each paginated getLogs window during discovery. `discoverUsers`
 * issues four `eth_getLogs` per window; at ~75 CU each that is 300 CU, so a
 * ~1.1 s gap keeps the sweep under a free RPC tier's ~330 CU/s cap. Without it
 * the catch-up scan bursts well past the cap and 429s the whole run *before* it
 * can persist its cursor — leaving the next run to rescan from scratch and fail
 * the same way (the failure that kept the hosted monitor permanently "down").
 */
const SCAN_THROTTLE_MS = 1100;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

async function run(): Promise<void> {
  const startedAt = Date.now();
  for (const key of ['ALCHEMY_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY']) requireEnv(key);
  const vaultAddress = requireEnv('VAULT_ADDRESS') as `0x${string}`;
  const debtAsset = requireEnv('DEBT_ASSET') as `0x${string}`;
  for (const [k, v] of [['VAULT_ADDRESS', vaultAddress], ['DEBT_ASSET', debtAsset]] as const) {
    if (!ADDRESS_RE.test(v)) throw new Error(`Invalid ${k}: expected a 0x-prefixed 40-hex address`);
  }

  const chainName = (process.env.CHAIN ?? 'base-sepolia') as 'base-sepolia' | 'base';
  const alchemyHost = chainName === 'base' ? 'base-mainnet' : 'base-sepolia';
  const rpcUrl = `https://${alchemyHost}.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}`;
  const deployBlock = BigInt(process.env.VAULT_DEPLOY_BLOCK ?? '0');

  const chain: Chain = chainName === 'base' ? base : baseSepolia;
  // Retry/backoff so a transient free-tier rate limit (Alchemy CU/s) on the
  // paginated getLogs scan is absorbed rather than failing the whole run.
  const client: PublicClient = createPublicClient({
    chain,
    transport: http(rpcUrl, { retryCount: 6, retryDelay: 300 }),
  });
  const supabase = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_KEY'));

  // logBlockCheck / logAlertToSupabase mutate a GuardianState; create one without
  // starting the health server (single-pass has no liveness surface to expose).
  const state = createGuardianState({ blockPollIntervalMs: 0, maxHealthyBlocks: 0 });

  const headBlock = await client.getBlockNumber();
  const oracleAddress = await fetchOracleAddress(client, vaultAddress);

  // Seed the user set from the persisted prior state instead of rescanning all
  // history every run — the prior snapshot already carries every known account.
  const priorState: PriorVaultState = await loadPreviousState(supabase, vaultAddress, logger);
  const knownUsers = new Set<`0x${string}`>();
  for (const u of priorState?.users ?? []) knownUsers.add(u.address);

  // Scan only the gap since the last run for new users + liquidations, bounded
  // to LOOKBACK so a long first-run gap can't turn into a giant getLogs sweep.
  const priorBlock = priorState ? BigInt(priorState.blockNumber) : deployBlock;
  let scanFrom = priorBlock + 1n;
  const floor = headBlock > LOOKBACK ? headBlock - LOOKBACK : 0n;
  if (scanFrom < floor) {
    logger.warn(
      { gapFrom: scanFrom.toString(), clampedTo: floor.toString() },
      'Discovery gap exceeds LOOKBACK — scanning only the most recent window; ' +
        'users seeded from prior state cover the rest',
    );
    scanFrom = floor;
  }

  let blockLiquidations: Awaited<ReturnType<typeof fetchLiquidationsInRange>> = [];
  if (headBlock >= scanFrom) {
    // Run the two scans serially (not Promise.all) and throttle each window:
    // both share the free RPC tier's CU/s budget, so overlapping them or
    // sweeping at full speed bursts past the rate limit. See SCAN_THROTTLE_MS.
    const fresh = await discoverUsers(client, vaultAddress, scanFrom, headBlock, SCAN_THROTTLE_MS);
    for (const u of fresh) knownUsers.add(u);
    blockLiquidations = await fetchLiquidationsInRange(
      client,
      vaultAddress,
      oracleAddress,
      scanFrom,
      headBlock,
      SCAN_THROTTLE_MS,
    );
  }

  const vaultState = await fetchVaultState(
    client,
    vaultAddress,
    debtAsset,
    oracleAddress,
    headBlock,
    [...knownUsers],
    blockLiquidations,
  );
  const results = evaluateInvariants(vaultState, priorState);
  const violations = results.filter((r) => !r.passed);
  const detectionLatencyMs = Date.now() - startedAt;

  // Awaited (not fire-and-forget like the daemon) so every write lands before
  // the process exits.
  await logBlockCheck(
    supabase,
    {
      vaultAddress,
      blockNumber: headBlock,
      allPassed: violations.length === 0,
      latencyMs: detectionLatencyMs,
      violationsCount: violations.length,
    },
    logger,
    state,
  );
  await savePreviousState(supabase, vaultState, vaultAddress, logger);

  if (violations.length > 0) {
    const payload: AlertPayload = {
      vaultAddress,
      blockNumber: headBlock,
      timestamp: vaultState.blockTimestamp,
      violations,
      detectedAt: Date.now(),
      detectionLatencyMs,
    };
    await logAlertToSupabase(supabase, payload, logger, state);
    logger.error(
      { block: headBlock.toString(), violations: violations.map((v) => v.id), detectionLatencyMs },
      'INVARIANT VIOLATION DETECTED',
    );
  } else {
    logger.info(
      { block: headBlock.toString(), users: knownUsers.size, detectionLatencyMs },
      'All invariants healthy',
    );
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.fatal({ err }, 'Single-pass Guardian check failed');
    process.exit(1);
  });
