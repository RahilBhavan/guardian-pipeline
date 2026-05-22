// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../../../src/Vault.sol";
import {MockERC20} from "../../../src/MockERC20.sol";

/// @title LiquidateHandler — bounded action space for liquidations
/// @notice Lets the fuzzer clear under-water positions. Liquidations only
///         succeed once interest (driven by {WarpHandler}) has pushed a
///         borrower past their collateral cap, so this handler exercises the
///         liquidation path exactly when it is meant to fire.
contract LiquidateHandler is Test {
    Vault public vault;
    MockERC20 public token;
    address[] public actors;

    /// @param _vault The vault under test.
    /// @param _token The ERC-20 asset the vault handles.
    constructor(Vault _vault, MockERC20 _token) {
        vault = _vault;
        token = _token;

        for (uint256 i = 0; i < 5; i++) {
            address actor = makeAddr(string.concat("user", vm.toString(i + 1)));
            actors.push(actor);
            // Liquidators need a balance to repay with and an allowance to spend.
            token.mint(actor, 500_000e18);
            vm.prank(actor);
            token.approve(address(vault), type(uint256).max);
        }
    }

    /// @notice Fuzz entrypoint: a pseudo-random liquidator clears a bounded
    ///         slice of a pseudo-random borrower's debt.
    function liquidate(uint256 liqSeed, uint256 borrowerSeed, uint256 amount) external {
        address liquidator = actors[bound(liqSeed, 0, actors.length - 1)];
        address borrower = actors[bound(borrowerSeed, 0, actors.length - 1)];

        uint256 debt = vault.userDebt(borrower);
        if (debt == 0) return;
        amount = bound(amount, 1, debt);

        vm.prank(liquidator);
        try vault.liquidate(borrower, amount) {} catch {}
    }
}
