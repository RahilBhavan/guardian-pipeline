/**
 * Shared type definitions for the Guardian bot. No logic lives here.
 */

/** The twelve invariant identifiers, mirroring the Solidity harness. */
export type InvariantId =
  | 'INV-01'
  | 'INV-02'
  | 'INV-03'
  | 'INV-04'
  | 'INV-05'
  | 'INV-06'
  | 'INV-07'
  | 'INV-08'
  | 'INV-09'
  | 'INV-10'
  | 'INV-11'
  | 'INV-12';

/**
 * One realised liquidation observed in the polled block, with the oracle
 * price read at the same block. INV-08 reconciles `(debtRepaid,
 * collateralSeized)` against `seized * price * BPS <= paid * (BPS + bonus) * WAD`.
 */
export interface LiquidationEvent {
  blockNumber: bigint;
  borrower: `0x${string}`;
  /** Debt-asset units the liquidator paid to clear part of the borrower's debt. */
  debtRepaid: bigint;
  /** Collateral-asset units the liquidator received from the vault. */
  collateralSeized: bigint;
  /** Oracle `price()` read at {@link blockNumber}. */
  oraclePrice: bigint;
}

/** A single account's position in the vault at a given block. */
export interface UserPosition {
  address: `0x${string}`;
  /** Lender shares held. */
  supplyShares: bigint;
  /** Borrow shares owed. */
  borrowShares: bigint;
  /** Collateral-asset units posted as backing for any borrow. */
  collateral: bigint;
}

/** A snapshot of on-chain vault state at a single block. */
export interface VaultState {
  /** Total debt-asset units owed to lenders (stored on-chain, grown by interest). */
  totalSupplyAssets: bigint;
  /** Total lender shares outstanding. */
  totalSupplyShares: bigint;
  /** Total borrow shares outstanding. */
  totalBorrowShares: bigint;
  /** Total debt in debt-asset units, from the vault's `totalBorrowed()` view. */
  totalBorrowed: bigint;
  /** Debt-scaling index, scaled by 1e18. */
  borrowIndex: bigint;
  /** Maximum borrow as a fraction of collateral value, in basis points. */
  collateralRatio: bigint;
  /** The vault's own debt-asset balance — idle cash. */
  cash: bigint;
  /** Unix seconds of the last on-chain accrue() (vault.lastAccrualTime). */
  lastAccrualTime: bigint;
  /** Oracle staleness budget (vault.MAX_STALENESS), seconds. */
  maxStaleness: bigint;
  /** Liquidation bonus in BPS (vault.liquidationBonus). */
  liquidationBonus: bigint;
  /** Unix seconds the oracle reports as its last refresh (oracle.lastUpdatedAt). */
  oracleLastUpdatedAt: bigint;
  /** Per-account positions for every address discovered from vault events. */
  users: UserPosition[];
  /** Liquidations realised in this block, harvested from the Liquidated event. */
  liquidationEvents: LiquidationEvent[];
  blockNumber: bigint;
  /** Unix seconds of the block whose state was read. */
  blockTimestamp: number;
}

/**
 * The previous {@link VaultState} observation for a vault, fed into the
 * delta invariants (INV-07 solvencyMonotone, INV-09 debtMonotoneUnderAccrual).
 * Absent on the very first observed block after deploy or restart — the
 * delta checks short-circuit to a non-failing "no prior" result in that case.
 */
export type PriorVaultState = VaultState | null;

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
  /** ERC-20 the vault lends and borrowers receive/repay — the bot reads
   *  this asset's `balanceOf(vault)` for INV-01's `cash` term. The
   *  collateral asset is not read directly; `userCollateral` is exposed
   *  by the vault itself. */
  debtAsset: `0x${string}`;
  /** Block the vault was deployed at — the start of the event scan. */
  deployBlock: bigint;
  supabaseUrl: string;
  supabaseKey: string;
  blockPollIntervalMs: number;
  chain: 'base-sepolia' | 'base';
}
