/** Full-holder discovery for the pinned Morpho market. Regenerates demo/morpho-holders.json.
 * Every position change emits one of these events with the position owner as topic 2, so the
 * union of those owners since market creation (plus the fee recipient) is the complete holder set.
 * Exact share conservation in benchmark-morpho-full.ts is the end-to-end proof.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createPublicClient, decodeEventLog, getAddress, http, parseAbi, toEventSelector, type Hex, type Log } from 'viem';
import { base } from 'viem/chains';
import { morphoTarget } from './morpho-config.js';

const events = parseAbi([
  'event Supply(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares)',
  'event Borrow(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares)',
  'event SupplyCollateral(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets)',
  'event Withdraw(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares)',
  'event Repay(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares)',
  'event WithdrawCollateral(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets)',
  'event Liquidate(bytes32 indexed id, address indexed caller, address indexed borrower, uint256 repaidAssets, uint256 repaidShares, uint256 seizedAssets, uint256 badDebtAssets, uint256 badDebtShares)',
]);
const opening = new Set(['Supply', 'Borrow', 'SupplyCollateral']);
const view = parseAbi([
  'function idToMarketParams(bytes32 id) view returns (address,address,address,address,uint256)',
  'function feeRecipient() view returns (address)',
]);
// Block where idToMarketParams(market) first returns a market; verified below on every run.
const CREATED = 19_326_981n;
const WINDOW = 1_000n; // Tenderly's public getLogs maximum.
const { morpho, market, block: pinned } = morphoTarget;

const logsUrl = new URL(process.env.BASE_LOGS_RPC ?? 'https://gateway.tenderly.co/public/base');
const callsUrl = new URL(process.env.BASE_MAINNET_RPC ?? 'https://mainnet.base.org');
const logs = createPublicClient({ chain: base, transport: http(logsUrl.href, { timeout: 60_000, retryCount: 0 }) });
const calls = createPublicClient({ chain: base, transport: http(callsUrl.href, { timeout: 30_000 }) });
if (await logs.getChainId() !== base.id || await calls.getChainId() !== base.id) throw new Error('Expected Base mainnet');
const created = async (block: bigint) =>
  (await calls.readContract({ address: morpho, abi: view, functionName: 'idToMarketParams', args: [market], blockNumber: block }))[4] > 0n;
if (await created(CREATED - 1n) || !await created(CREATED)) throw new Error('Market creation block mismatch');

const checkpointPath = process.env.MORPHO_DISCOVERY_CHECKPOINT;
type Progress = { next: string; requests: number; counts: Record<string, number>; openers: string[]; reducers: string[] };
let progress: Progress = { next: CREATED.toString(), requests: 0, counts: {}, openers: [], reducers: [] };
if (checkpointPath) progress = JSON.parse(await readFile(checkpointPath, 'utf8').catch(() => JSON.stringify(progress))) as Progress;
const resumed = BigInt(progress.next) !== CREATED;
const openers = new Set(progress.openers);
const reducers = new Set(progress.reducers);
const counts = new Map(Object.entries(progress.counts));
let requests = progress.requests;

async function getLogs(from: bigint, to: bigint): Promise<Log[]> {
  for (let attempt = 0; ; attempt++) {
    requests++;
    try {
      return await logs.request({ method: 'eth_getLogs', params: [{ address: morpho,
        fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`,
        topics: [events.map((event) => toEventSelector(event)), market] }] }) as Log[];
    } catch (err) {
      if (attempt >= 30) throw err;
      // Public endpoints answer bursts with rate-limit errors; never skip a window.
      await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, 500 * 2 ** attempt)));
    }
  }
}

const concurrency = Number(process.env.MORPHO_DISCOVERY_CONCURRENCY ?? 4);
const started = performance.now();
for (let from = BigInt(progress.next); from <= pinned; from += WINDOW * 50n) {
  const windows: bigint[] = [];
  for (let w = from; w < from + WINDOW * 50n && w <= pinned; w += WINDOW) windows.push(w);
  const results: Log[][] = new Array(windows.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < windows.length) {
      const index = cursor++;
      const start = windows[index]!;
      const end = start + WINDOW - 1n < pinned ? start + WINDOW - 1n : pinned;
      results[index] = await getLogs(start, end);
      for (const log of results[index]!) {
        if (log.blockNumber === null || log.blockNumber < start || log.blockNumber > end ||
            log.address.toLowerCase() !== morpho.toLowerCase() || log.topics[1] !== market) throw new Error('Out-of-filter log');
      }
    }
  }));
  for (const log of results.flat()) {
    const event = decodeEventLog({ abi: events, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
    const owner = getAddress('onBehalf' in event.args ? event.args.onBehalf : event.args.borrower);
    counts.set(event.eventName, (counts.get(event.eventName) ?? 0) + 1);
    (opening.has(event.eventName) ? openers : reducers).add(owner);
  }
  progress = { next: (from + WINDOW * 50n).toString(), requests, counts: Object.fromEntries(counts),
    openers: [...openers], reducers: [...reducers] };
  if (checkpointPath) await writeFile(checkpointPath, JSON.stringify(progress));
  const done = Number(from + WINDOW * 50n - CREATED) / Number(pinned - CREATED + 1n);
  console.error(`${Math.min(100, done * 100).toFixed(1)}% block ${from} holders ${openers.size} requests ${requests}`);
}

// A position can only shrink after it was opened, so reducer-only owners would mean missed logs.
const reducerOnly = [...reducers].filter((address) => !openers.has(address));
if (reducerOnly.length) throw new Error(`Owners seen only in reducing events: ${reducerOnly.join(',')}`);
// AccrueInterest mints fee shares to the current recipient without a Supply event.
const feeRecipient = await calls.readContract({ address: morpho, abi: view, functionName: 'feeRecipient', blockNumber: pinned });
const holders = [...new Set([...openers, feeRecipient])].sort();
const fixture = {
  chainId: base.id, morpho, market, fromBlock: CREATED.toString(), toBlock: pinned.toString(),
  logsRpcHost: logsUrl.hostname, retrievedAt: new Date().toISOString(),
  // Wall time of the final process only; a resumed checkpoint run reports a partial time.
  scanSeconds: Math.round((performance.now() - started) / 1000), resumed,
  windowBlocks: Number(WINDOW), requests, logCounts: Object.fromEntries([...counts].sort()),
  logCount: [...counts.values()].reduce((a, b) => a + b, 0), feeRecipient,
  holderCount: holders.length,
  holdersSha256: createHash('sha256').update(holders.join('\n')).digest('hex'),
  holders,
};
await writeFile(new URL('../../demo/morpho-holders.json', import.meta.url), JSON.stringify(fixture, null, 1) + '\n');
console.log(JSON.stringify({ ...fixture, holders: undefined }, null, 2));
