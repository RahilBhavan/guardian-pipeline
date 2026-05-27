// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../../src/Vault.sol";
import {MockERC20} from "../../src/MockERC20.sol";
import {MockOracle} from "../../src/MockOracle.sol";
import {VaultMutantINV11} from "./VaultMutantINV11.sol";

/// @title  MutantINV11 — proves INV-11 (oracle freshness gate) is load-bearing
/// @notice Pairs the real {Vault} against {VaultMutantINV11} on identical
///         pre-states. After deposit and collateralisation, the test
///         warps `MAX_STALENESS + 1` seconds without refreshing the oracle.
///         The real Vault's borrow MUST revert with `OraclePriceStale`;
///         the mutant's MUST succeed and transfer the borrowed funds. If
///         either branch flips, the freshness gate is no longer catching
///         the ungated-price-read class of bug.
contract MutantINV11Test is Test {
    uint256 internal constant INITIAL_PRICE = 2_000e18;
    uint256 internal constant APR_BPS = 10_00;
    uint256 internal constant LIQ_BONUS_BPS = 5_00;

    function test_realVault_revertsOnStaleBorrow() public {
        (Vault v, MockERC20 d, MockERC20 c,) = _deploy(false);
        address borrower = _seedAndCollateralise(v, d, c);

        // Advance past MAX_STALENESS without refreshing the oracle.
        vm.warp(block.timestamp + v.MAX_STALENESS() + 1);

        vm.prank(borrower);
        vm.expectRevert(Vault.OraclePriceStale.selector);
        v.borrow(1_000e18);
    }

    function test_mutantVault_acceptsStaleBorrow() public {
        (Vault v, MockERC20 d, MockERC20 c,) = _deploy(true);
        address borrower = _seedAndCollateralise(v, d, c);

        vm.warp(block.timestamp + v.MAX_STALENESS() + 1);

        uint256 balBefore = d.balanceOf(borrower);
        vm.prank(borrower);
        v.borrow(1_000e18);

        assertGt(
            d.balanceOf(borrower),
            balBefore,
            "MUTANT: borrow rejected the stale oracle - INV-11 would not have caught this"
        );
    }

    // --------------------------------------------------------------------- //

    function _deploy(bool mutant)
        internal
        returns (Vault v, MockERC20 d, MockERC20 c, MockOracle o)
    {
        d = new MockERC20();
        c = new MockERC20();
        o = new MockOracle(INITIAL_PRICE);
        if (mutant) {
            v = Vault(address(new VaultMutantINV11(address(d), address(c), address(o), APR_BPS, LIQ_BONUS_BPS)));
        } else {
            v = new Vault(address(d), address(c), address(o), APR_BPS, LIQ_BONUS_BPS);
        }
    }

    function _seedAndCollateralise(Vault v, MockERC20 d, MockERC20 c) internal returns (address borrower) {
        address lp = address(uint160(uint256(keccak256("inv11.lp"))));
        borrower = address(uint160(uint256(keccak256("inv11.borrower"))));

        d.mint(lp, 100_000e18);
        c.mint(borrower, 100e18);

        vm.startPrank(lp);
        d.approve(address(v), type(uint256).max);
        v.deposit(100_000e18);
        vm.stopPrank();

        vm.startPrank(borrower);
        c.approve(address(v), type(uint256).max);
        v.depositCollateral(50e18);
        vm.stopPrank();
    }
}
