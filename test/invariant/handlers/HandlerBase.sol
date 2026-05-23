// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../../../src/Vault.sol";
import {MockERC20} from "../../../src/MockERC20.sol";

/// @title  HandlerBase — shared actor set and funding for every invariant handler.
/// @notice The handlers share a deterministic five-actor set. `makeAddr` is
///         deterministic, so each handler can independently reconstruct the
///         same five addresses by label. This base contract centralises the
///         actor labels, funds each actor with both assets, and grants
///         unlimited vault allowances — so every handler can prank an actor
///         knowing its balance, allowance and identity are consistent across
///         the whole campaign.
abstract contract HandlerBase is Test {
    /// @notice The vault under test.
    Vault internal immutable VAULT;
    /// @notice The debt asset (lendable / borrowable).
    MockERC20 internal immutable DEBT;
    /// @notice The collateral asset.
    MockERC20 internal immutable COLLATERAL;

    /// @notice The five-actor set, in `user1..user5` order.
    address[] internal actors;

    /// @notice Per-actor opening balance of *each* asset, in WAD units.
    ///         500,000 of each is large enough that bounded handler actions
    ///         essentially never starve an actor, so calls succeed as
    ///         intended rather than short-circuiting on balance.
    uint256 internal constant ACTOR_FUND = 500_000e18;

    constructor(Vault _vault, MockERC20 _debt, MockERC20 _collateral) {
        VAULT = _vault;
        DEBT = _debt;
        COLLATERAL = _collateral;

        for (uint256 i = 0; i < 5; i++) {
            address actor = makeAddr(string.concat("user", vm.toString(i + 1)));
            actors.push(actor);
            DEBT.mint(actor, ACTOR_FUND);
            COLLATERAL.mint(actor, ACTOR_FUND);
            vm.startPrank(actor);
            DEBT.approve(address(VAULT), type(uint256).max);
            COLLATERAL.approve(address(VAULT), type(uint256).max);
            vm.stopPrank();
        }
    }

    /// @notice The full actor set, for invariant functions that iterate users.
    function getActors() external view returns (address[] memory) {
        return actors;
    }

    /// @notice Sum of `userSupplyShares` across every actor — used to assert INV-02.
    function sumSupplyShares() external view returns (uint256 sum) {
        for (uint256 i = 0; i < actors.length; i++) {
            sum += VAULT.userSupplyShares(actors[i]);
        }
    }

    /// @notice Sum of `userBorrowShares` across every actor — used to assert INV-03.
    function sumBorrowShares() external view returns (uint256 sum) {
        for (uint256 i = 0; i < actors.length; i++) {
            sum += VAULT.userBorrowShares(actors[i]);
        }
    }

    /// @notice Pick an actor deterministically from a fuzz seed.
    function _pickActor(uint256 seed) internal view returns (address) {
        return actors[bound(seed, 0, actors.length - 1)];
    }
}
