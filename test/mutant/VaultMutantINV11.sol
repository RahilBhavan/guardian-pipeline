// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vault} from "../../src/Vault.sol";

/// @title  VaultMutantINV11 — drops the oracle freshness gate to tension INV-11
/// @notice A Vault subclass whose {_freshPrice} returns `oracle.price()`
///         without checking {IPriceOracle.lastUpdatedAt}. Borrows,
///         withdrawCollateral and liquidate calls succeed against an
///         arbitrarily-stale oracle — the exact class INV-11 exists to
///         block. If the predicate proven in
///         `test/mutant/MutantINV11.t.sol` ever stops firing, the gate is
///         no longer load-bearing.
contract VaultMutantINV11 is Vault {
    constructor(
        address _debtAsset,
        address _collateralAsset,
        address _oracle,
        uint256 _aprBps,
        uint256 _liquidationBonus
    ) Vault(_debtAsset, _collateralAsset, _oracle, _aprBps, _liquidationBonus) {}

    /// @inheritdoc Vault
    function _freshPrice() internal view override returns (uint256) {
        // BUG: no freshness check.
        return oracle.price();
    }
}
