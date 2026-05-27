// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  IPriceOracle — minimal price feed for the Vault
/// @notice Returns the price of one whole unit of the collateral asset,
///         expressed in whole units of the debt asset, scaled by 1e18.
///         A return value of `2_000e18` means: 1 collateral token is worth
///         2,000 debt-asset tokens. Both assets are expected to be 18-decimal
///         ERC-20s; mixed-decimal feeds are out of scope for this reference
///         implementation.
/// @dev    Intentionally narrow. A production system would adapt
///         Chainlink/Pyth/Redstone behind this interface (with staleness,
///         circuit-breaker and confidence-interval logic); the Vault depends
///         only on the single `price()` view so that adaption can happen
///         without touching the vault.
interface IPriceOracle {
    /// @notice Price of one collateral unit in debt-asset units, scaled by 1e18.
    function price() external view returns (uint256);

    /// @notice Unix timestamp at which {price} was last refreshed.
    /// @dev    Consumed by the Vault's freshness gate: if
    ///         `block.timestamp - lastUpdatedAt() > Vault.MAX_STALENESS`,
    ///         price-dependent paths (collateralValue, borrow,
    ///         withdrawCollateral, liquidate) revert with
    ///         `OraclePriceStale()` — see INV-11.
    function lastUpdatedAt() external view returns (uint256);
}
