import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { morphoInputs } from './morpho-config.js';
import { detectMorpho, morphoJson } from '../src/morpho.js';
const { params, bytes, rpcHost } = await morphoInputs();
const samples = [];
for (const count of [100, 1000]) {
  if (params.actors.length < count) throw new Error('Insufficient actors');
  for (let iteration = 0; iteration < 5; iteration++) {
    // Same callable path as the runtime CLI. Includes market/oracle, simulated interest,
    // positions, checks, risk observations and JSON serialization; excludes persistence.
    const start = performance.now();
    const report = await detectMorpho({ ...params, actors: params.actors.slice(0, count) });
    const serialized = JSON.stringify(report, morphoJson);
    samples.push({ positions: count, iteration, populated: report.results.populatedPositions,
      liquidatable: report.results.liquidatable.length, violations: report.results.violations.map((v) => v.id),
      outputBytes: Buffer.byteLength(serialized), latencyMs: Math.round(performance.now() - start),
      blockHash: report.blockHash });
  }
}
function percentile(values: number[], p: number): number {
  return [...values].sort((a,b) => a-b)[Math.ceil(values.length * p) - 1] ?? 0;
}
const report = { measuredAt: new Date().toISOString(), chainId: 8453, block: params.block,
  morpho: params.morpho, market: params.market, rpcHost,
  actorsSha256: createHash('sha256').update(bytes).digest('hex'),
  methodology: 'Five samples per size through detectMorpho and JSON serialization. Explicit atomic eth_call batches of 100 simulate accrueInterest then read market/oracle/positions at the same pinned block. Includes five Morpho checks and sampled health-risk observations. Excludes discovery, DB delivery, network scheduling and twelve Guardian Vault predicates. Sample coverage only; not all market holders.',
  unavailable: ['complete-holder conservation', 'shared-token custody', 'historical loss/delta checks', 'oracle timestamp', 'Guardian Vault parity'],
  results: [100,1000].map((positions) => ({ positions,
    p50Ms: percentile(samples.filter((s) => s.positions === positions).map((s) => s.latencyMs), .5),
    p95Ms: percentile(samples.filter((s) => s.positions === positions).map((s) => s.latencyMs), .95),
  })), samples };
await writeFile(new URL('../../docs/morpho-detection-benchmark.json', import.meta.url), JSON.stringify(report, morphoJson, 2) + '\n');
console.log(JSON.stringify(report, morphoJson, 2));
