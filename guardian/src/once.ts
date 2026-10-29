/** Scheduled sampling with complete discovery and atomic persistence.
 * Commits 6000-block windows (~20 minutes of Base Sepolia at 0.2 s per block)
 * until head or the CATCHUP_MINUTES budget (default 5), so a delayed schedule
 * still catches up inside the job timeout. With LOG_RANGE=200 a window is 30 log
 * scans; a window that times out rolls back and is retried whole.
 * Never drops an older event gap.
 * Unlike HA, this records only each window's endpoint, not every block.
 * Exit code: 0 at head with no violation, 1 infrastructure failure,
 * 2 invariant violated at the last block checked, 3 still behind head (see exitStatus.ts).
 */
import 'dotenv/config';
import { appendFileSync } from 'node:fs';
import { Pool } from 'pg';
import { createPublicClient, http, isAddress, type PublicClient, type Chain } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import pino from 'pino';
import { discoverUsers, fetchLiquidationsInRange, fetchOracleAddress, fetchVaultState } from './fetcher.js';
import { checkNextBlock } from './atomicMonitor.js';
import { evaluateInvariants } from './evaluator.js';
import { classifyRun, EXIT_CODES, type RunOutcome } from './exitStatus.js';
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
/** Shown on the workflow run page; GITHUB_STEP_SUMMARY is unset locally. */
function summarize(outcome: RunOutcome, detail: string): void {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Guardian Monitor: ${outcome}\n\n${detail}\n`);
}
async function run(): Promise<RunOutcome> {
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
    const budgetMinutes = Number(process.env.CATCHUP_MINUTES ?? 5);
    if (!(budgetMinutes > 0)) throw new Error('Invalid CATCHUP_MINUTES');
    const deadline = Date.now() + budgetMinutes * 60_000;
    let violations: string[] = [];
    let result: Awaited<ReturnType<typeof checkNextBlock>>;
    do result = await checkNextBlock({ pool, vault, deployBlock, head, maxBlocks: 6000n,
      fetch: async (block, prior) => {
        const from = prior ? prior.blockNumber + 1n : deployBlock;
        const users = new Set(prior?.users.map((user) => user.address) ?? []);
        for (const user of await discoverUsers(client, vault, from, block, 1100)) users.add(user);
        const events = await fetchLiquidationsInRange(client, vault, oracle, from, block, 1100);
        const snapshot = await fetchVaultState(client, vault, asset, oracle, block, [...users], events);
        violations = evaluateInvariants(snapshot, prior).filter((r) => !r.passed).map((r) => r.id);
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
    const reached = row ? BigInt(row.block_number) : undefined;
    // Historical progress is durable, but a green scheduled run must mean head was checked.
    const outcome = classifyRun(head, reached, violations);
    const detail = `Head ${head}, checkpoint ${reached ?? 'none'}. ${violations.length ? `Violated at the last block checked: ${violations.join(', ')}.` : 'No violation at the last block checked.'}`;
    logger.info({ head: head.toString(), checkpoint: reached?.toString(), violations, outcome }, 'Single-pass check committed');
    summarize(outcome, outcome === 'behind' ? `${detail} Backfill incomplete; rerun to continue from the durable checkpoint.` : detail);
    return outcome;
  } finally { await pool.end(); }
}
run().catch((): RunOutcome => {
  // Provider errors may contain credentials. Detailed state is in structured progress logs.
  recordError('guardian.single_pass');
  logger.fatal('Single-pass check failed; infrastructure failure, checkpoint retained');
  summarize('infra', 'The check could not complete (RPC, database or configuration). Not an invariant violation; see the step log.');
  return 'infra';
}).then((outcome) => { process.exitCode = EXIT_CODES[outcome]; }).finally(() => telemetry.shutdown());
