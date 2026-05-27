// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vault} from "../../src/Vault.sol";

/// @title  VaultMutantINV09 — deliberately broken accrue() to tension INV-09
/// @notice A Vault subclass whose {accrue} SUBTRACTS the interest delta
///         from `borrowIndex` instead of adding it — i.e. negative interest.
///         Borrow shares stay flat (no one is borrowing or repaying in the
///         mutant test), so `userDebt = userBorrowShares * borrowIndex /
///         WAD` falls in lockstep with the index. INV-09 (per-position
///         debt monotonicity under accrual) must fail against this mutant;
///         if it ever passes, the predicate in
///         {InvariantVault.invariant_debtMonotoneUnderAccrual} is not
///         actually load-bearing.
contract VaultMutantINV09 is Vault {
    constructor(
        address _debtAsset,
        address _collateralAsset,
        address _oracle,
        uint256 _aprBps,
        uint256 _liquidationBonus
    ) Vault(_debtAsset, _collateralAsset, _oracle, _aprBps, _liquidationBonus) {}

    /// @inheritdoc Vault
    function accrue() public override {
        uint256 dt = block.timestamp - lastAccrualTime;
        if (dt == 0) return;
        lastAccrualTime = block.timestamp;

        uint256 borrowedBefore = totalBorrowed();
        if (borrowedBefore == 0) return;

        // BUG: subtract the interest delta rather than add it.
        uint256 delta = (borrowIndex * borrowRatePerSecond * dt) / WAD;
        if (delta >= borrowIndex) delta = borrowIndex - 1; // keep index above zero
        borrowIndex -= delta;
    }
}
