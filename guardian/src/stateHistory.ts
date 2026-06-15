/**
 * stateHistory.ts — persists the prior {VaultState} so the delta
 * invariants INV-07 and INV-09 survive bot restarts.
 *
 * The table is single-row-per-vault (see supabase/migrations/0004_state_history.sql):
 * every block the bot upserts the latest observation. INV-07/09 read the
 * row at startup and fold the loaded state into the first {evaluator.evaluateInvariants}
 * call as the `prior` argument. On a fresh deploy or after a row purge,
 * `loadPreviousState` returns `null` and the delta checks short-circuit
 * to PASS for one block.
 *
 * Failures are logged and swallowed: the off-chain mirror is a defence
 * layer, not a write-path dependency. Losing one block of delta coverage
 * after a Supabase blip is acceptable; crashing the bot would be worse.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from 'pino';
import type {
  PriorVaultState,
  UserPosition,
  VaultState,
} from './types.js';

const TABLE = 'vault_state_previous';

/**
 * Wire-shape of a per-user position inside `users_jsonb`. Uint256 values
 * are JSON-encoded as decimal strings to mirror the text-encoding used
 * elsewhere in the Supabase schema (see public.alerts.actual_value).
 */
interface SerialisedUser {
  address: string;
  supplyShares: string;
  borrowShares: string;
  collateral: string;
}

/** Wire-shape of the Supabase row. Mirrors the migration's column list. */
interface VaultStateRow {
  vault: string;
  block_number: number | string;
  block_ts: number | string;
  cash: string;
  total_supply_assets: string;
  total_supply_shares: string;
  total_borrow_shares: string;
  total_borrowed: string;
  borrow_index: string;
  collateral_ratio: string;
  last_accrual_time: string;
  liquidation_bonus: string;
  max_staleness: string;
  oracle_last_updated_at: string;
  users_jsonb: SerialisedUser[];
}

function serialiseUsers(users: UserPosition[]): SerialisedUser[] {
  return users.map((u) => ({
    address: u.address,
    supplyShares: u.supplyShares.toString(),
    borrowShares: u.borrowShares.toString(),
    collateral: u.collateral.toString(),
  }));
}

function deserialiseUsers(rows: SerialisedUser[]): UserPosition[] {
  return rows.map((r) => ({
    address: r.address as `0x${string}`,
    supplyShares: BigInt(r.supplyShares),
    borrowShares: BigInt(r.borrowShares),
    collateral: BigInt(r.collateral),
  }));
}

/**
 * Rehydrate a {@link VaultState} from a row read out of Supabase. Exposed
 * so unit tests can exercise the deserialisation path without standing up
 * a Supabase mock.
 */
export function rowToVaultState(row: VaultStateRow): VaultState {
  return {
    blockNumber: BigInt(row.block_number),
    blockTimestamp: Number(row.block_ts),
    cash: BigInt(row.cash),
    totalSupplyAssets: BigInt(row.total_supply_assets),
    totalSupplyShares: BigInt(row.total_supply_shares),
    totalBorrowShares: BigInt(row.total_borrow_shares),
    totalBorrowed: BigInt(row.total_borrowed),
    borrowIndex: BigInt(row.borrow_index),
    borrowRatePerSecond: 0n,
    collateralRatio: BigInt(row.collateral_ratio),
    lastAccrualTime: BigInt(row.last_accrual_time),
    liquidationBonus: BigInt(row.liquidation_bonus),
    maxStaleness: BigInt(row.max_staleness),
    oracleLastUpdatedAt: BigInt(row.oracle_last_updated_at),
    users: deserialiseUsers(row.users_jsonb),
    // liquidationEvents are per-block-window; never restored from history.
    liquidationEvents: [],
  };
}

/** Serialise a {@link VaultState} into the upsert row. Exposed for tests. */
export function vaultStateToRow(state: VaultState, vaultAddress: string): VaultStateRow {
  return {
    vault: vaultAddress,
    block_number: Number(state.blockNumber),
    block_ts: state.blockTimestamp,
    cash: state.cash.toString(),
    total_supply_assets: state.totalSupplyAssets.toString(),
    total_supply_shares: state.totalSupplyShares.toString(),
    total_borrow_shares: state.totalBorrowShares.toString(),
    total_borrowed: state.totalBorrowed.toString(),
    borrow_index: state.borrowIndex.toString(),
    collateral_ratio: state.collateralRatio.toString(),
    last_accrual_time: state.lastAccrualTime.toString(),
    liquidation_bonus: state.liquidationBonus.toString(),
    max_staleness: state.maxStaleness.toString(),
    oracle_last_updated_at: state.oracleLastUpdatedAt.toString(),
    users_jsonb: serialiseUsers(state.users),
  };
}

/**
 * Load the most recent observation for `vaultAddress`, or `null` if the
 * row does not exist (fresh deploy or table purge) or the read fails. A
 * read failure is treated as "no prior" — INV-07/09 lose one block of
 * coverage, the bot continues. The vault-address match is case-insensitive
 * on the lookup so callers don't have to canonicalise.
 */
export async function loadPreviousState(
  supabase: SupabaseClient,
  vaultAddress: string,
  logger: Logger,
): Promise<PriorVaultState> {
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .ilike('vault', vaultAddress)
      .maybeSingle();
    if (error) {
      logger.warn(
        { error: error.message, vault: vaultAddress },
        'stateHistory: load failed — delta invariants will short-circuit for one block',
      );
      return null;
    }
    if (!data) return null;
    return rowToVaultState(data as VaultStateRow);
  } catch (err) {
    logger.warn({ err, vault: vaultAddress }, 'stateHistory: load threw — treating as no prior');
    return null;
  }
}

/**
 * Upsert the latest observation. One row per vault — the primary key
 * (`vault`) drives the upsert so storage stays bounded regardless of
 * uptime. On failure the error is logged and swallowed; the next block
 * will retry the write. INV-07/09 short-circuit to PASS for at most one
 * block per failure.
 */
export async function savePreviousState(
  supabase: SupabaseClient,
  state: VaultState,
  vaultAddress: string,
  logger: Logger,
): Promise<void> {
  const row = vaultStateToRow(state, vaultAddress);
  try {
    const { error } = await supabase.from(TABLE).upsert(row, { onConflict: 'vault' });
    if (error) {
      logger.warn(
        { error: error.message, vault: vaultAddress, block: state.blockNumber.toString() },
        'stateHistory: save failed — next block delta may short-circuit',
      );
    }
  } catch (err) {
    logger.warn(
      { err, vault: vaultAddress, block: state.blockNumber.toString() },
      'stateHistory: save threw — next block delta may short-circuit',
    );
  }
}
