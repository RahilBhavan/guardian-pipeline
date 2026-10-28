/** Full-holder end-to-end Morpho detection benchmark: every discovered holder's position, market,
 * simulated accrual, exact conservation, evaluation and PostgreSQL delivery in one transaction.
 * MORPHO_BENCH_DATABASE_URL must be a disposable local database with migrations 0001–0004.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { loadavg } from 'node:os';
import { readFile, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { createPublicClient, http, isAddress } from 'viem';
import { base } from 'viem/chains';
import { morphoTarget } from './morpho-config.js';
import { deliverMorpho, detectMorpho, evaluateMorpho, fetchMorphoSnapshot, morphoJson } from '../src/morpho.js';

const bytes = await readFile(new URL('../../demo/morpho-holders.json', import.meta.url), 'utf8');
const fixture = JSON.parse(bytes) as { market: string; toBlock: string; holdersSha256: string; holders: unknown[] };
const holders = fixture.holders.map((value) => {
  if (typeof value !== 'string' || !isAddress(value)) throw new Error('Invalid holder');
  return value;
});
if (fixture.market !== morphoTarget.market || fixture.toBlock !== morphoTarget.block.toString() ||
    createHash('sha256').update(holders.join('\n')).digest('hex') !== fixture.holdersSha256) throw new Error('Holder fixture mismatch');

if (!process.env.MORPHO_BENCH_DATABASE_URL) throw new Error('Set MORPHO_BENCH_DATABASE_URL to a disposable local database');
const database = new URL(process.env.MORPHO_BENCH_DATABASE_URL);
// Never benchmark against a hosted project: this deletes and rewrites the market's rows.
if (!['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname)) throw new Error('Benchmark database must be local');
const pool = new Pool({ connectionString: database.href, max: 1 });
const rpc = new URL(process.env.BASE_MAINNET_RPC ?? 'https://mainnet.base.org');
const client = createPublicClient({ chain: base, transport: http(rpc.href, { timeout: 30_000 }) });
if (await client.getChainId() !== base.id) throw new Error('Expected Base mainnet');
const batchSize = Number(process.env.MORPHO_BATCH_SIZE ?? 4000);
const params = { client, morpho: morphoTarget.morpho, market: morphoTarget.market, block: morphoTarget.block, actors: holders, batchSize };
const count = Number(process.env.MORPHO_BENCH_SAMPLES ?? 25);
const vault = morphoTarget.market.toLowerCase();

// Untimed: the real holder set must conserve shares, and both injected mutants must fail.
const snapshot = await fetchMorphoSnapshot(params);
const baseline = evaluateMorpho(snapshot, 'complete');
const [largest] = [...snapshot.positions].sort((a, b) => (b.supplyShares > a.supplyShares ? 1 : -1));
const borrower = snapshot.positions.findIndex((p) => p.borrowShares > 0n);
if (!largest || borrower < 0) throw new Error('Unexpected empty market');
const mutants = {
  droppedLargestSupplier: evaluateMorpho({ ...snapshot, positions: snapshot.positions.filter((p) => p !== largest) }, 'complete')
    .violations.map((v) => v.id),
  borrowSharesPlusOne: evaluateMorpho({ ...snapshot, positions: snapshot.positions.map((p, i) =>
    i === borrower ? { ...p, borrowShares: p.borrowShares + 1n } : p) }, 'complete').violations.map((v) => v.id),
};
if (baseline.violations.length || !mutants.droppedLargestSupplier.includes('MORPHO-SUPPLY-CONSERVATION') ||
    !mutants.borrowSharesPlusOne.includes('MORPHO-BORROW-CONSERVATION')) {
  throw new Error(`Conservation self-check failed: ${JSON.stringify({ baseline: baseline.violations, mutants }, morphoJson)}`);
}

const samples = [];
for (let iteration = 0; iteration < count; iteration++) {
  // Untimed reset so every sample really inserts its checked-block row.
  await pool.query('DELETE FROM public.alerts WHERE vault=$1 AND block_number=$2', [vault, params.block.toString()]);
  await pool.query('DELETE FROM public.blocks_checked WHERE vault=$1 AND block_number=$2', [vault, params.block.toString()]);
  const load1m = loadavg()[0];
  const start = performance.now();
  try {
    const report = await detectMorpho(params, 'complete');
    const deliveryStart = performance.now();
    const written = await deliverMorpho(pool, report);
    const end = performance.now();
    const readback = await pool.query<{ violations_count: number; all_passed: boolean }>(
      'SELECT violations_count, all_passed FROM public.blocks_checked WHERE vault=$1 AND block_number=$2', [vault, params.block.toString()]);
    const ok = written.blocks === 1 && written.alerts === report.results.violations.length && readback.rows.length === 1 &&
      readback.rows[0]?.violations_count === report.results.violations.length;
    samples.push({ iteration, ok, latencyMs: Math.round(end - start), fetchEvaluateMs: Math.round(deliveryStart - start),
      deliveryMs: Math.round(end - deliveryStart), positions: report.results.sampledPositions,
      populated: report.results.populatedPositions, violations: report.results.violations.map((v) => v.id),
      alertsWritten: written.alerts, blocksWritten: written.blocks, liquidatable: report.results.liquidatable.length,
      blockHash: report.blockHash, load1m });
  } catch (err) {
    // RPC error text may contain an authenticated URL; keep only the error class.
    samples.push({ iteration, ok: false, error: err instanceof Error ? err.name : 'unknown', load1m });
  }
  console.error(JSON.stringify(samples.at(-1)));
}
await pool.end();

const good = samples.filter((s) => s.ok);
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] ?? null;
const stats = (key: 'latencyMs' | 'fetchEvaluateMs' | 'deliveryMs') => {
  const values = good.flatMap((s) => s[key] ?? []);
  return { p50: percentile(values, 0.5), p95: percentile(values, 0.95), min: Math.min(...values), max: Math.max(...values) };
};
const result = {
  measuredAt: new Date().toISOString(), chainId: base.id, block: params.block, morpho: params.morpho, market: params.market,
  rpcHost: rpc.hostname, database: 'local PostgreSQL, migrations 0001-0004', batchSize,
  holdersFileSha256: createHash('sha256').update(bytes).digest('hex'), holdersSha256: fixture.holdersSha256,
  holderCount: holders.length, populatedPositions: baseline.populatedPositions,
  conservation: baseline.checks.filter((c) => c.id.endsWith('CONSERVATION')), mutants,
  methodology: 'Each sample times detectMorpho(all holders, complete) plus deliverMorpho: block/market/oracle reads, serial atomic eth_call batches that simulate accrueInterest then read every holder position at the pinned block, exact share conservation and the other Morpho checks, health-risk observations, then one PostgreSQL transaction writing alerts and the blocks_checked row. Rows are deleted untimed before each sample and read back untimed after it. Holder discovery is a cached precompute (demo/morpho-holders.json) and is not timed.',
  samplesRequested: count, errors: samples.filter((s) => !s.ok).length,
  results: { endToEndMs: stats('latencyMs'), fetchEvaluateMs: stats('fetchEvaluateMs'), deliveryMs: stats('deliveryMs') },
  samples,
};
await writeFile(new URL('../../docs/morpho-full-benchmark.json', import.meta.url), JSON.stringify(result, morphoJson, 2) + '\n');
console.log(JSON.stringify({ ...result, samples: undefined }, morphoJson, 2));
