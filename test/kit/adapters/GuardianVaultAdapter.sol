// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ILendingVaultAdapter} from "../ILendingVaultAdapter.sol";
import {Vault} from "../../../src/Vault.sol";

/// @title  GuardianVaultAdapter — maps {Vault} onto {ILendingVaultAdapter}.
/// @notice Every value is a direct read of one Vault getter. The Vault never
///         writes bad debt off against lenders, so {realizedLosses} is 0, and
///         it liquidates at its borrow cap, so the threshold is
///         {Vault.collateralRatio}.
contract GuardianVaultAdapter is ILendingVaultAdapter {
    Vault public immutable VAULT;

    constructor(Vault vault) {
        VAULT = vault;
    }

    function totalAssets() external view returns (uint256) {
        return VAULT.totalAssets();
    }

    function totalSupplyAssets() external view returns (uint256) {
        return VAULT.totalSupplyAssets();
    }

    function totalSupplyShares() external view returns (uint256) {
        return VAULT.totalSupplyShares();
    }

    function supplySharesOf(address account) external view returns (uint256) {
        return VAULT.userSupplyShares(account);
    }

    function totalDebt() external view returns (uint256) {
        return VAULT.totalBorrowed();
    }

    function totalDebtShares() external view returns (uint256) {
        return VAULT.totalBorrowShares();
    }

    function debtSharesOf(address account) external view returns (uint256) {
        return VAULT.userBorrowShares(account);
    }

    function debtOf(address account) external view returns (uint256) {
        return VAULT.userDebt(account);
    }

    function collateralOf(address account) external view returns (uint256) {
        return VAULT.userCollateral(account);
    }

    /// @dev Reverts with {Vault.OraclePriceStale} when the oracle is stale.
    function collateralValueOf(address account) external view returns (uint256) {
        return VAULT.collateralValue(account);
    }

    function sharePrice() external view returns (uint256) {
        return VAULT.sharePrice();
    }

    function realizedLosses() external pure returns (uint256) {
        return 0;
    }

    /// @dev The raw oracle price, as {Vault.liquidate} reads it (no staleness gate).
    function collateralPrice() external view returns (uint256) {
        return VAULT.oracle().price();
    }

    function liquidationThresholdBps() external view returns (uint256) {
        return VAULT.collateralRatio();
    }

    function liquidationBonusBps() external view returns (uint256) {
        return VAULT.liquidationBonus();
    }
}
