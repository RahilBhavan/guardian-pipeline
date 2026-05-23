/**
 * fetcher.ts — reads vault state from Base L2.
 *
 * Aggregate state is batched into a single `multicall`. Per-user positions
 * are read for every address discovered from the vault's `Deposited`,
 * `CollateralDeposited`, `Borrowed` and `Liquidated` events, so the
 * off-chain evaluator can check the supply- and debt-share sum identities
 * (INV-02/03) and the no-uncollateralised-debt rule (INV-06) against the
 * *exact* user set — not a sampled proxy.
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

/** `CollateralDeposited(address indexed user, uint256)`. */
export const COLLATERAL_DEPOSITED_EVENT = {
  type: 'event',
  name: 'CollateralDeposited',
  inputs: [
    { name: 'user', type: 'address', indexed: true },
    { name: 'amount', type: 'uint256', indexed: false },
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
  {
    name: 'userCollateral',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  DEPOSITED_EVENT,
  COLLATERAL_DEPOSITED_EVENT,
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
 * Maximum `eth_getLogs` block span per request. Alchemy's free tier rejects
 * any wider range, so the scan is paginated into windows of this size. A
 * window of N blocks is the inclusive range `[from, from + N - 1]`.
 */
const MAX_LOG_RANGE = 10n;

/**
 * Maximum number of users per per-position multicall batch. Each user
 * contributes three calls (`userSupplyShares`, `userBorrowShares`,
 * `userCollateral`), so this batches into ≤150 calls — well under the
 * free-tier RPC response-size limit. Batches run sequentially so a growing
 * user set never bursts the RPC.
 */
const USERS_PER_MULTICALL_BATCH = 50;

/** Per-user calls per multicall batch (matches the `flatMap` below). */
const CALLS_PER_USER = 3;

/**
 * Scan vault events between two blocks and return every address that has
 * ever held a position — depositors, collateral posters, borrowers and
 * liquidation beneficiaries.
 *
 * The range is paginated into {@link MAX_LOG_RANGE}-block windows so the
 * seed scan (deploy block → head, unbounded as the vault ages) stays within
 * the free-tier `eth_getLogs` limit. Windows run sequentially to avoid
 * bursting the RPC; the four event queries within a window run in parallel.
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

    const [deposits, collateralDeposits, borrows, liquidations] = await Promise.all([
      client.getLogs({ address: vaultAddress, event: DEPOSITED_EVENT, fromBlock: from, toBlock: to }),
      client.getLogs({ address: vaultAddress, event: COLLATERAL_DEPOSITED_EVENT, fromBlock: from, toBlock: to }),
      client.getLogs({ address: vaultAddress, event: BORROWED_EVENT, fromBlock: from, toBlock: to }),
      client.getLogs({ address: vaultAddress, event: LIQUIDATED_EVENT, fromBlock: from, toBlock: to }),
    ]);

    for (const log of deposits) if (log.args.user) found.add(log.args.user);
    for (const log of collateralDeposits) if (log.args.user) found.add(log.args.user);
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
 * @param client            A viem public client connected to Base.
 * @param vaultAddress      The deployed vault address.
 * @param debtAssetAddress  The debt asset whose vault balance is the idle cash.
 * @param blockNumber       Block at which to read state.
 * @param users             Addresses whose per-user position should be read.
 */
export async function fetchVaultState(
  client: PublicClient,
  vaultAddress: `0x${string}`,
  debtAssetAddress: `0x${string}`,
  blockNumber: bigint,
  users: `0x${string}`[],
): Promise<VaultState> {
  // The aggregate state is a fixed 7-call multicall (six vault views + the
  // debt-asset balance that backs INV-01's `cash` term). Per-user positions
  // are batched into chunks of {@link USERS_PER_MULTICALL_BATCH} users — at
  // scale a single all-users multicall exceeds the free-tier RPC
  // response-size cap and the bot starts failing every block. Batches run
  // sequentially after the aggregate fetch so a busy vault never bursts
  // the RPC.
  const aggregateCalls = [
    { address: vaultAddress, abi: VAULT_ABI, functionName: 'totalSupplyAssets', args: [] },
    { address: vaultAddress, abi: VAULT_ABI, functionName: 'totalSupplyShares', args: [] },
    { address: vaultAddress, abi: VAULT_ABI, functionName: 'totalBorrowShares', args: [] },
    { address: vaultAddress, abi: VAULT_ABI, functionName: 'totalBorrowed', args: [] },
    { address: vaultAddress, abi: VAULT_ABI, functionName: 'borrowIndex', args: [] },
    { address: vaultAddress, abi: VAULT_ABI, functionName: 'collateralRatio', args: [] },
    { address: debtAssetAddress, abi: ERC20_ABI, functionName: 'balanceOf', args: [vaultAddress] },
  ];

  const [aggregateRaw, block] = await Promise.all([
    client.multicall({ allowFailure: false, blockNumber, contracts: aggregateCalls }),
    client.getBlock({ blockNumber }),
  ]);
  const aggregateResults = aggregateRaw as bigint[];
  if (aggregateResults.length !== aggregateCalls.length) {
    throw new Error(
      `aggregate multicall returned ${aggregateResults.length} results, expected ${aggregateCalls.length}`,
    );
  }

  const userResults: bigint[] = [];
  for (let i = 0; i < users.length; i += USERS_PER_MULTICALL_BATCH) {
    const slice = users.slice(i, i + USERS_PER_MULTICALL_BATCH);
    const calls = slice.flatMap((user) => [
      { address: vaultAddress, abi: VAULT_ABI, functionName: 'userSupplyShares', args: [user] },
      { address: vaultAddress, abi: VAULT_ABI, functionName: 'userBorrowShares', args: [user] },
      { address: vaultAddress, abi: VAULT_ABI, functionName: 'userCollateral', args: [user] },
    ]);
    const batchRaw = await client.multicall({ allowFailure: false, blockNumber, contracts: calls });
    const batch = batchRaw as bigint[];
    if (batch.length !== calls.length) {
      throw new Error(
        `user multicall batch returned ${batch.length} results, expected ${calls.length}`,
      );
    }
    userResults.push(...batch);
  }

  /** Read a guaranteed-present uint256 cell — the length checks above prove it. */
  const aggCell = (i: number): bigint => aggregateResults[i] as bigint;

  const positions: UserPosition[] = users.map((address, i) => ({
    address,
    supplyShares: userResults[i * CALLS_PER_USER] as bigint,
    borrowShares: userResults[i * CALLS_PER_USER + 1] as bigint,
    collateral: userResults[i * CALLS_PER_USER + 2] as bigint,
  }));

  return {
    totalSupplyAssets: aggCell(0),
    totalSupplyShares: aggCell(1),
    totalBorrowShares: aggCell(2),
    totalBorrowed: aggCell(3),
    borrowIndex: aggCell(4),
    collateralRatio: aggCell(5),
    cash: aggCell(6),
    users: positions,
    blockNumber,
    blockTimestamp: Number(block.timestamp),
  };
}
