/**
 * fetcher.ts — reads vault state from Base L2.
 *
 * Aggregate state is batched into a single `multicall`. Per-user positions are
 * read for every address discovered from the vault's `Deposited`, `Borrowed`
 * and `Liquidated` events, so the off-chain evaluator can check the supply- and
 * debt-share sum identities (INV-02/03) and the no-uncollateralised-debt rule
 * (INV-06) against the *exact* user set — not a sampled proxy.
 */
import type { PublicClient } from 'viem';
import type { UserPosition, VaultState } from './types.js';

/** `Deposited(address indexed user, uint256, uint256)`. */
export const DEPOSITED_EVENT = {
  type: 'event',
  name: 'Deposited',
  inputs: [
    { name: 'user', type: 'address', indexed: true },
    { name: 'amount', type: 'uint256', indexed: false },
    { name: 'sharesMinted', type: 'uint256', indexed: false },
  ],
} as const;

/** `Borrowed(address indexed user, uint256, uint256)`. */
export const BORROWED_EVENT = {
  type: 'event',
  name: 'Borrowed',
  inputs: [
    { name: 'user', type: 'address', indexed: true },
    { name: 'amount', type: 'uint256', indexed: false },
    { name: 'borrowShares', type: 'uint256', indexed: false },
  ],
} as const;

/** `Liquidated(address indexed liquidator, address indexed borrower, uint256, uint256)`. */
export const LIQUIDATED_EVENT = {
  type: 'event',
  name: 'Liquidated',
  inputs: [
    { name: 'liquidator', type: 'address', indexed: true },
    { name: 'borrower', type: 'address', indexed: true },
    { name: 'debtRepaid', type: 'uint256', indexed: false },
    { name: 'collateralSeized', type: 'uint256', indexed: false },
  ],
} as const;

/** Vault ABI — the views and events the Guardian reads. */
export const VAULT_ABI = [
  { name: 'totalSupplyAssets', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'totalSupplyShares', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'totalBorrowShares', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'totalBorrowed', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'borrowIndex', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'collateralRatio', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    name: 'userSupplyShares',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'userBorrowShares',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  DEPOSITED_EVENT,
  BORROWED_EVENT,
  LIQUIDATED_EVENT,
] as const;

/** Minimal ERC-20 ABI — only `balanceOf`. */
export const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

/**
 * Maximum `eth_getLogs` block span per request. Alchemy's free tier rejects any
 * wider range, so the scan is paginated into windows of this size. A window of
 * N blocks is the inclusive range `[from, from + N - 1]`.
 */
const MAX_LOG_RANGE = 10n;

/**
 * Scan vault events between two blocks and return every address that has ever
 * held a position — depositors, borrowers and liquidation beneficiaries.
 *
 * The range is paginated into {@link MAX_LOG_RANGE}-block windows so the seed
 * scan (deploy block → head, unbounded as the vault ages) stays within the
 * free-tier `eth_getLogs` limit. Windows run sequentially to avoid bursting
 * the RPC; the three event queries within a window run in parallel.
 *
 * @param client       A viem public client connected to Base.
 * @param vaultAddress The deployed vault address.
 * @param fromBlock    First block of the scan (inclusive).
 * @param toBlock      Last block of the scan (inclusive).
 */
export async function discoverUsers(
  client: PublicClient,
  vaultAddress: `0x${string}`,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<`0x${string}`[]> {
  const found = new Set<`0x${string}`>();

  for (let from = fromBlock; from <= toBlock; from += MAX_LOG_RANGE) {
    const to = from + MAX_LOG_RANGE - 1n < toBlock ? from + MAX_LOG_RANGE - 1n : toBlock;

    const [deposits, borrows, liquidations] = await Promise.all([
      client.getLogs({ address: vaultAddress, event: DEPOSITED_EVENT, fromBlock: from, toBlock: to }),
      client.getLogs({ address: vaultAddress, event: BORROWED_EVENT, fromBlock: from, toBlock: to }),
      client.getLogs({ address: vaultAddress, event: LIQUIDATED_EVENT, fromBlock: from, toBlock: to }),
    ]);

    for (const log of deposits) if (log.args.user) found.add(log.args.user);
    for (const log of borrows) if (log.args.user) found.add(log.args.user);
    for (const log of liquidations) {
      if (log.args.liquidator) found.add(log.args.liquidator);
      if (log.args.borrower) found.add(log.args.borrower);
    }
  }

  return [...found];
}

/**
 * Fetch a full {@link VaultState} snapshot at a given block.
 *
 * @param client       A viem public client connected to Base.
 * @param vaultAddress The deployed vault address.
 * @param tokenAddress The ERC-20 asset the vault handles.
 * @param blockNumber  Block at which to read state.
 * @param users        Addresses whose per-user position should be read.
 */
export async function fetchVaultState(
  client: PublicClient,
  vaultAddress: `0x${string}`,
  tokenAddress: `0x${string}`,
  blockNumber: bigint,
  users: `0x${string}`[],
): Promise<VaultState> {
  // One contract call per state field, plus two per discovered user. The
  // heterogeneous shape (some calls take args, some do not) means the typed
  // multicall tuple cannot be inferred, so the result is cast to bigint[] —
  // every call here returns a single uint256.
  const aggregateCalls = [
    { address: vaultAddress, abi: VAULT_ABI, functionName: 'totalSupplyAssets', args: [] },
    { address: vaultAddress, abi: VAULT_ABI, functionName: 'totalSupplyShares', args: [] },
    { address: vaultAddress, abi: VAULT_ABI, functionName: 'totalBorrowShares', args: [] },
    { address: vaultAddress, abi: VAULT_ABI, functionName: 'totalBorrowed', args: [] },
    { address: vaultAddress, abi: VAULT_ABI, functionName: 'borrowIndex', args: [] },
    { address: vaultAddress, abi: VAULT_ABI, functionName: 'collateralRatio', args: [] },
    { address: tokenAddress, abi: ERC20_ABI, functionName: 'balanceOf', args: [vaultAddress] },
  ];

  const userCalls = users.flatMap((user) => [
    { address: vaultAddress, abi: VAULT_ABI, functionName: 'userSupplyShares', args: [user] },
    { address: vaultAddress, abi: VAULT_ABI, functionName: 'userBorrowShares', args: [user] },
  ]);

  const [rawResults, block] = await Promise.all([
    client.multicall({
      allowFailure: false,
      blockNumber,
      contracts: [...aggregateCalls, ...userCalls],
    }),
    client.getBlock({ blockNumber }),
  ]);
  const results = rawResults as bigint[];
  const expected = aggregateCalls.length + userCalls.length;
  if (results.length !== expected) {
    throw new Error(`multicall returned ${results.length} results, expected ${expected}`);
  }
  /** Read a guaranteed-present uint256 cell — the length check above proves it. */
  const cell = (i: number): bigint => results[i] as bigint;

  const positions: UserPosition[] = users.map((address, i) => ({
    address,
    supplyShares: cell(aggregateCalls.length + i * 2),
    borrowShares: cell(aggregateCalls.length + i * 2 + 1),
  }));

  return {
    totalSupplyAssets: cell(0),
    totalSupplyShares: cell(1),
    totalBorrowShares: cell(2),
    totalBorrowed: cell(3),
    borrowIndex: cell(4),
    collateralRatio: cell(5),
    cash: cell(6),
    users: positions,
    blockNumber,
    blockTimestamp: Number(block.timestamp),
  };
}
