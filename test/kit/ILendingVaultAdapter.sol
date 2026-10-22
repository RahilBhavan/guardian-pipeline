// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  ILendingVaultAdapter — the read surface the invariant kit needs.
/// @notice One adapter wraps one lending market and exposes only the values
///         the generic invariants in {LendingInvariants} read. Every amount
///         is in loan-asset units unless stated otherwise. "Account" is the
///         address whose position the harness tracks; an adapter for a
///         vault keyed by position id (for example an NFT token id) maps
///         the address to the positions it owns. See `test/kit/README.md`.
interface ILendingVaultAdapter {
    /// @notice Loan-asset value backing lender claims: idle cash plus debt owed.
    function totalAssets() external view returns (uint256);

    /// @notice Loan-asset value lenders can claim through their shares.
    function totalSupplyAssets() external view returns (uint256);

    /// @notice Lender shares outstanding.
    function totalSupplyShares() external view returns (uint256);

    /// @notice Lender shares held by `account`.
    function supplySharesOf(address account) external view returns (uint256);

    /// @notice Outstanding debt across all borrowers.
    function totalDebt() external view returns (uint256);

    /// @notice Debt shares outstanding.
    function totalDebtShares() external view returns (uint256);

    /// @notice Debt shares held by `account`.
    function debtSharesOf(address account) external view returns (uint256);

    /// @notice Outstanding debt of `account`.
    function debtOf(address account) external view returns (uint256);

    /// @notice Collateral posted by `account`, in collateral-asset units.
    function collateralOf(address account) external view returns (uint256);

    /// @notice Loan-asset value of `account`'s collateral at the oracle price.
    function collateralValueOf(address account) external view returns (uint256);

    /// @notice Loan-asset units per lender share, scaled by 1e18.
    function sharePrice() external view returns (uint256);

    /// @notice Cumulative bad debt written off against lenders. A vault that
    ///         never socialises losses returns 0.
    function realizedLosses() external view returns (uint256);

    /// @notice Loan-asset units per collateral unit, scaled by 1e18.
    function collateralPrice() external view returns (uint256);

    /// @notice Share of collateral value an account may owe before it can be
    ///         liquidated, in basis points (10_000 = 100%).
    function liquidationThresholdBps() external view returns (uint256);

    /// @notice Extra collateral value a liquidator receives over the debt
    ///         repaid, in basis points.
    function liquidationBonusBps() external view returns (uint256);
}
