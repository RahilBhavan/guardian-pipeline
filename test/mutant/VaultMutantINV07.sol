// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vault} from "../../src/Vault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title  VaultMutantINV07 — deliberately broken borrow() to tension INV-07
/// @notice A Vault subclass whose {borrow} computes borrow shares with
///         FLOOR division instead of the real Vault's CEIL. Floor lets the
///         borrower's recorded debt undercount the assets they receive, so
///         after a borrow `cash + totalBorrowed < cash_before +
///         totalBorrowed_before` — i.e. the solvency margin SHRINKS by the
///         rounding loss. INV-07 (per-block solvency monotonicity) must
///         fail against this mutant; if it ever passes, the invariant
///         predicate in {InvariantVault.invariant_solvencyMonotone} is not
///         actually load-bearing.
contract VaultMutantINV07 is Vault {
    using SafeERC20 for IERC20;

    constructor(
        address _debtAsset,
        address _collateralAsset,
        address _oracle,
        uint256 _aprBps,
        uint256 _liquidationBonus
    ) Vault(_debtAsset, _collateralAsset, _oracle, _aprBps, _liquidationBonus) {}

    /// @inheritdoc Vault
    function borrow(uint256 amount) external override nonReentrant {
        accrue();
        if (amount == 0) revert ZeroAmount();

        uint256 maxBorrow = (collateralValue(msg.sender) * collateralRatio) / BPS;
        if (userDebt(msg.sender) + amount > maxBorrow) revert CollateralCapExceeded();

        if (debtAsset.balanceOf(address(this)) < amount) revert InsufficientLiquidity();

        // BUG: floor division — the borrower's recorded debt can be less
        // than the asset they receive, eroding the solvency margin.
        uint256 borrowShares = (amount * WAD) / borrowIndex;

        totalBorrowShares += borrowShares;
        userBorrowShares[msg.sender] += borrowShares;

        debtAsset.safeTransfer(msg.sender, amount);
    }
}
