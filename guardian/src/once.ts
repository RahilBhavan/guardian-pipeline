/** Scheduled sampling with complete discovery and atomic persistence.
 * Commits 6000-block windows (~20 minutes of Base Sepolia at 0.2 s per block)
 * until head or a 5-minute budget, so a delayed schedule still catches up
 * inside the 10-minute job timeout. With LOG_RANGE=200 a window is 30 log
 * scans; a window that times out rolls back and is retried whole.
 * Never drops an older event gap.
 * Unlike HA, this records only each window's endpoint, not every block.
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { createPublicClient, http, isAddress, type PublicClient, type Chain } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import pino from 'pino';
import { discoverUsers, fetchLiquidationsInRange, fetchOracleAddress, fetchVaultState } from './fetcher.js';
import { checkNextBlock } from './atomicMonitor.js';
import { startTelemetry, recordError } from './telemetry.js';

const logger = pino();
const telemetry = startTelemetry();
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
async function run(): Promise<void> {
  const vault = address('VAULT_ADDRESS');
  const asset = address('DEBT_ASSET');
  const chainName = process.env.CHAIN ?? 'base-sepolia';
  if (chainName !== 'base' && chainName !== 'base-sepolia') throw new Error('Invalid CHAIN');
  const chain: Chain = chainName === 'base' ? base : baseSepolia;
  const host = chainName === 'base' ? 'base-mainnet' : 'base-sepolia';
  const rpc = new URL(process.env.RPC_URL ?? `https://${host}.g.alchemy.com/v2/${required('ALCHEMY_KEY')}`);
  if (!['http:', 'https:'].includes(rpc.protocol)) throw new Error('RPC_URL must use HTTP(S)');
  const deployBlock = BigInt(required('VAULT_DEPLOY_BLOCK'));
  if (deployBlock < 0n) throw new Error('Invalid VAULT_DEPLOY_BLOCK');
  const client: PublicClient = createPublicClient({ chain, transport: http(rpc.href, { timeout: 15_000, retryCount: 6 }) });
  if (await client.getChainId() !== chain.id) throw new Error('RPC chain does not match CHAIN');
  const pool = new Pool({ connectionString: required('DATABASE_URL'), max: 1, connectionTimeoutMillis: 10_000 });
  pool.on('error', () => { recordError('database.idle_connection'); logger.error('Database idle connection lost'); });
  try {
    const head = await client.getBlockNumber();
    const oracle = await fetchOracleAddress(client, vault);
    const deadline = Date.now() + 5 * 60_000;
    let result: Awaited<ReturnType<typeof checkNextBlock>>;
    do result = await checkNextBlock({ pool, vault, deployBlock, head, maxBlocks: 6000n,
      fetch: async (block, prior) => {
        const from = prior ? prior.blockNumber + 1n : deployBlock;
        const users = new Set(prior?.users.map((user) => user.address) ?? []);
        for (const user of await discoverUsers(client, vault, from, block, 1100)) users.add(user);
        const events = await fetchLiquidationsInRange(client, vault, oracle, from, block, 1100);
        const snapshot = await fetchVaultState(client, vault, asset, oracle, block, [...users], events);
        logger.info({ from: from.toString(), checked: block.toString(), head: head.toString(), users: users.size }, 'Complete discovery window fetched');
        return snapshot;
      },
    });
    while (result === 'checked' && Date.now() < deadline);
    if (result === 'standby') throw new Error('Another worker owns this vault');
    const checkpoint = await pool.query<{ block_number: string }>(
      'SELECT block_number FROM public.vault_state_previous WHERE vault=$1', [vault.toLowerCase()],
    );
    const row = checkpoint.rows[0];
    if (!row || BigInt(row.block_number) < head) {
      logger.warn({ checkpoint: row?.block_number, head: head.toString() }, 'Backfill incomplete; rerun to continue');
      // Historical progress is durable, but a green scheduled run must mean head was checked.
      throw new Error('Backfill incomplete; rerun to continue from durable checkpoint');
    }
    logger.info({ head: head.toString(), result }, 'Single-pass check committed');
  } finally { await pool.end(); }
}
run().catch(() => {
  // Provider errors may contain credentials. Detailed state is in structured progress logs.
  recordError('guardian.single_pass');
  logger.fatal('Single-pass check failed or backfill incomplete; checkpoint retained');
  process.exitCode = 1;
}).finally(() => telemetry.shutdown());
