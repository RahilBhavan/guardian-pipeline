// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vault} from "../Vault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title  AttackableNoCapVault — Vault without the collateralisation cap on borrow
/// @notice Demo-only attackable surface used by `test/exploit/` (EXP-04). The
///         canonical {Vault.borrow} reverts with `CollateralCapExceeded` when
///         the borrower's debt would exceed the 80% LTV cap. This variant
///         drops that check — the under-collateralised-loan class survives
///         and an attacker can drain free liquidity.
/// @dev    Inherits {Vault} and overrides {borrow} so every other accounting
///         path remains identical. The single intentional omission is the
///         cap-exceeded guard.
contract AttackableNoCapVault is Vault {
    using SafeERC20 for IERC20;

    constructor(
        address _debtAsset,
        address _collateralAsset,
        address _oracle,
        uint256 _aprBps,
        uint256 _liquidationBonus
    ) Vault(_debtAsset, _collateralAsset, _oracle, _aprBps, _liquidationBonus) {}

    /// @inheritdoc Vault
    /// @dev INTENTIONAL OMISSION: no `CollateralCapExceeded` check. The
    ///      borrower can draw more than their collateral backs.
    function borrow(uint256 amount) external override nonReentrant {
        accrue();
        if (amount == 0) revert ZeroAmount();
        // INTENTIONAL OMISSION: no cap check.
        if (debtAsset.balanceOf(address(this)) < amount) revert InsufficientLiquidity();

        uint256 borrowShares = (amount * WAD + borrowIndex - 1) / borrowIndex;
        totalBorrowShares += borrowShares;
        userBorrowShares[msg.sender] += borrowShares;

        debtAsset.safeTransfer(msg.sender, amount);

        emit Borrowed(msg.sender, amount, borrowShares);
    }
}
