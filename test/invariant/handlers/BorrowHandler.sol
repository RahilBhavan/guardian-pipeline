// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../../../src/Vault.sol";
import {MockERC20} from "../../../src/MockERC20.sol";

/// @title BorrowHandler — bounded action space for borrows & repayments
/// @notice Shares the same five actors as {DepositHandler}: `makeAddr` is
///         deterministic, so identical labels yield identical addresses across
///         handlers, letting borrows act on shares minted by the deposit handler.
contract BorrowHandler is Test {
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
            // Idempotent with DepositHandler — guarantees repay() can transfer in.
            vm.prank(actor);
            token.approve(address(vault), type(uint256).max);
        }
    }

    /// @notice Fuzz entrypoint: borrow a bounded amount as a pseudo-random actor.
    function borrow(uint256 actorSeed, uint256 amount) external {
        address actor = actors[bound(actorSeed, 0, actors.length - 1)];
        amount = bound(amount, 1, 50_000e18);

        vm.prank(actor);
        try vault.borrow(amount) {} catch {}
    }

    /// @notice Fuzz entrypoint: repay a bounded amount as a pseudo-random actor.
    function repay(uint256 actorSeed, uint256 amount) external {
        address actor = actors[bound(actorSeed, 0, actors.length - 1)];
        amount = bound(amount, 0, vault.userBorrowed(actor));
        if (amount == 0) return;

        vm.prank(actor);
        try vault.repay(amount) {} catch {}
    }
}
