// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../../src/Vault.sol";
import {MockERC20} from "../../src/MockERC20.sol";
import {MockOracle} from "../../src/MockOracle.sol";
import {VaultMutantINV07} from "./VaultMutantINV07.sol";

/// @title  MutantINV07 — proves INV-07 (solvency monotonicity) is load-bearing
/// @notice Pairs the real {Vault} against {VaultMutantINV07} on identical
///         pre-states and exercises a single borrow large enough that floor
///         rounding strips at least one wei from the recorded debt. The
///         real Vault's solvency margin must hold or grow; the mutant's
///         must shrink. If either branch flips, INV-07's predicate is no
///         longer catching this rounding-direction class of bug.
contract MutantINV07Test is Test {
    uint256 internal constant INITIAL_PRICE = 2_000e18;
    uint256 internal constant APR_BPS = 10_00;
    uint256 internal constant LIQ_BONUS_BPS = 5_00;

    /// @notice Real Vault: a borrow does not shrink totalAssets. Since the
    ///         borrow runs in the same block as the seed accrue(),
    ///         totalSupplyAssets is steady across the call, so a
    ///         non-decreasing totalAssets is equivalent to a non-decreasing
    ///         solvency margin. Comparing totalAssets directly avoids the
    ///         unsigned underflow that fires when the mutant drives margin
    ///         below zero.
    function test_realVault_borrowDoesNotShrinkTotalAssets() public {
        (Vault v, MockERC20 d, MockERC20 c,) = _deploy(false);
        _seedAndWarp(v, d, c);
        (, address borrower) = _actors();

        uint256 totalAssetsBefore = v.totalAssets();
        uint256 totalSupplyBefore = v.totalSupplyAssets();

        // 50_000e18 + 1 ensures the ceil-vs-floor decision actually matters
        // - the +1 wei forces a rounding step the floor mutant absorbs and
        // the real (ceil) Vault charges.
        vm.prank(borrower);
        v.borrow(50_000e18 + 1);

        assertGe(v.totalAssets(), totalAssetsBefore, "real Vault: totalAssets shrank on borrow");
        assertEq(v.totalSupplyAssets(), totalSupplyBefore, "real Vault: totalSupplyAssets moved");
    }

    /// @notice Mutant Vault: the SAME borrow MUST strictly shrink totalAssets
    ///         (margin goes negative — equivalently, INV-01 itself is also
    ///         broken). If this assertion ever stops firing, the rounding
    ///         direction of borrow shares is no longer caught by INV-07.
    function test_mutantVault_borrowShrinksTotalAssets() public {
        (Vault v, MockERC20 d, MockERC20 c,) = _deploy(true);
        _seedAndWarp(v, d, c);
        (, address borrower) = _actors();

        uint256 totalAssetsBefore = v.totalAssets();
        uint256 totalSupplyBefore = v.totalSupplyAssets();

        vm.prank(borrower);
        v.borrow(50_000e18 + 1);

        assertLt(
            v.totalAssets(),
            totalAssetsBefore,
            "MUTANT: totalAssets did not shrink on borrow - INV-07 would not have caught this"
        );
        assertEq(v.totalSupplyAssets(), totalSupplyBefore, "MUTANT: totalSupplyAssets moved unexpectedly");
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
            v = Vault(address(new VaultMutantINV07(address(d), address(c), address(o), APR_BPS, LIQ_BONUS_BPS)));
        } else {
            v = new Vault(address(d), address(c), address(o), APR_BPS, LIQ_BONUS_BPS);
        }
    }

    function _actors() internal pure returns (address lp, address borrower) {
        lp = address(uint160(uint256(keccak256("inv07.lp"))));
        borrower = address(uint160(uint256(keccak256("inv07.borrower"))));
    }

    /// @dev Seed liquidity, fund a borrower with collateral, and advance time
    ///      so borrowIndex grows above 1e18 — the rounding-direction split
    ///      between floor and ceil only opens up once `borrowIndex > WAD`.
    function _seedAndWarp(Vault v, MockERC20 d, MockERC20 c) internal {
        (address lp, address borrower) = _actors();

        d.mint(lp, 200_000e18);
        c.mint(borrower, 100e18);

        vm.startPrank(lp);
        d.approve(address(v), type(uint256).max);
        v.deposit(200_000e18);
        vm.stopPrank();

        vm.startPrank(borrower);
        c.approve(address(v), type(uint256).max);
        v.depositCollateral(80e18); // 80 * 2,000 = 160,000 -> 128,000 cap
        v.borrow(10_000e18); // seed some debt so accrue() does work
        vm.stopPrank();

        // One year at 10% APR pushes borrowIndex well above WAD, so the
        // +1-wei split between floor and ceil yields a non-zero gap.
        vm.warp(block.timestamp + 365 days);
        v.accrue();
    }
}
