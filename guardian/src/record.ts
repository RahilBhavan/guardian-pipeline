/**
 * record.ts — replay the Guardian monitor over a block range and write the
 * results to a JSON file the static dashboard renders.
 *
 * It runs the same fetcher and evaluator the live monitor uses (fetchVaultState,
 * evaluateInvariants) against an RPC endpoint, once per block in
 * [FROM_BLOCK, head], feeding each block's state to the next as the prior
 * observation for the delta invariants (INV-07, INV-09). It writes no database.
 *
 * Driven by scripts/record-demo-run.sh, which deploys the vault to a local
 * anvil chain and plays a fixed scenario first. Env: RPC_URL, VAULT_ADDRESS,
 * DEBT_ASSET, FROM_BLOCK, OUT_FILE, plus the metadata fields read below.
 */
import { writeFileSync } from 'node:fs';
import { createPublicClient, http, type Chain } from 'viem';
import { discoverUsers, fetchLiquidationsInRange, fetchOracleAddress, fetchVaultState } from './fetcher.js';
import { evaluateInvariants } from './evaluator.js';
import type { PriorVaultState } from './types.js';

function env(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

async function main(): Promise<void> {
  const rpcUrl = env('RPC_URL');
  const vault = env('VAULT_ADDRESS') as `0x${string}`;
  const debtAsset = env('DEBT_ASSET') as `0x${string}`;
  const fromBlock = BigInt(env('FROM_BLOCK'));
  const chain: Chain = {
    id: Number(process.env.CHAIN_ID ?? 31337),
    name: 'anvil-local',
    contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
  const client = createPublicClient({ chain, transport: http(rpcUrl) });

  const head = await client.getBlockNumber();
  const oracle = await fetchOracleAddress(client, vault);
  const users = await discoverUsers(client, vault, fromBlock, head);

  const blocks: unknown[] = [];
  const alerts: unknown[] = [];
  let prior: PriorVaultState = null;
  for (let n = fromBlock; n <= head; n++) {
    const t0 = Date.now();
    const liquidations = await fetchLiquidationsInRange(client, vault, oracle, n, n);
    const state = await fetchVaultState(client, vault, debtAsset, oracle, n, users, liquidations);
    const results = evaluateInvariants(state, prior);
    const latencyMs = Date.now() - t0;
    const violations = results.filter((r) => !r.passed);
    blocks.push({
      blockNumber: Number(n),
      blockTimestamp: state.blockTimestamp,
      allPassed: violations.length === 0,
      latencyMs,
      violationsCount: violations.length,
    });
    for (const v of violations) {
      alerts.push({
        blockNumber: Number(n),
        blockTimestamp: state.blockTimestamp,
        invariantId: v.id,
        invariantName: v.name,
        actualValue: v.actualValue.toString(),
        boundValue: v.boundValue.toString(),
        description: v.description,
        detectionLatencyMs: latencyMs,
      });
    }
    prior = state;
  }

  const out = {
    kind: 'recorded-run',
    recordedAt: process.env.RECORDED_AT ?? new Date().toISOString(),
    source: process.env.SOURCE_LABEL ?? 'local anvil chain',
    sourceCommit: process.env.SOURCE_COMMIT ?? null,
    scenario: (process.env.SCENARIO ?? '').split('|').filter(Boolean),
    vault,
    firstBlock: Number(fromBlock),
    lastBlock: Number(head),
    blocks,
    alerts,
  };
  writeFileSync(env('OUT_FILE'), JSON.stringify(out, null, 2) + '\n');
  console.log(`recorded ${blocks.length} blocks, ${alerts.length} alerts -> ${process.env.OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
