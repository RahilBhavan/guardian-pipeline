// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../../src/Vault.sol";
import {AttackableVault} from "../../src/AttackableVault.sol";
import {MockERC20} from "../../src/MockERC20.sol";

/// @title VaultUnit — deterministic unit coverage for the Vault
/// @notice The invariant harness proves the six properties hold across random
///         sequences; this suite pins down every happy path, every revert path,
///         interest accrual, liquidation, and the demo-only AttackableVault, so
///         behaviour is fully specified and branch coverage is meaningful.
contract VaultUnit is Test {
    Vault internal vault;
    MockERC20 internal token;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal attacker = makeAddr("attacker");

    uint256 internal constant FUND = 1_000_000e18;
    uint256 internal constant APR_BPS = 10_00; // 10%

    event Deposited(address indexed user, uint256 amount, uint256 sharesMinted);
    event Withdrawn(address indexed user, uint256 shares, uint256 amountOut);
    event Borrowed(address indexed user, uint256 amount, uint256 borrowShares);
    event Repaid(address indexed user, uint256 amount, uint256 borrowSharesBurned);
    event Liquidated(
        address indexed liquidator, address indexed borrower, uint256 debtRepaid, uint256 collateralSeized
    );

    function setUp() public {
        token = new MockERC20();
        vault = new Vault(address(token), APR_BPS);

        address[3] memory users = [alice, bob, carol];
        for (uint256 i = 0; i < users.length; i++) {
            token.mint(users[i], FUND);
            vm.prank(users[i]);
            token.approve(address(vault), type(uint256).max);
        }
    }

    /* ----------------------------- constructor ----------------------------- */

    function test_constructor_initialState() public view {
        assertEq(vault.sharePrice(), 1e18);
        assertEq(vault.borrowIndex(), 1e18);
        assertEq(vault.collateralRatio(), 80_00);
        assertEq(vault.liquidationBonus(), 5_00);
        assertEq(address(vault.token()), address(token));
        // 10% APR == 0.10e18 spread across a 365-day year.
        assertEq(vault.borrowRatePerSecond(), (APR_BPS * 1e18) / 100_00 / 365 days);
    }

    /* ------------------------------- deposit -------------------------------- */

    function test_deposit_mintsSharesAndEmits() public {
        vm.expectEmit(true, false, false, true);
        emit Deposited(alice, 1_000e18, 1_000e18);

        vm.prank(alice);
        vault.deposit(1_000e18);

        assertEq(vault.totalSupplyAssets(), 1_000e18);
        assertEq(vault.totalSupplyShares(), 1_000e18);
        assertEq(vault.userSupplyShares(alice), 1_000e18);
        assertEq(token.balanceOf(address(vault)), 1_000e18);
    }

    function test_deposit_secondDepositorPricedAtParity() public {
        vm.prank(alice);
        vault.deposit(1_000e18);
        vm.prank(bob);
        vault.deposit(500e18);

        // No interest has accrued, so the second depositor mints 1:1.
        assertEq(vault.userSupplyShares(bob), 500e18);
        assertEq(vault.totalSupplyShares(), 1_500e18);
    }

    function test_deposit_zeroReverts() public {
        vm.prank(alice);
        vm.expectRevert(Vault.ZeroAmount.selector);
        vault.deposit(0);
    }

    /* ------------------------------- withdraw ------------------------------- */

    function test_withdraw_returnsTokensAndEmits() public {
        vm.startPrank(alice);
        vault.deposit(1_000e18);

        vm.expectEmit(true, false, false, true);
        emit Withdrawn(alice, 400e18, 400e18);
        vault.withdraw(400e18);
        vm.stopPrank();

        assertEq(vault.userSupplyShares(alice), 600e18);
        assertEq(vault.totalSupplyShares(), 600e18);
        assertEq(vault.totalSupplyAssets(), 600e18);
    }

    function test_withdraw_zeroReverts() public {
        vm.prank(alice);
        vm.expectRevert(Vault.ZeroAmount.selector);
        vault.withdraw(0);
    }

    function test_withdraw_insufficientSharesReverts() public {
        vm.startPrank(alice);
        vault.deposit(100e18);
        vm.expectRevert(Vault.InsufficientShares.selector);
        vault.withdraw(101e18);
        vm.stopPrank();
    }

    function test_withdraw_breakingCollateralCapReverts() public {
        vm.startPrank(alice);
        vault.deposit(1_000e18);
        vault.borrow(800e18); // exactly at the 80% cap
        // Withdrawing any shares would push the cap below the outstanding debt.
        vm.expectRevert(Vault.CollateralCapExceeded.selector);
        vault.withdraw(1e18);
        vm.stopPrank();
    }

    function test_withdraw_insufficientLiquidityReverts() public {
        // alice lends, bob borrows the cap; interest then lifts alice's claim
        // above the idle cash so a full redemption cannot be honoured.
        vm.prank(alice);
        vault.deposit(100_000e18);
        vm.prank(bob);
        vault.deposit(100_000e18);
        vm.prank(bob);
        vault.borrow(80_000e18);

        vm.warp(block.timestamp + 4_000 days);
        vault.accrue();

        uint256 aliceShares = vault.userSupplyShares(alice);
        vm.prank(alice);
        vm.expectRevert(Vault.InsufficientLiquidity.selector);
        vault.withdraw(aliceShares);
    }

    /* -------------------------------- borrow -------------------------------- */

    function test_borrow_transfersAndEmits() public {
        vm.startPrank(alice);
        vault.deposit(1_000e18);

        uint256 balBefore = token.balanceOf(alice);
        vm.expectEmit(true, false, false, true);
        emit Borrowed(alice, 500e18, 500e18);
        vault.borrow(500e18);
        vm.stopPrank();

        assertEq(vault.userDebt(alice), 500e18);
        assertEq(vault.totalBorrowed(), 500e18);
        assertEq(token.balanceOf(alice), balBefore + 500e18);
    }

    function test_borrow_zeroReverts() public {
        vm.prank(alice);
        vm.expectRevert(Vault.ZeroAmount.selector);
        vault.borrow(0);
    }

    function test_borrow_overCollateralCapReverts() public {
        vm.startPrank(alice);
        vault.deposit(1_000e18);
        vm.expectRevert(Vault.CollateralCapExceeded.selector);
        vault.borrow(800e18 + 1); // one wei above the 80% cap
        vm.stopPrank();
    }

    /* --------------------------------- repay -------------------------------- */

    function test_repay_reducesDebtAndEmits() public {
        vm.startPrank(alice);
        vault.deposit(1_000e18);
        vault.borrow(500e18);

        vm.expectEmit(true, false, false, true);
        emit Repaid(alice, 300e18, 300e18);
        vault.repay(300e18);
        vm.stopPrank();

        assertEq(vault.userDebt(alice), 200e18);
        assertEq(vault.totalBorrowed(), 200e18);
    }

    function test_repay_zeroReverts() public {
        vm.prank(alice);
        vm.expectRevert(Vault.ZeroAmount.selector);
        vault.repay(0);
    }

    function test_repay_noDebtReverts() public {
        vm.startPrank(alice);
        vault.deposit(1_000e18);
        vm.expectRevert(Vault.NoDebt.selector);
        vault.repay(100e18);
        vm.stopPrank();
    }

    function test_repay_overpaymentIsClampedToDebt() public {
        vm.startPrank(alice);
        vault.deposit(1_000e18);
        vault.borrow(500e18);

        uint256 balBefore = token.balanceOf(alice);
        vault.repay(500e18 + 100e18); // offers more than the debt
        vm.stopPrank();

        // Only the 500e18 debt is taken — the surplus is never transferred.
        assertEq(vault.userDebt(alice), 0);
        assertEq(token.balanceOf(alice), balBefore - 500e18);
    }

    /* ------------------------------- accrue --------------------------------- */

    function test_accrue_growsDebtAndLenderClaims() public {
        vm.prank(alice);
        vault.deposit(100_000e18);
        vm.prank(bob);
        vault.deposit(100_000e18);
        vm.prank(bob);
        vault.borrow(50_000e18);

        uint256 borrowedBefore = vault.totalBorrowed();
        uint256 supplyBefore = vault.totalSupplyAssets();

        vm.warp(block.timestamp + 365 days);
        vault.accrue();

        // ~10% of the 50,000 debt accrues as interest...
        assertApproxEqRel(vault.totalBorrowed(), borrowedBefore + 5_000e18, 0.01e18);
        // ...and the realised interest is credited to lenders, raising the price.
        assertEq(vault.totalSupplyAssets() - supplyBefore, vault.totalBorrowed() - borrowedBefore);
        assertGt(vault.sharePrice(), 1e18);
        assertGt(vault.borrowIndex(), 1e18);
    }

    function test_accrue_noDebtIsNoOp() public {
        vm.prank(alice);
        vault.deposit(100_000e18);

        vm.warp(block.timestamp + 365 days);
        vault.accrue();

        assertEq(vault.borrowIndex(), 1e18);
        assertEq(vault.totalSupplyAssets(), 100_000e18);
    }

    /* ------------------------------ liquidate ------------------------------- */

    function test_liquidate_healthyPositionReverts() public {
        vm.prank(alice);
        vault.deposit(100_000e18);
        vm.prank(bob);
        vault.deposit(10_000e18);
        vm.prank(bob);
        vault.borrow(5_000e18); // well within the cap

        vm.prank(carol);
        vm.expectRevert(Vault.PositionHealthy.selector);
        vault.liquidate(bob, 1e18);
    }

    function test_liquidate_noDebtReverts() public {
        vm.prank(alice);
        vault.deposit(100_000e18);

        vm.prank(carol);
        vm.expectRevert(Vault.NoDebt.selector);
        vault.liquidate(alice, 1e18);
    }

    function test_liquidate_clearsUnderwaterPosition() public {
        vm.prank(alice);
        vault.deposit(100_000e18);
        vm.prank(bob);
        vault.deposit(10_000e18);
        vm.prank(bob);
        vault.borrow(8_000e18); // the full 80% cap

        // Interest pushes bob past his collateral cap.
        vm.warp(block.timestamp + 730 days);
        vault.accrue();

        uint256 debt = vault.userDebt(bob);
        assertGt(debt, (vault.collateralValue(bob) * 80_00) / 100_00);

        // carol clears the whole position and seizes collateral + the bonus.
        vm.prank(carol);
        vault.liquidate(bob, debt);

        assertEq(vault.userDebt(bob), 0);
        assertGt(vault.userSupplyShares(carol), 0);
        // Solvency holds after the liquidation.
        assertGe(vault.totalAssets(), vault.totalSupplyAssets());
    }

    /* -------------------- AttackableVault (demo only) ----------------------- */

    function test_attackableVault_attackBreaksSolvency() public {
        AttackableVault av = new AttackableVault(address(token), APR_BPS, attacker);
        token.mint(alice, FUND);
        vm.prank(alice);
        token.approve(address(av), type(uint256).max);
        vm.prank(alice);
        av.deposit(1_000e18);

        // Solvency holds before the attack...
        assertGe(av.totalAssets(), av.totalSupplyAssets());

        vm.prank(attacker);
        av.attack();

        // ...and the inflated lender claim now exceeds the assets behind it.
        assertLt(av.totalAssets(), av.totalSupplyAssets());
    }

    function test_attackableVault_onlyAttacker() public {
        AttackableVault av = new AttackableVault(address(token), APR_BPS, attacker);
        vm.prank(alice);
        vm.expectRevert(AttackableVault.NotAttacker.selector);
        av.attack();
    }

    function test_attackableVault_disabledOnMainnet() public {
        AttackableVault av = new AttackableVault(address(token), APR_BPS, attacker);
        vm.chainId(8453); // Base mainnet
        vm.prank(attacker);
        vm.expectRevert(AttackableVault.MainnetDisabled.selector);
        av.attack();
    }
}
