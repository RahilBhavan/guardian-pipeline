/** Read-only mainnet RPC load measurement. Not a Guardian Vault ABI benchmark. */
import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createPublicClient, http, isAddress, parseAbi } from 'viem';
import { base } from 'viem/chains';

const morpho = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
const market = '0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836';
const block = 53_120_000n;
const file = new URL('../../demo/morpho-benchmark-actors.json', import.meta.url);
const abi = parseAbi([
  'function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)',
  'function market(bytes32 id) view returns (uint128 totalSupplyAssets,uint128 totalSupplyShares,uint128 totalBorrowAssets,uint128 totalBorrowShares,uint128 lastUpdate,uint128 fee)',
]);

if (process.argv.includes('--refresh-actors')) {
  const query = `{ marketPositions(first: 1000, where: {chainId_in: [8453], marketUniqueKey_in: ["${market}"], borrowShares_gte: 1}) { items { user { address } } pageInfo { countTotal } } }`;
  const response = await fetch('https://api.morpho.org/graphql', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }),
  });
  if (!response.ok) throw new Error('Morpho API request failed');
  const body: unknown = await response.json();
  if (typeof body !== 'object' || body === null || !('data' in body) || 'errors' in body) throw new Error('Morpho API query failed');
  const data = body.data;
  if (typeof data !== 'object' || data === null || !('marketPositions' in data)) throw new Error('Missing marketPositions');
  const positions = data.marketPositions;
  if (typeof positions !== 'object' || positions === null || !('items' in positions) || !Array.isArray(positions.items) || !('pageInfo' in positions)) throw new Error('Invalid positions');
  const page = positions.pageInfo;
  if (typeof page !== 'object' || page === null || !('countTotal' in page) || typeof page.countTotal !== 'number') throw new Error('Invalid position count');
  const addresses = positions.items.map((item: unknown) => {
    if (typeof item !== 'object' || item === null || !('user' in item)) throw new Error('Invalid user');
    const user = item.user;
    if (typeof user !== 'object' || user === null || !('address' in user) || typeof user.address !== 'string' || !isAddress(user.address)) throw new Error('Invalid API address');
    return user.address;
  });
  await writeFile(file, JSON.stringify({ source: 'https://api.morpho.org/graphql', retrievedAt: new Date().toISOString(),
    market, indexedBorrowerCount: page.countTotal,
    actors: addresses,
  }, null, 2) + '\n');
}
const bytes = await readFile(file, 'utf8');
const fixture: unknown = JSON.parse(bytes);
if (typeof fixture !== 'object' || fixture === null || !('actors' in fixture) || !Array.isArray(fixture.actors)) throw new Error('Invalid actor fixture');
const actors = fixture.actors.map((value: unknown) => {
  if (typeof value !== 'string' || !isAddress(value)) throw new Error('Invalid actor address');
  return value;
});
if (new Set(actors.map((value) => value.toLowerCase())).size !== actors.length) throw new Error('Actor fixture contains duplicates');
const rpc = process.env.BASE_MAINNET_RPC ?? 'https://mainnet.base.org';
const client = createPublicClient({ chain: base, transport: http(rpc, { timeout: 30000 }) });
if (await client.getChainId() !== 8453) throw new Error('Expected Base mainnet');
const marketState = await client.readContract({ address: morpho, abi, functionName: 'market', args: [market], blockNumber: block });
if (marketState[4] === 0n) throw new Error('Market not created at pinned block');
const samples = [];
for (const count of [100, 1000]) {
  if (actors.length < count) throw new Error(`Need ${count} distinct actors`);
  for (let iteration = 0; iteration < 5; iteration++) {
    const start = performance.now();
    let populated = 0;
    let noCollateralDebt = 0;
    let debtShares = 0n;
    for (let offset = 0; offset < count; offset += 100) {
      const positions = await client.multicall({ blockNumber: block, allowFailure: false,
        contracts: actors.slice(offset, Math.min(offset + 100, count)).map((account) => ({
          address: morpho, abi, functionName: 'position', args: [market, account],
        } as const)),
      });
      for (const [supply, debt, collateral] of positions) {
        if (supply || debt || collateral) populated++;
        if (debt && !collateral) noCollateralDebt++;
        debtShares += debt;
      }
    }
    if (noCollateralDebt || debtShares > marketState[3]) throw new Error('Sample predicate failed');
    samples.push({ positions: count, iteration, populated, latencyMs: Math.round(performance.now() - start) });
  }
}
function percentile(values: number[], p: number): number {
  return [...values].sort((a,b) => a-b)[Math.ceil(values.length * p) - 1] ?? 0;
}
const report = {
  measuredAt: new Date().toISOString(), chainId: 8453, block: block.toString(), morpho, market,
  rpcHost: new URL(rpc).hostname, actorsSha256: createHash('sha256').update(bytes).digest('hex'),
  methodology: 'Pinned on-chain position reads, serial batches of 100 + subset debt-share/collateral checks. Five warm/cold mixed samples per size. Excludes actor discovery, persistence, interest accrual, and full Guardian evaluation. Historical empty positions count separately. Sample, not complete market coverage.',
  results: [100,1000].map((count) => ({ positions: count,
    p50Ms: percentile(samples.filter((s) => s.positions === count).map((s) => s.latencyMs), .5),
    p95Ms: percentile(samples.filter((s) => s.positions === count).map((s) => s.latencyMs), .95),
  })), samples,
};
await writeFile(new URL('../../docs/morpho-benchmark.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
