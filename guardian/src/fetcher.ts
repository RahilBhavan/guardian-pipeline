/**
 * fetcher.ts — reads vault state from Base L2.
 *
 * All five vault reads plus the vault's ERC-20 balance are batched into a
 * single `multicall` so each block costs exactly one RPC round-trip.
 */
import type { PublicClient } from 'viem';
import type { VaultState } from './types.js';

/** Minimal vault ABI — only the state the Guardian reads. */
export const VAULT_ABI = [
  { name: 'totalDeposited', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'totalBorrowed', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'totalShares', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'sharePrice', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'collateralRatio', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
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
 * Fetch a full {@link VaultState} snapshot at a given block.
 *
 * @param client       A viem public client connected to Base.
 * @param vaultAddress The deployed vault address.
 * @param tokenAddress The ERC-20 asset the vault handles.
 * @param blockNumber  Block at which to read state.
 */
export async function fetchVaultState(
  client: PublicClient,
  vaultAddress: `0x${string}`,
  tokenAddress: `0x${string}`,
  blockNumber: bigint,
): Promise<VaultState> {
  const [totalDeposited, totalBorrowed, totalShares, sharePrice, collateralRatio, tokenBalance] =
    await client.multicall({
      allowFailure: false,
      blockNumber,
      contracts: [
        { address: vaultAddress, abi: VAULT_ABI, functionName: 'totalDeposited' },
        { address: vaultAddress, abi: VAULT_ABI, functionName: 'totalBorrowed' },
        { address: vaultAddress, abi: VAULT_ABI, functionName: 'totalShares' },
        { address: vaultAddress, abi: VAULT_ABI, functionName: 'sharePrice' },
        { address: vaultAddress, abi: VAULT_ABI, functionName: 'collateralRatio' },
        { address: tokenAddress, abi: ERC20_ABI, functionName: 'balanceOf', args: [vaultAddress] },
      ],
    });

  return {
    totalDeposited,
    totalBorrowed,
    totalShares,
    sharePrice,
    collateralRatio,
    tokenBalance,
    blockNumber,
    timestamp: Math.floor(Date.now() / 1000),
  };
}
