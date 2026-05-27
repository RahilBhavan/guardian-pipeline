// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vault} from "../Vault.sol";

/// @title  AttackableCeilDebtVault — Vault with the Compound-style debt-rounding defect
/// @notice Demo-only attackable surface used by `test/exploit/` (EXP-08). The
///         canonical {Vault.userDebt} floor-divides
///         (`userBorrowShares * borrowIndex / WAD`), so the sum across
///         borrowers can never exceed {Vault.totalBorrowed} — the property
///         INV-10 pins. This variant ceil-divides, so each borrower's
///         `userDebt` is rounded up by up to one wei; with N borrowers the
///         sum exceeds `totalBorrowed` by up to N wei and INV-10 fails.
/// @dev    Inherits {Vault} and overrides {userDebt} only — every other path
///         is identical to the canonical Vault.
contract AttackableCeilDebtVault is Vault {
    constructor(
        address _debtAsset,
        address _collateralAsset,
        address _oracle,
        uint256 _aprBps,
        uint256 _liquidationBonus
    ) Vault(_debtAsset, _collateralAsset, _oracle, _aprBps, _liquidationBonus) {}

    /// @inheritdoc Vault
    /// @dev INTENTIONAL DEFECT: ceil division instead of floor. Sum across
    ///      borrowers exceeds {totalBorrowed} — INV-10 fires.
    function userDebt(address user) public view override returns (uint256) {
        uint256 shares = userBorrowShares[user];
        if (shares == 0) return 0;
        return (shares * borrowIndex + WAD - 1) / WAD;
    }
}
