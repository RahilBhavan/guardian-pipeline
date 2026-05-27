// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vault} from "../Vault.sol";

/// @title  AttackableEulerStyleVault — replants the Euler 2023 donateToReserves bug
/// @notice Demo-only attackable surface used by `test/exploit/` (EXP-02). Carries
///         the historical defect verbatim: a `donateToReserves(uint256)` path
///         that burns the donor's collateral receipt without re-running the
///         cap check on the resulting under-water position. A confederate then
///         liquidates the donor for the bonus, exactly as in Euler Finance,
///         13 March 2023 (~$197M).
/// @dev    Never deployed. This contract exists so EXP-02 can prove the
///         historical mechanism *does* drain a vault that lacks the
///         post-state recheck, and that the canonical {Vault} has no such
///         surface (the `donateToReserves(uint256)` selector is absent).
contract AttackableEulerStyleVault is Vault {
    /// @param _debtAsset        See {Vault}.
    /// @param _collateralAsset  See {Vault}.
    /// @param _oracle           See {Vault}.
    /// @param _aprBps           See {Vault}.
    /// @param _liquidationBonus See {Vault}.
    constructor(
        address _debtAsset,
        address _collateralAsset,
        address _oracle,
        uint256 _aprBps,
        uint256 _liquidationBonus
    ) Vault(_debtAsset, _collateralAsset, _oracle, _aprBps, _liquidationBonus) {}

    /// @notice The Euler 2023 defect, replanted: drops `amount` of the
    ///         caller's collateral *without* re-running the collateral-cap
    ///         check on the post-state. A borrower at the cap can use this
    ///         to push themselves under water with no health gate.
    /// @dev    The intentional omission is the missing
    ///         `userDebt(msg.sender) > maxBorrow` recheck after the balance
    ///         drop — every collateral-reducing path on the canonical {Vault}
    ///         re-runs it (see {Vault.withdrawCollateral}).
    /// @param amount Collateral units to burn from the caller.
    function donateToReserves(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (amount > userCollateral[msg.sender]) revert InsufficientCollateral();
        userCollateral[msg.sender] -= amount;
        totalCollateral -= amount;
        // INTENTIONAL OMISSION: no cap recheck. The historical Euler defect.
    }
}
