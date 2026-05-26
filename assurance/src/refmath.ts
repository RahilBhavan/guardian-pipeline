/**
 * refmath — pure-TypeScript reference implementation of the Vault's
 * share/debt arithmetic, used as the differential oracle in
 * test/differential/ShareMathDifferential.t.sol.
 *
 * Every formula here must match src/Vault.sol bit-for-bit on every
 * uint256 input. The Foundry fuzz harness shells out to
 * assurance/bin/refmath-cli.mjs (which re-exports these formulas in
 * dependency-free JS) and asserts equality across thousands of random
 * inputs — any drift between the two implementations fails the build.
 *
 * No third-party deps; uses native BigInt to mirror Solidity's checked
 * uint256 semantics.
 */

export const WAD = 1_000_000_000_000_000_000n; // 1e18

/**
 * Lender deposit — shares minted for `amount` of the debt asset.
 *
 *   shares = totalSupplyShares == 0
 *     ? amount
 *     : floor(amount * totalSupplyShares / totalSupplyAssets)
 *
 * Mirrors Vault.deposit at src/Vault.sol.
 */
export function computeDepositShares(
  amount: bigint,
  totalSupplyAssets: bigint,
  totalSupplyShares: bigint,
): bigint {
  if (totalSupplyShares === 0n) return amount;
  return (amount * totalSupplyShares) / totalSupplyAssets;
}

/**
 * Lender withdraw — debt-asset units returned for burning `shares`.
 *
 *   amountOut = floor(shares * totalSupplyAssets / totalSupplyShares)
 *
 * Mirrors Vault.withdraw at src/Vault.sol.
 */
export function computeWithdrawAmount(
  shares: bigint,
  totalSupplyAssets: bigint,
  totalSupplyShares: bigint,
): bigint {
  return (shares * totalSupplyAssets) / totalSupplyShares;
}

/**
 * Borrow — borrow shares minted for `amount` of debt asset, **ceil-rounded**.
 *
 *   borrowShares = ceil(amount * WAD / borrowIndex)
 *
 * Mirrors Vault.borrow at src/Vault.sol — ceil so the recorded debt is
 * never less than the asset received, protecting INV-01.
 */
export function computeBorrowShares(amount: bigint, borrowIndex: bigint): bigint {
  return (amount * WAD + borrowIndex - 1n) / borrowIndex;
}

/**
 * User debt — debt-asset units owed by a borrower, **floor-rounded**.
 *
 *   debt = floor(userBorrowShares * borrowIndex / WAD)
 *
 * Mirrors Vault.userDebt at src/Vault.sol — floor so per-actor debt can
 * never exceed totalBorrowed, protecting INV-10.
 */
export function computeUserDebt(borrowShares: bigint, borrowIndex: bigint): bigint {
  return (borrowShares * borrowIndex) / WAD;
}

/**
 * Interest accrual — new borrow index after `dt` seconds at `rate` per second.
 *
 *   newIndex = borrowIndex + floor(borrowIndex * rate * dt / WAD)
 *
 * Mirrors Vault.accrue at src/Vault.sol.
 */
export function applyAccrual(
  borrowIndex: bigint,
  ratePerSecond: bigint,
  dt: bigint,
): bigint {
  return borrowIndex + (borrowIndex * ratePerSecond * dt) / WAD;
}
