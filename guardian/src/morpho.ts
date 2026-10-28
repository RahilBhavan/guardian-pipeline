/** Morpho Blue runtime detector. Separate from the twelve Vault predicates. */
import type { Pool } from 'pg';
import { parseAbi, encodeFunctionData, decodeFunctionResult, type Address, type Hex, type PublicClient } from 'viem';

const aggregateAbi = parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])']);
const abi = parseAbi([
  'function idToMarketParams(bytes32 id) view returns (address loanToken,address collateralToken,address oracle,address irm,uint256 lltv)',
  'function accrueInterest((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams)',
  'function market(bytes32 id) view returns (uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)',
  'function position(bytes32 id,address user) view returns (uint256 supplyShares,uint128 borrowShares,uint128 collateral)',
  'function price() view returns (uint256)',
]);
export interface MorphoSnapshot {
  blockNumber: bigint;
  blockHash: Hex;
  timestamp: bigint;
  totalSupplyAssets: bigint;
  totalSupplyShares: bigint;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  lastUpdate: bigint;
  fee: bigint;
  lltv: bigint;
  price: bigint;
  positions: { address: Address; supplyShares: bigint; borrowShares: bigint; collateral: bigint }[];
}

/** Each batch simulates accrual and all reads in ONE eth_call. No transaction is sent.
 * Explicit aggregate3 encoding prevents automatic splitting from discarding accrual.
 * Every batch starts from the same pinned state, so deterministic IRM/oracle outputs agree.
 */
export async function fetchMorphoSnapshot(params: {
  client: PublicClient; morpho: Address; market: Hex; block: bigint; actors: Address[]; batchSize?: number;
}): Promise<MorphoSnapshot> {
  if (!params.actors.length) throw new Error('At least one actor is required');
  if (new Set(params.actors.map((a) => a.toLowerCase())).size !== params.actors.length) throw new Error('Duplicate actors');
  const { client, morpho, market, block, actors, batchSize = 100 } = params;
  const before = await client.getBlock({ blockNumber: block });
  const [loanToken, collateralToken, oracle, irm, lltv] = await client.readContract({
    address: morpho, abi, functionName: 'idToMarketParams', args: [market], blockNumber: block,
  });
  if (lltv <= 0n || lltv >= 10n ** 18n) throw new Error('Invalid or uncreated market');
  const marketParams = { loanToken, collateralToken, oracle, irm, lltv };
  let snapshot: MorphoSnapshot | undefined;
  for (let offset = 0; offset < actors.length; offset += batchSize) {
    const batch = actors.slice(offset, offset + batchSize);
    const multicall = client.chain?.contracts?.multicall3?.address;
    if (!multicall) throw new Error('Chain has no configured Multicall3');
    const calls = [
      { target: morpho, data: encodeFunctionData({ abi, functionName: 'accrueInterest', args: [marketParams] }) },
      { target: morpho, data: encodeFunctionData({ abi, functionName: 'market', args: [market] }) },
      { target: oracle, data: encodeFunctionData({ abi, functionName: 'price' }) },
      ...batch.map((address) => ({ target: morpho,
        data: encodeFunctionData({ abi, functionName: 'position', args: [market, address] }) })),
    ];
    const response = await client.call({ to: multicall, blockNumber: block,
      data: encodeFunctionData({ abi: aggregateAbi, functionName: 'aggregate3',
        args: [calls.map((call) => ({ target: call.target, allowFailure: false, callData: call.data }))] }),
    });
    if (!response.data) throw new Error('Empty Multicall3 response');
    const outputs = decodeFunctionResult({ abi: aggregateAbi, functionName: 'aggregate3', data: response.data });
    if (outputs.length !== calls.length || outputs.some((output) => !output.success)) throw new Error('Incomplete batch');
    const totalsOutput = outputs[1];
    const priceOutput = outputs[2];
    if (!totalsOutput || !priceOutput) throw new Error('Missing market outputs');
    const totals = decodeFunctionResult({ abi, functionName: 'market', data: totalsOutput.returnData });
    const price = decodeFunctionResult({ abi, functionName: 'price', data: priceOutput.returnData });
    const positions = outputs.slice(3).map((output) => decodeFunctionResult({ abi, functionName: 'position', data: output.returnData }));
    const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee] = totals;
    if (snapshot) {
      if (snapshot.totalSupplyAssets !== totalSupplyAssets || snapshot.totalSupplyShares !== totalSupplyShares ||
          snapshot.totalBorrowAssets !== totalBorrowAssets || snapshot.totalBorrowShares !== totalBorrowShares ||
          snapshot.lastUpdate !== lastUpdate || snapshot.fee !== fee || snapshot.price !== price) {
        throw new Error('Inconsistent simulated state between batches');
      }
    } else {
      snapshot = { blockNumber: block, blockHash: before.hash, timestamp: before.timestamp, lltv, price,
        totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee, positions: [] };
    }
    for (const [index, position] of positions.entries()) {
      const address = batch[index];
      if (!address) throw new Error('Unexpected RPC position count');
      const [supplyShares, borrowShares, collateral] = position;
      snapshot.positions.push({ address, supplyShares, borrowShares, collateral });
    }
  }
  if (!snapshot) throw new Error('No snapshot');
  const after = await client.getBlock({ blockNumber: block });
  if (after.hash !== before.hash) throw new Error('Pinned block changed during fetch');
  return snapshot;
}

/** Exact Morpho health rounding: debt up, collateral value down, then LLTV down. */
export function morphoDebtUp(shares: bigint, assets: bigint, totalShares: bigint): bigint {
  const denominator = totalShares + 1_000_000n;
  return (shares * (assets + 1n) + denominator - 1n) / denominator;
}
/** `complete` asserts the snapshot holds every market holder: share sums must then equal totals exactly. */
export function evaluateMorpho(snapshot: MorphoSnapshot, coverage: 'sample' | 'complete' = 'sample') {
  const s = snapshot;
  let supplied = 0n;
  let borrowed = 0n;
  let debtWithoutCollateral = 0;
  const liquidatable: { address: Address; debt: bigint; maxDebt: bigint }[] = [];
  for (const p of s.positions) {
    supplied += p.supplyShares;
    borrowed += p.borrowShares;
    if (p.borrowShares > 0n && p.collateral === 0n) debtWithoutCollateral++;
    const debt = morphoDebtUp(p.borrowShares, s.totalBorrowAssets, s.totalBorrowShares);
    const maxDebt = (p.collateral * s.price / 10n ** 36n) * s.lltv / 10n ** 18n;
    if (debt > maxDebt) liquidatable.push({ address: p.address, debt, maxDebt });
  }
  const checks = [
    { id: 'MORPHO-LIQUIDITY', passed: s.totalBorrowAssets <= s.totalSupplyAssets, actual: s.totalBorrowAssets, bound: s.totalSupplyAssets },
    ...coverage === 'complete' ? [
      { id: 'MORPHO-SUPPLY-CONSERVATION', passed: supplied === s.totalSupplyShares, actual: supplied, bound: s.totalSupplyShares },
      { id: 'MORPHO-BORROW-CONSERVATION', passed: borrowed === s.totalBorrowShares, actual: borrowed, bound: s.totalBorrowShares },
    ] : [
      { id: 'MORPHO-SUPPLY-SUBSET', passed: supplied <= s.totalSupplyShares, actual: supplied, bound: s.totalSupplyShares },
      { id: 'MORPHO-BORROW-SUBSET', passed: borrowed <= s.totalBorrowShares, actual: borrowed, bound: s.totalBorrowShares },
    ],
    { id: 'MORPHO-ACCRUAL', passed: s.lastUpdate === s.timestamp, actual: s.lastUpdate, bound: s.timestamp },
    { id: 'MORPHO-FEE', passed: s.fee <= 250_000_000_000_000_000n, actual: s.fee, bound: 250_000_000_000_000_000n },
  ];
  return { checks, violations: checks.filter((check) => !check.passed),
    // These are risk observations, not protocol invariant failures: liquidation is permissionless.
    liquidatable, debtWithoutCollateral, sampledPositions: s.positions.length,
    populatedPositions: s.positions.filter((p) => p.supplyShares || p.borrowShares || p.collateral).length,
    coverage,
    unavailable: [...coverage === 'complete' ? [] : ['complete-holder conservation'], 'shared-token custody across all markets',
      'historical bad-debt/share-price deltas', 'oracle freshness (no timestamp in oracle ABI)',
      'Guardian Vault-specific INV-01 through INV-12 parity'],
  };
}

/** Shared by the runtime CLI and benchmark: reads -> accrual -> evaluation -> alert payload. */
export async function detectMorpho(params: Parameters<typeof fetchMorphoSnapshot>[0], coverage: 'sample' | 'complete' = 'sample') {
  const start = performance.now();
  const snapshot = await fetchMorphoSnapshot(params);
  const results = evaluateMorpho(snapshot, coverage);
  return { protocol: 'morpho-blue' as const, market: params.market, morpho: params.morpho,
    block: snapshot.blockNumber, blockHash: snapshot.blockHash, timestamp: snapshot.timestamp,
    results, detectionLatencyMs: performance.now() - start };
}

export const morphoJson = (_key: string, value: unknown): unknown => typeof value === 'bigint' ? value.toString() : value;

/** Same delivery shape as atomicMonitor: accounting violations and one checked-block row, one transaction.
 * Liquidatable positions are risk observations, not alerts. Returns inserted row counts for readback checks.
 */
export async function deliverMorpho(pool: Pool, report: Awaited<ReturnType<typeof detectMorpho>>) {
  const vault = report.market.toLowerCase();
  const latency = Math.round(report.detectionLatencyMs);
  const { violations } = report.results;
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    let alerts = 0;
    for (const v of violations) {
      const inserted = await db.query(`INSERT INTO public.alerts
        (vault,block_number,block_ts,invariant_id,invariant_name,passed,actual_value,bound_value,description,detection_latency_ms)
        VALUES ($1,$2,to_timestamp($3),$4,$4,false,$5,$6,$7,$8)
        ON CONFLICT (vault,block_number,invariant_id) DO NOTHING`,
      [vault, report.block.toString(), report.timestamp.toString(), v.id, v.actual.toString(), v.bound.toString(),
        `Morpho Blue ${report.results.coverage} accounting check failed`, latency]);
      alerts += inserted.rowCount ?? 0;
    }
    const block = await db.query(`INSERT INTO public.blocks_checked (vault,block_number,all_passed,latency_ms,violations_count)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT (vault,block_number) DO NOTHING`,
    [vault, report.block.toString(), violations.length === 0, latency, violations.length]);
    await db.query('COMMIT');
    return { alerts, blocks: block.rowCount ?? 0 };
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { db.release(); }
}
