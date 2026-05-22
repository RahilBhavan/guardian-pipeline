// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../../../src/Vault.sol";
import {MockERC20} from "../../../src/MockERC20.sol";

/// @title DepositHandler — bounded action space for deposits & withdrawals
/// @notice Foundry calls these functions with random inputs during invariant
///         runs. Inputs are bounded to realistic ranges so the fuzzer spends
///         its budget exploring meaningful state rather than trivial reverts.
///         This handler also owns the canonical five-actor set; `makeAddr` is
///         deterministic, so the other handlers reconstruct the same addresses.
contract DepositHandler is Test {
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
            token.mint(actor, 500_000e18);
            vm.prank(actor);
            token.approve(address(vault), type(uint256).max);
        }
    }

    /// @notice Fuzz entrypoint: deposit a bounded amount as a pseudo-random actor.
    function deposit(uint256 actorSeed, uint256 amount) external {
        address actor = actors[bound(actorSeed, 0, actors.length - 1)];
        amount = bound(amount, 1, 100_000e18);

        vm.prank(actor);
        try vault.deposit(amount) {} catch {}
    }

    /// @notice Fuzz entrypoint: withdraw a bounded share count as a pseudo-random actor.
    function withdraw(uint256 actorSeed, uint256 sharesSeed) external {
        address actor = actors[bound(actorSeed, 0, actors.length - 1)];
        uint256 shares = bound(sharesSeed, 0, vault.userSupplyShares(actor));
        if (shares == 0) return;

        vm.prank(actor);
        try vault.withdraw(shares) {} catch {}
    }

    /// @notice Sum of `userSupplyShares` across every actor — used to assert INV-02.
    function sumSupplyShares() external view returns (uint256 sum) {
        for (uint256 i = 0; i < actors.length; i++) {
            sum += vault.userSupplyShares(actors[i]);
        }
    }

    /// @notice Sum of `userBorrowShares` across every actor — used to assert INV-03.
    function sumBorrowShares() external view returns (uint256 sum) {
        for (uint256 i = 0; i < actors.length; i++) {
            sum += vault.userBorrowShares(actors[i]);
        }
    }

    /// @notice The full actor set, for invariant functions that iterate users.
    function getActors() external view returns (address[] memory) {
        return actors;
    }
}
