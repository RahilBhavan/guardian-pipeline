/**
 * Shared type definitions for the Guardian bot. No logic lives here.
 */

/** The six invariant identifiers, mirroring the Solidity harness. */
export type InvariantId = 'INV-01' | 'INV-02' | 'INV-03' | 'INV-04' | 'INV-05' | 'INV-06';

/** A single account's position in the vault at a given block. */
export interface UserPosition {
  address: `0x${string}`;
  /** Lender shares held — collateral. */
  supplyShares: bigint;
  /** Borrow shares owed. */
  borrowShares: bigint;
}

/** A snapshot of on-chain vault state at a single block. */
export interface VaultState {
  /** Total assets owed to lenders (stored on-chain, grown by interest). */
  totalSupplyAssets: bigint;
  /** Total lender shares outstanding. */
  totalSupplyShares: bigint;
  /** Total borrow shares outstanding. */
  totalBorrowShares: bigint;
  /** Total debt in asset units, from the vault's `totalBorrowed()` view. */
  totalBorrowed: bigint;
  /** Debt-scaling index, scaled by 1e18. */
  borrowIndex: bigint;
  /** Maximum borrow as a fraction of collateral, in basis points. */
  collateralRatio: bigint;
  /** The vault's own ERC-20 balance — idle cash. */
  cash: bigint;
  /** Per-account positions for every address discovered from vault events. */
  users: UserPosition[];
  blockNumber: bigint;
  /** Unix seconds of the block whose state was read. */
  blockTimestamp: number;
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

/** A bundled set of violations ready to be persisted to Supabase. */
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
  /** Block the vault was deployed at — the start of the event scan. */
  deployBlock: bigint;
  supabaseUrl: string;
  supabaseKey: string;
  blockPollIntervalMs: number;
  chain: 'base-sepolia' | 'base';
}
