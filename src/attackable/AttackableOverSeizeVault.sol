// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vault} from "../Vault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title  AttackableOverSeizeVault — Vault whose liquidation breaks the bonus cap
/// @notice Demo-only attackable surface used by `test/exploit/` (EXP-05 and
///         EXP-07). The canonical {Vault.liquidate} caps the seized
///         collateral at `paid * (BPS + bonus) / BPS` (the no-free-lunch
///         property the harness pins as INV-08). This variant doubles the
///         seizure — every liquidation extracts twice the bonus and
///         instantly drains the borrower's collateral past the contract's
///         own intent.
/// @dev    Inherits {Vault} and overrides {liquidate} so the rest of the
///         accounting is untouched. The single intentional defect is the
///         doubled `seizeValue` formula.
contract AttackableOverSeizeVault is Vault {
    using SafeERC20 for IERC20;

    constructor(
        address _debtAsset,
        address _collateralAsset,
        address _oracle,
        uint256 _aprBps,
        uint256 _liquidationBonus
    ) Vault(_debtAsset, _collateralAsset, _oracle, _aprBps, _liquidationBonus) {}

    /// @inheritdoc Vault
    /// @dev INTENTIONAL DEFECT: the seizeValue computation is doubled
    ///      (`(BPS + 2*bonus)` instead of `(BPS + bonus)`), so the liquidator
    ///      extracts more collateral than the bonus permits.
    function liquidate(address borrower, uint256 amount)
        external
        override
        nonReentrant
    {
        accrue();

        uint256 debt = userDebt(borrower);
        if (debt == 0) revert NoDebt();

        uint256 maxBorrow = (collateralValue(borrower) * collateralRatio) / BPS;
        if (debt <= maxBorrow) revert PositionHealthy();

        bool fullClose = amount >= debt;
        uint256 plannedPay = fullClose ? debt : amount;
        if (plannedPay == 0) revert ZeroAmount();

        uint256 price = oracle.price();
        // INTENTIONAL DEFECT: doubled bonus — the no-free-lunch class.
        uint256 seizeValue = (plannedPay * (BPS + 2 * liquidationBonus)) / BPS;
        uint256 seizeCollateral = (seizeValue * WAD) / price;

        if (seizeCollateral > userCollateral[borrower]) {
            seizeCollateral = userCollateral[borrower];
        }

        uint256 borrowedBefore = totalBorrowed();
        uint256 burned;
        uint256 pay;
        if (fullClose) {
            burned = userBorrowShares[borrower];
            userBorrowShares[borrower] = 0;
            totalBorrowShares -= burned;
            pay = borrowedBefore - totalBorrowed();
        } else {
            pay = amount;
            burned = (pay * WAD) / borrowIndex;
            userBorrowShares[borrower] -= burned;
            totalBorrowShares -= burned;
        }

        userCollateral[borrower] -= seizeCollateral;
        totalCollateral -= seizeCollateral;

        debtAsset.safeTransferFrom(msg.sender, address(this), pay);
        collateralAsset.safeTransfer(msg.sender, seizeCollateral);

        emit Liquidated(msg.sender, borrower, pay, seizeCollateral);
    }
}
