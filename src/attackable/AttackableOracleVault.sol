// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vault} from "../Vault.sol";

/// @title  AttackableOracleVault — Vault wired to a Cream-2021-style balance oracle
/// @notice Identical to {Vault}; the attackable property lives in the oracle
///         it is constructed with. EXP-03 deploys this together with a
///         {BalanceDerivedOracle} that reads the vault's own collateral
///         balance — donating collateral inflates the reported price, lets
///         the attacker borrow against the inflated value, and drains the
///         lender side. The canonical {Vault} is identical code; the test
///         asserts the structural defense is the *oracle* it is paired with.
/// @dev    A class-of-bugs proof: the vulnerable surface in EXP-03 is not the
///         vault's code, it is the oracle adapter chosen at deployment time.
///         Defense surface = "the canonical {MockOracle} is not
///         balance-derived" — verified by EXP-03 donating to the canonical
///         vault and asserting the canonical price() does not move.
contract AttackableOracleVault is Vault {
    constructor(
        address _debtAsset,
        address _collateralAsset,
        address _oracle,
        uint256 _aprBps,
        uint256 _liquidationBonus
    ) Vault(_debtAsset, _collateralAsset, _oracle, _aprBps, _liquidationBonus) {}
}
