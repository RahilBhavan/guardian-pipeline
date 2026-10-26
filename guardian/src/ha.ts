/** Two identical workers, shared PostgreSQL lock and durable per-block replay. */
import 'dotenv/config';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createPublicClient, http, isAddress, type PublicClient, type Chain } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import pino from 'pino';
import { discoverUsers, fetchLiquidationsInRange, fetchOracleAddress, fetchVaultState } from './fetcher.js';
import { checkNextBlock } from './atomicMonitor.js';
import { startTelemetry, traced, recordError } from './telemetry.js';

const logger = pino();
const telemetry = startTelemetry();
const stop = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => stop.abort());

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}
function address(key: string): `0x${string}` {
  const value = required(key);
  if (!isAddress(value)) throw new Error(`Invalid ${key}`);
  return value;
}
async function main(): Promise<void> {
  const vault = address('VAULT_ADDRESS');
  const asset = address('DEBT_ASSET');
  const chainName = process.env.CHAIN ?? 'base-sepolia';
  if (chainName !== 'base' && chainName !== 'base-sepolia') throw new Error('Invalid CHAIN');
  const chain: Chain = chainName === 'base' ? base : baseSepolia;
  const rpc = new URL(required('RPC_URL'));
  if (!['http:', 'https:'].includes(rpc.protocol)) throw new Error('RPC_URL must use HTTP(S)');
  const deployBlock = BigInt(required('VAULT_DEPLOY_BLOCK'));
  if (deployBlock < 0n) throw new Error('Invalid VAULT_DEPLOY_BLOCK');
  const client: PublicClient = createPublicClient({ chain, transport: http(rpc.href, { timeout: 15_000 }) });
  if (await client.getChainId() !== chain.id) throw new Error('RPC chain does not match CHAIN');
  // Direct DB or session/transaction pooler works: lock lifetime is ONE transaction.
  // DATABASE_URL should enforce TLS for remote hosts; never disable certificate checks.
  const pool = new Pool({ connectionString: required('DATABASE_URL'), max: 1, connectionTimeoutMillis: 10_000 });
  pool.on('error', () => { recordError('database.idle_connection'); logger.error('Database idle connection lost'); });
  try {
    const oracle = await fetchOracleAddress(client, vault);
    logger.info({ chain: chain.id, vault }, 'HA worker started');
    while (!stop.signal.aborted) {
      try {
        const head = await client.getBlockNumber({ cacheTime: 0 });
        const result = await traced('guardian.check_next_block', { 'guardian.vault': vault }, () => checkNextBlock({
          pool, vault, deployBlock, head,
          fetch: async (block, prior) => {
            const from = prior ? prior.blockNumber + 1n : deployBlock;
            const known = new Set(prior?.users.map((user) => user.address) ?? []);
            for (const user of await discoverUsers(client, vault, from, block)) known.add(user);
            const liquidations = await fetchLiquidationsInRange(client, vault, oracle, from, block);
            return fetchVaultState(client, vault, asset, oracle, block, [...known], liquidations);
          },
        }));
        if (result === 'checked') continue; // Replay backlog without skipping a block.
      } catch {
        // RPC errors often include URLs/credentials. Keep operational category only.
        recordError('guardian.ha_iteration');
        logger.error('HA iteration failed; cursor retained, retrying');
      }
      await delay(2000, undefined, { signal: stop.signal }).catch(() => {});
    }
  } finally { await pool.end(); }
}
main().catch(() => { recordError('guardian.ha_startup'); logger.fatal('HA startup failed; check configuration'); process.exitCode = 1; })
  .finally(() => telemetry.shutdown());
