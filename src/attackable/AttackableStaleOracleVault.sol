// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vault} from "../Vault.sol";

/// @title  AttackableStaleOracleVault — Vault that reads the oracle without freshness checks
/// @notice Demo-only attackable surface used by `test/exploit/` (EXP-09). The
///         canonical {Vault._freshPrice} reverts with `OraclePriceStale`
///         whenever the oracle is older than `MAX_STALENESS` — the freshness
///         gate INV-11 pins. This variant drops that check, so a stale
///         oracle can be used to liquidate or borrow at an outdated price.
///         The Beanstalk-style class: act on a price the contract should no
///         longer trust.
/// @dev    Inherits {Vault} and overrides {_freshPrice} only.
contract AttackableStaleOracleVault is Vault {
    constructor(
        address _debtAsset,
        address _collateralAsset,
        address _oracle,
        uint256 _aprBps,
        uint256 _liquidationBonus
    ) Vault(_debtAsset, _collateralAsset, _oracle, _aprBps, _liquidationBonus) {}

    /// @inheritdoc Vault
    /// @dev INTENTIONAL OMISSION: no staleness check.
    function _freshPrice() internal view override returns (uint256) {
        return oracle.price();
    }
}
