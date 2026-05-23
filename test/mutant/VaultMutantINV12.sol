// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vault} from "../../src/Vault.sol";

/// @title  VaultMutantINV12 — deliberately broken accrue() to tension INV-12
/// @notice A Vault subclass whose {accrue} computes `dt` as
///         `block.timestamp - lastAccrualTime + 1`, so every call charges at
///         least one second of interest — even when zero real time has
///         passed. INV-12 (accrue idempotence within a block) must fail
///         against this mutant; if it ever passes, the invariant predicate
///         in {InvariantVault.invariant_accrueIdempotent} is not actually
///         load-bearing.
contract VaultMutantINV12 is Vault {
    constructor(
        address _debtAsset,
        address _collateralAsset,
        address _oracle,
        uint256 _aprBps,
        uint256 _liquidationBonus
    ) Vault(_debtAsset, _collateralAsset, _oracle, _aprBps, _liquidationBonus) {}

    /// @inheritdoc Vault
    function accrue() public override {
        uint256 dt = block.timestamp - lastAccrualTime + 1; // BUG: +1 always.
        lastAccrualTime = block.timestamp;

        uint256 borrowedBefore = totalBorrowed();
        if (borrowedBefore == 0) return;

        borrowIndex += (borrowIndex * borrowRatePerSecond * dt) / WAD;

        uint256 interest = totalBorrowed() - borrowedBefore;
        if (interest > 0) {
            totalSupplyAssets += interest;
        }
    }
}
