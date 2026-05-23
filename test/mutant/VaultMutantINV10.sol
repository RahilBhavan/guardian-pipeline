// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vault} from "../../src/Vault.sol";

/// @title  VaultMutantINV10 — deliberately broken userDebt() to tension INV-10
/// @notice A Vault subclass whose {userDebt} CEIL-divides instead of
///         FLOOR-divides. Each individual borrower's reported debt rounds
///         up by up to one wei, so the sum across many borrowers can
///         exceed the floored {totalBorrowed} — i.e. the protocol is short
///         the rounding difference. INV-10 (debt rounding favours the
///         protocol) must fail against this mutant; if it ever passes,
///         the predicate in
///         {InvariantVault.invariant_debtRoundingFavoursProtocol} is not
///         actually load-bearing.
contract VaultMutantINV10 is Vault {
    constructor(
        address _debtAsset,
        address _collateralAsset,
        address _oracle,
        uint256 _aprBps,
        uint256 _liquidationBonus
    ) Vault(_debtAsset, _collateralAsset, _oracle, _aprBps, _liquidationBonus) {}

    /// @inheritdoc Vault
    function userDebt(address user) public view override returns (uint256) {
        uint256 product = userBorrowShares[user] * borrowIndex;
        if (product == 0) return 0;
        // BUG: ceil division instead of floor.
        return (product + WAD - 1) / WAD;
    }
}
