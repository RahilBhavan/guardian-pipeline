// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../../src/Vault.sol";
import {MockERC20} from "../../src/MockERC20.sol";
import {MockOracle} from "../../src/MockOracle.sol";

/// @title VaultBurnDebt — focused boundary tests for `_burnDebt`.
/// @notice `_burnDebt` is the rounding-critical heart of {Vault.repay} and
///         {Vault.liquidate}. The invariant harness already proves no random
///         sequence breaks the protocol's six properties, but it does so by
///         shotgunning: a leaky rounding choice in `_burnDebt` would surface
///         as an INV-01 failure several calls later, after shrinking. This
///         suite pins each rounding boundary down on its own:
///
///         - A *full close* charges exactly the realised drop in
///           `totalBorrowed` — by construction, the floor-divided debt or one
///           wei more. Solvency margin never shrinks.
///         - A *partial repay* burns floor-divided shares — so a tiny payment
///           below one share's worth burns zero shares but still grows cash.
///         - A *full close on a single-borrower vault* zeroes
///           `totalBorrowShares` and `totalBorrowed` exactly.
///         - A *full close on a multi-borrower vault* leaves every other
///           borrower's debt unchanged within one wei of index rounding.
///         - A *liquidation full close* zeroes the seized borrower's debt and
///           respects {MustClearDebt} when the bonus would otherwise consume
///           all collateral on a partial close.
///
///         `_burnDebt` itself is `private`, so every assertion goes through
///         the public `repay` / `liquidate` entrypoints.
contract VaultBurnDebt is Test {
    Vault internal vault;
    MockERC20 internal debt;
    MockERC20 internal collateral;
    MockOracle internal oracle;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");
    address internal liquidator = makeAddr("liquidator");

    uint256 internal constant FUND = 10_000_000e18;
    uint256 internal constant APR_BPS = 10_00; // 10% APR
    uint256 internal constant LIQ_BONUS_BPS = 5_00; // 5% bonus
    uint256 internal constant INITIAL_PRICE = 2_000e18;

    function setUp() public {
        debt = new MockERC20();
        collateral = new MockERC20();
        oracle = new MockOracle(INITIAL_PRICE);
        vault =
            new Vault(address(debt), address(collateral), address(oracle), APR_BPS, LIQ_BONUS_BPS);

        address[5] memory actors = [alice, bob, carol, dave, liquidator];
        for (uint256 i = 0; i < actors.length; i++) {
            debt.mint(actors[i], FUND);
            collateral.mint(actors[i], FUND);
            vm.startPrank(actors[i]);
            debt.approve(address(vault), type(uint256).max);
            collateral.approve(address(vault), type(uint256).max);
            vm.stopPrank();
        }
    }

    // --------------------------------------------------------------------- //
    //                          Full-close repay path                        //
    // --------------------------------------------------------------------- //

    /// @notice After a long warp, a repay with `offered >= debt` charges the
    ///         exact realised drop in `totalBorrowed`, burns every borrow
    ///         share the caller held, and leaves `userDebt == 0`. Solvency
    ///         margin must not shrink.
    function test_burnDebt_fullClose_chargesExactRealisedDelta() public {
        vm.prank(alice);
        vault.deposit(1_000_000e18);

        vm.startPrank(bob);
        vault.depositCollateral(100e18); // 100 * 2000 = 200,000 value → 160,000 cap
        vault.borrow(50_000e18);
        vm.stopPrank();

        vm.warp(block.timestamp + 4_000 days);
        vault.accrue();

        uint256 debtAmt = vault.userDebt(bob);
        uint256 borrowedBefore = vault.totalBorrowed();
        uint256 solvencyBefore = vault.totalAssets() - vault.totalSupplyAssets();
        uint256 cashBefore = vault.cash();

        vm.prank(bob);
        vault.repay(debtAmt + 123); // generous slop

        assertEq(vault.userBorrowShares(bob), 0, "bob shares not zeroed");
        assertEq(vault.userDebt(bob), 0, "bob debt not zeroed");

        uint256 cashDelta = vault.cash() - cashBefore;
        uint256 realisedDrop = borrowedBefore - vault.totalBorrowed();
        assertEq(cashDelta, realisedDrop, "cash delta != realised drop");
        assertApproxEqAbs(cashDelta, debtAmt, 1, "charge differs from debt by > 1 wei");

        uint256 solvencyAfter = vault.totalAssets() - vault.totalSupplyAssets();
        assertGe(solvencyAfter, solvencyBefore, "solvency margin shrank");
    }

    /// @notice On a single-borrower vault, a full close zeroes both
    ///         `totalBorrowShares` and `totalBorrowed` exactly.
    function test_burnDebt_fullClose_singleBorrowerZeroesAggregates() public {
        vm.prank(alice);
        vault.deposit(500_000e18);

        vm.startPrank(bob);
        vault.depositCollateral(50e18); // 100,000 value → 80,000 cap
        vault.borrow(40_000e18);
        vm.stopPrank();

        vm.warp(block.timestamp + 90 days);
        vault.accrue();

        assertGt(vault.totalBorrowShares(), 0, "preconditions: bob has shares");

        uint256 debtAmt = vault.userDebt(bob);
        vm.prank(bob);
        vault.repay(debtAmt + 1);

        assertEq(vault.totalBorrowShares(), 0, "totalBorrowShares not zero");
        assertEq(vault.totalBorrowed(), 0, "totalBorrowed not zero");
        assertEq(vault.userBorrowShares(bob), 0, "bob's shares not zero");
    }

    /// @notice On a multi-borrower vault, a full close leaves every other
    ///         borrower's debt and shares untouched.
    function test_burnDebt_fullClose_multiBorrowerLeavesOthersUntouched() public {
        vm.prank(alice);
        vault.deposit(1_000_000e18);

        vm.startPrank(bob);
        vault.depositCollateral(50e18);
        vault.borrow(20_000e18);
        vm.stopPrank();

        vm.startPrank(carol);
        vault.depositCollateral(50e18);
        vault.borrow(30_000e18);
        vm.stopPrank();

        vm.startPrank(dave);
        vault.depositCollateral(50e18);
        vault.borrow(40_000e18);
        vm.stopPrank();

        vm.warp(block.timestamp + 365 days);
        vault.accrue();

        uint256 carolSharesBefore = vault.userBorrowShares(carol);
        uint256 daveSharesBefore = vault.userBorrowShares(dave);
        uint256 carolDebtBefore = vault.userDebt(carol);
        uint256 daveDebtBefore = vault.userDebt(dave);

        uint256 bobDebt = vault.userDebt(bob);
        vm.prank(bob);
        vault.repay(bobDebt + 100);

        assertEq(vault.userBorrowShares(carol), carolSharesBefore, "carol shares moved");
        assertEq(vault.userBorrowShares(dave), daveSharesBefore, "dave shares moved");
        assertEq(vault.userDebt(carol), carolDebtBefore, "carol debt moved");
        assertEq(vault.userDebt(dave), daveDebtBefore, "dave debt moved");

        uint256 perUserSum = vault.userDebt(carol) + vault.userDebt(dave);
        assertApproxEqAbs(perUserSum, vault.totalBorrowed(), 1, "per-user sum differs > 1 wei");
    }

    // --------------------------------------------------------------------- //
    //                       Partial repay rounding path                     //
    // --------------------------------------------------------------------- //

    /// @notice A partial repay where `offered * WAD < borrowIndex` burns zero
    ///         shares but still pulls the offered amount into the vault.
    ///         Floor-toward-the-protocol — keeps INV-01 exact across dust
    ///         repayments and is intentional, not a bug.
    function test_burnDebt_partial_belowOneShareRoundsToZero() public {
        vm.prank(alice);
        vault.deposit(500_000e18);

        vm.startPrank(bob);
        vault.depositCollateral(50e18);
        vault.borrow(40_000e18);
        vm.stopPrank();

        vm.warp(block.timestamp + 365 days);
        vault.accrue();
        assertGt(vault.borrowIndex(), 1e18, "borrowIndex must exceed WAD");

        uint256 sharesBefore = vault.userBorrowShares(bob);
        uint256 totalSharesBefore = vault.totalBorrowShares();
        uint256 debtBefore = vault.userDebt(bob);
        uint256 cashBefore = vault.cash();

        vm.prank(bob);
        vault.repay(1); // 1 wei — below one borrow share's worth

        assertEq(vault.userBorrowShares(bob), sharesBefore, "shares moved");
        assertEq(vault.totalBorrowShares(), totalSharesBefore, "total shares moved");
        assertEq(vault.userDebt(bob), debtBefore, "debt moved");

        assertEq(vault.cash() - cashBefore, 1, "cash did not grow by 1 wei");
    }

    /// @notice `repay(debt - 1)` proportionally burns shares and leaves a
    ///         small residual; a follow-up full close still works.
    function test_burnDebt_partial_justUnderFullCloseLeavesResidual() public {
        vm.prank(alice);
        vault.deposit(500_000e18);

        vm.startPrank(bob);
        vault.depositCollateral(50e18);
        vault.borrow(40_000e18);
        vm.stopPrank();

        vm.warp(block.timestamp + 30 days);
        vault.accrue();

        uint256 debtAmt = vault.userDebt(bob);
        uint256 sharesBefore = vault.userBorrowShares(bob);

        vm.prank(bob);
        vault.repay(debtAmt - 1);

        assertLt(vault.userBorrowShares(bob), sharesBefore, "no shares burned");
        assertGt(vault.userBorrowShares(bob), 0, "residual shares should remain");
        assertGt(vault.userDebt(bob), 0, "residual debt should remain");

        uint256 residual = vault.userDebt(bob);
        vm.prank(bob);
        vault.repay(residual + 1);
        assertEq(vault.userBorrowShares(bob), 0, "residual not cleared");
        assertEq(vault.userDebt(bob), 0, "residual debt not cleared");
    }

    // --------------------------------------------------------------------- //
    //                       Liquidation full-close path                     //
    // --------------------------------------------------------------------- //

    /// @notice Liquidating an under-water borrower with `amount >= debt`
    ///         zeroes their borrow shares.
    function test_burnDebt_liquidate_fullCloseZeroesShares() public {
        vm.prank(alice);
        vault.deposit(1_000_000e18);

        vm.startPrank(bob);
        vault.depositCollateral(10e18); // 20,000 value → 16,000 cap
        vault.borrow(16_000e18); // 80% cap
        vm.stopPrank();

        // Push bob under water via interest accrual.
        vm.warp(block.timestamp + 730 days);
        vault.accrue();

        uint256 debtAmt = vault.userDebt(bob);
        uint256 maxBorrow =
            (vault.collateralValue(bob) * vault.collateralRatio()) / vault.BPS();
        assertGt(debtAmt, maxBorrow, "preconditions: bob underwater");

        vm.prank(liquidator);
        vault.liquidate(bob, debtAmt + 50);

        assertEq(vault.userBorrowShares(bob), 0, "borrower shares not zeroed");
        assertEq(vault.userDebt(bob), 0, "borrower debt not zeroed");
        assertGe(vault.totalAssets(), vault.totalSupplyAssets(), "INV-01 violated");
    }

    /// @notice A partial-close liquidation that would consume all of the
    ///         borrower's collateral must revert with {MustClearDebt}.
    function test_burnDebt_liquidate_partialCloseRequiresFullDebtWhenCollateralExhausted() public {
        vm.prank(alice);
        vault.deposit(1_000_000e18);

        vm.startPrank(bob);
        vault.depositCollateral(10e18); // 20,000 value @ 2000 → 16,000 cap
        vault.borrow(16_000e18);
        vm.stopPrank();

        // Deep under-water — long warp so the requested partial close lands
        // in the seize-all-collateral branch.
        vm.warp(block.timestamp + 10_000 days);
        vault.accrue();

        uint256 debtAmt = vault.userDebt(bob);
        uint256 partialPay = debtAmt / 2; // half the debt

        vm.prank(liquidator);
        vm.expectRevert(Vault.MustClearDebt.selector);
        vault.liquidate(bob, partialPay);
    }
}
