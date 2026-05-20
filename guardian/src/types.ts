/**
 * Shared type definitions for the Guardian bot. No logic lives here.
 */

/** The eight invariant identifiers, mirroring the Solidity harness. */
export type InvariantId =
  | 'INV-01'
  | 'INV-02'
  | 'INV-03'
  | 'INV-04'
  | 'INV-05'
  | 'INV-06'
  | 'INV-07'
  | 'INV-08';

/** A snapshot of on-chain vault state at a single block. */
export interface VaultState {
  totalDeposited: bigint;
  totalBorrowed: bigint;
  totalShares: bigint;
  sharePrice: bigint;
  collateralRatio: bigint;
  /** The vault's own ERC-20 balance. */
  tokenBalance: bigint;
  blockNumber: bigint;
  /** Unix seconds at which the state was read. */
  timestamp: number;
}

/** The outcome of evaluating a single invariant against a {@link VaultState}. */
export interface InvariantResult {
  id: InvariantId;
  name: string;
  passed: boolean;
  actualValue: bigint;
  boundValue: bigint;
  description: string;
}

/** A bundled set of violations ready to be routed to Discord and Supabase. */
export interface AlertPayload {
  vaultAddress: string;
  blockNumber: bigint;
  /** Unix seconds of the checked block's state read. */
  timestamp: number;
  violations: InvariantResult[];
  /** Wall-clock ms (Date.now()) at which detection completed. */
  detectedAt: number;
  /** Milliseconds elapsed between fetching state and finishing evaluation. */
  detectionLatencyMs: number;
}

/** Fully-resolved, validated runtime configuration. */
export interface BotConfig {
  rpcUrl: string;
  vaultAddress: `0x${string}`;
  tokenAddress: `0x${string}`;
  discordWebhookUrl: string;
  supabaseUrl: string;
  supabaseKey: string;
  blockPollIntervalMs: number;
  chain: 'base-sepolia' | 'base';
}
