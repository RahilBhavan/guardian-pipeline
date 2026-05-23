// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../../src/Vault.sol";
import {MockERC20} from "../../src/MockERC20.sol";

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
///           This is what keeps the protocol solvent across dust repayments;
///           it is a feature, not a bug, and the test pins it explicitly.
///         - A *full close on a single-borrower vault* zeroes
///           `totalBorrowShares` and `totalBorrowed` exactly.
///         - A *full close on a multi-borrower vault* leaves every other
///           borrower's debt unchanged within one wei of index rounding.
///         - A *liquidation full close* zeroes the seized borrower's debt
///           and respects {MustClearDebt} when the bonus would otherwise
///           consume all collateral on a partial close.
///
///         `_burnDebt` itself is `private`, so every assertion goes through
///         the public `repay` / `liquidate` entrypoints — the way callers
///         actually exercise it.
contract VaultBurnDebt is Test {
    Vault internal vault;
    MockERC20 internal token;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");
    address internal liquidator = makeAddr("liquidator");

    uint256 internal constant FUND = 10_000_000e18;
    uint256 internal constant APR_BPS = 10_00; // 10% APR
    uint256 internal constant LIQ_BONUS_BPS = 5_00; // 5% bonus

    function setUp() public {
        token = new MockERC20();
        vault = new Vault(address(token), APR_BPS, LIQ_BONUS_BPS);

        address[5] memory actors = [alice, bob, carol, dave, liquidator];
        for (uint256 i = 0; i < actors.length; i++) {
            token.mint(actors[i], FUND);
            vm.prank(actors[i]);
            token.approve(address(vault), type(uint256).max);
        }
    }

    // --------------------------------------------------------------------- //
    //                          Full-close repay path                        //
    // --------------------------------------------------------------------- //

    /// @notice After a long warp, a repay with `offered >= debt` charges the
    ///         exact realised drop in `totalBorrowed`, burns every borrow
    ///         share the caller held, and leaves `userDebt == 0`. The
    ///         solvency margin must not shrink.
    function test_burnDebt_fullClose_chargesExactRealisedDelta() public {
        // Two lenders so there is room for the borrow.
        vm.prank(alice);
        vault.deposit(1_000_000e18);
        vm.prank(bob);
        vault.deposit(100_000e18);

        vm.prank(bob);
        vault.borrow(50_000e18);

        // Long warp so `borrowIndex` divides imprecisely.
        vm.warp(block.timestamp + 4_000 days);
        vault.accrue();

        uint256 debt = vault.userDebt(bob);
        uint256 borrowedBefore = vault.totalBorrowed();
        uint256 solvencyBefore = vault.totalAssets() - vault.totalSupplyAssets();
        uint256 cashBefore = vault.cash();

        vm.prank(bob);
        vault.repay(debt + 123); // generous slop

        // Bob's shares are fully burned and the index can no longer value
        // a non-zero debt against him.
        assertEq(vault.userBorrowShares(bob), 0, "bob shares not zeroed");
        assertEq(vault.userDebt(bob), 0, "bob debt not zeroed");

        // The cash delta equals the realised drop in totalBorrowed — by at
        // most one wei of index rounding, the floor-divided debt or one more.
        uint256 cashDelta = vault.cash() - cashBefore;
        uint256 realisedDrop = borrowedBefore - vault.totalBorrowed();
        assertEq(cashDelta, realisedDrop, "cash delta != realised drop");
        assertApproxEqAbs(cashDelta, debt, 1, "charge differs from debt by > 1 wei");

        // Solvency margin can only grow.
        uint256 solvencyAfter = vault.totalAssets() - vault.totalSupplyAssets();
        assertGe(solvencyAfter, solvencyBefore, "solvency margin shrank");
    }

    /// @notice On a single-borrower vault, a full close zeroes both
    ///         `totalBorrowShares` and `totalBorrowed` exactly — there are no
    ///         other shares to leave behind.
    function test_burnDebt_fullClose_singleBorrowerZeroesAggregates() public {
        vm.prank(alice);
        vault.deposit(500_000e18);
        vm.prank(bob);
        vault.deposit(50_000e18);

        vm.prank(bob);
        vault.borrow(40_000e18);

        // A modest warp so `borrowIndex > 1e18` but the maths is easy to read.
        vm.warp(block.timestamp + 90 days);
        vault.accrue();

        assertGt(vault.totalBorrowShares(), 0, "preconditions: bob has shares");

        uint256 debt = vault.userDebt(bob);
        vm.prank(bob);
        vault.repay(debt + 1);

        assertEq(vault.totalBorrowShares(), 0, "totalBorrowShares not zero");
        assertEq(vault.totalBorrowed(), 0, "totalBorrowed not zero");
        assertEq(vault.userBorrowShares(bob), 0, "bob's shares not zero");
    }

    /// @notice On a multi-borrower vault, a full close leaves every other
    ///         borrower's debt and shares untouched; the sum of the remaining
    ///         per-user debts equals the new `totalBorrowed` within one wei of
    ///         index rounding.
    function test_burnDebt_fullClose_multiBorrowerLeavesOthersUntouched() public {
        // alice supplies; bob, carol, dave all borrow.
        vm.prank(alice);
        vault.deposit(1_000_000e18);
        vm.prank(bob);
        vault.deposit(50_000e18);
        vm.prank(carol);
        vault.deposit(50_000e18);
        vm.prank(dave);
        vault.deposit(50_000e18);

        vm.prank(bob);
        vault.borrow(20_000e18);
        vm.prank(carol);
        vault.borrow(30_000e18);
        vm.prank(dave);
        vault.borrow(40_000e18);

        vm.warp(block.timestamp + 365 days);
        vault.accrue();

        uint256 carolSharesBefore = vault.userBorrowShares(carol);
        uint256 daveSharesBefore = vault.userBorrowShares(dave);
        uint256 carolDebtBefore = vault.userDebt(carol);
        uint256 daveDebtBefore = vault.userDebt(dave);

        // Bob fully closes.
        uint256 bobDebt = vault.userDebt(bob);
        vm.prank(bob);
        vault.repay(bobDebt + 100);

        // The other borrowers' shares are unchanged...
        assertEq(vault.userBorrowShares(carol), carolSharesBefore, "carol shares moved");
        assertEq(vault.userBorrowShares(dave), daveSharesBefore, "dave shares moved");

        // ...and so are their debt valuations (borrowIndex hasn't changed
        // because `accrue()` was a no-op inside the same block).
        assertEq(vault.userDebt(carol), carolDebtBefore, "carol debt moved");
        assertEq(vault.userDebt(dave), daveDebtBefore, "dave debt moved");

        // The sum of the remaining per-user debts equals the new totalBorrowed
        // within one wei of `(totalBorrowShares * borrowIndex) / WAD` rounding.
        uint256 perUserSum = vault.userDebt(carol) + vault.userDebt(dave);
        assertApproxEqAbs(perUserSum, vault.totalBorrowed(), 1, "per-user sum differs > 1 wei");
    }

    // --------------------------------------------------------------------- //
    //                       Partial repay rounding path                     //
    // --------------------------------------------------------------------- //

    /// @notice A partial repay where `offered * WAD < borrowIndex` burns zero
    ///         shares but still pulls the offered amount into the vault. This
    ///         is the floor-toward-the-protocol behaviour that keeps INV-01
    ///         exact across dust repayments — the vault gains cash and the
    ///         debt accounting is undisturbed.
    /// @dev    Pinned here on purpose. A reviewer might mistake this for a
    ///         bug; in fact it is the rounding choice that makes the partial
    ///         path strictly solvency-improving rather than solvency-neutral.
    function test_burnDebt_partial_belowOneShareRoundsToZero() public {
        vm.prank(alice);
        vault.deposit(500_000e18);
        vm.prank(bob);
        vault.deposit(50_000e18);

        vm.prank(bob);
        vault.borrow(40_000e18);

        // Push the borrow index high so a 1-wei repay floors to zero shares:
        // burned = (1 * 1e18) / borrowIndex == 0 when borrowIndex > 1e18.
        vm.warp(block.timestamp + 365 days);
        vault.accrue();
        assertGt(vault.borrowIndex(), 1e18, "borrowIndex must exceed WAD");

        uint256 sharesBefore = vault.userBorrowShares(bob);
        uint256 totalSharesBefore = vault.totalBorrowShares();
        uint256 debtBefore = vault.userDebt(bob);
        uint256 cashBefore = vault.cash();

        vm.prank(bob);
        vault.repay(1); // 1 wei — below one borrow share's worth

        // Shares and debt unchanged...
        assertEq(vault.userBorrowShares(bob), sharesBefore, "shares moved");
        assertEq(vault.totalBorrowShares(), totalSharesBefore, "total shares moved");
        assertEq(vault.userDebt(bob), debtBefore, "debt moved");

        // ...but cash grew by exactly the 1 wei the caller offered. The vault
        // strictly benefits — the offered amount is collected, no debt is
        // burned, so INV-01's margin can only grow.
        assertEq(vault.cash() - cashBefore, 1, "cash did not grow by 1 wei");
    }

    /// @notice `repay(debt - 1)` proportionally burns shares and leaves a
    ///         small residual; a follow-up full close still works.
    function test_burnDebt_partial_justUnderFullCloseLeavesResidual() public {
        vm.prank(alice);
        vault.deposit(500_000e18);
        vm.prank(bob);
        vault.deposit(50_000e18);

        vm.prank(bob);
        vault.borrow(40_000e18);

        vm.warp(block.timestamp + 30 days);
        vault.accrue();

        uint256 debt = vault.userDebt(bob);
        uint256 sharesBefore = vault.userBorrowShares(bob);

        vm.prank(bob);
        vault.repay(debt - 1);

        // Shares fell by almost all of them, but the residual remains.
        assertLt(vault.userBorrowShares(bob), sharesBefore, "no shares burned");
        assertGt(vault.userBorrowShares(bob), 0, "residual shares should remain");
        assertGt(vault.userDebt(bob), 0, "residual debt should remain");

        // A subsequent full close in the same block clears the rest.
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
    ///         zeroes their borrow shares. The {MustClearDebt} rule still
    ///         guards the partial-close path when the bonus would consume
    ///         all collateral.
    function test_burnDebt_liquidate_fullCloseZeroesShares() public {
        vm.prank(alice);
        vault.deposit(1_000_000e18);
        vm.prank(bob);
        vault.deposit(10_000e18);
        vm.prank(bob);
        vault.borrow(8_000e18); // 80% cap

        // Push bob under water.
        vm.warp(block.timestamp + 730 days);
        vault.accrue();

        uint256 debt = vault.userDebt(bob);
        uint256 maxBorrow = (vault.collateralValue(bob) * vault.collateralRatio()) / vault.BPS();
        assertGt(debt, maxBorrow, "preconditions: bob underwater");

        vm.prank(liquidator);
        vault.liquidate(bob, debt + 50);

        assertEq(vault.userBorrowShares(bob), 0, "borrower shares not zeroed");
        assertEq(vault.userDebt(bob), 0, "borrower debt not zeroed");
        // Solvency holds throughout.
        assertGe(vault.totalAssets(), vault.totalSupplyAssets(), "INV-01 violated");
    }

    /// @notice A partial-close liquidation that would consume all of the
    ///         borrower's collateral must revert with {MustClearDebt} — that
    ///         is the rule keeping INV-06 (no uncollateralised debt) true.
    function test_burnDebt_liquidate_partialCloseRequiresFullDebtWhenCollateralExhausted() public {
        vm.prank(alice);
        vault.deposit(1_000_000e18);
        vm.prank(bob);
        vault.deposit(10_000e18);
        vm.prank(bob);
        vault.borrow(8_000e18);

        // Deep under-water — long warp so the requested partial close lands
        // in the seize-all-collateral branch.
        vm.warp(block.timestamp + 10_000 days);
        vault.accrue();

        uint256 debt = vault.userDebt(bob);
        // Offer roughly half the debt — enough that the scaled seizure
        // exceeds the borrower's remaining collateral shares.
        uint256 partialPay = debt / 2;

        vm.prank(liquidator);
        vm.expectRevert(Vault.MustClearDebt.selector);
        vault.liquidate(bob, partialPay);
    }
}
