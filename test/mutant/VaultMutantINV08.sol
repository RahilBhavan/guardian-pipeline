// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vault} from "../../src/Vault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title  VaultMutantINV08 — deliberately broken liquidate() to tension INV-08
/// @notice A Vault subclass whose {liquidate} computes `seizeValue` as
///         `plannedPay * (BPS + liquidationBonus) * 2 / BPS` — twice the
///         bonus formula. The liquidator walks away with ~2× the collateral
///         value the real contract would have permitted, breaking the
///         no-free-lunch property INV-08 enforces. The body otherwise
///         mirrors the real Vault's partial-close path (the test uses
///         partial closes only). If INV-08's predicate ever stops catching
///         this 2× seize class, the invariant is no longer load-bearing.
contract VaultMutantINV08 is Vault {
    using SafeERC20 for IERC20;

    constructor(
        address _debtAsset,
        address _collateralAsset,
        address _oracle,
        uint256 _aprBps,
        uint256 _liquidationBonus
    ) Vault(_debtAsset, _collateralAsset, _oracle, _aprBps, _liquidationBonus) {}

    /// @inheritdoc Vault
    function liquidate(address borrower, uint256 amount) external override nonReentrant {
        accrue();

        uint256 debt = userDebt(borrower);
        if (debt == 0) revert NoDebt();

        uint256 maxBorrow = (collateralValue(borrower) * collateralRatio) / BPS;
        if (debt <= maxBorrow) revert PositionHealthy();

        bool fullClose = amount >= debt;
        uint256 plannedPay = fullClose ? debt : amount;
        if (plannedPay == 0) revert ZeroAmount();

        uint256 price = oracle.price();
        // BUG: 2x the bonus formula.
        uint256 seizeValue = (plannedPay * (BPS + liquidationBonus) * 2) / BPS;
        uint256 seizeCollateral = (seizeValue * WAD) / price;

        if (seizeCollateral >= userCollateral[borrower]) {
            if (!fullClose) revert MustClearDebt();
            seizeCollateral = userCollateral[borrower];
        }

        uint256 pay;
        if (fullClose) {
            uint256 borrowedBefore = totalBorrowed();
            uint256 burned = userBorrowShares[borrower];
            userBorrowShares[borrower] = 0;
            totalBorrowShares -= burned;
            pay = borrowedBefore - totalBorrowed();
        } else {
            pay = amount;
            uint256 burned = (pay * WAD) / borrowIndex;
            userBorrowShares[borrower] -= burned;
            totalBorrowShares -= burned;
        }

        userCollateral[borrower] -= seizeCollateral;
        totalCollateral -= seizeCollateral;

        debtAsset.safeTransferFrom(msg.sender, address(this), pay);
        collateralAsset.safeTransfer(msg.sender, seizeCollateral);
    }
}
