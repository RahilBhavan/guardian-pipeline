// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../../src/Vault.sol";
import {AttackableVault} from "../../src/AttackableVault.sol";
import {MockERC20} from "../../src/MockERC20.sol";
import {MockOracle} from "../../src/MockOracle.sol";

/// @title VaultUnit — deterministic unit coverage for the Vault
/// @notice The invariant harness proves the six properties hold across random
///         sequences; this suite pins down every happy path, every revert
///         path, interest accrual, liquidation, oracle-driven
///         collateral pricing, and the demo-only AttackableVault, so
///         behaviour is fully specified and branch coverage is meaningful.
contract VaultUnit is Test {
    Vault internal vault;
    MockERC20 internal debt;
    MockERC20 internal collateral;
    MockOracle internal oracle;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal attacker = makeAddr("attacker");

    uint256 internal constant FUND = 1_000_000e18;
    uint256 internal constant APR_BPS = 10_00; // 10%
    uint256 internal constant LIQ_BONUS_BPS = 5_00; // 5%
    /// @dev 1 collateral unit == 2,000 debt-asset units, the demo seed price.
    uint256 internal constant INITIAL_PRICE = 2_000e18;

    event Deposited(address indexed user, uint256 amount, uint256 sharesMinted);
    event Withdrawn(address indexed user, uint256 shares, uint256 amountOut);
    event CollateralDeposited(address indexed user, uint256 amount);
    event CollateralWithdrawn(address indexed user, uint256 amount);
    event Borrowed(address indexed user, uint256 amount, uint256 borrowShares);
    event Repaid(address indexed user, uint256 amount, uint256 borrowSharesBurned);
    event Liquidated(
        address indexed liquidator, address indexed borrower, uint256 debtRepaid, uint256 collateralSeized
    );

    function setUp() public {
        debt = new MockERC20();
        collateral = new MockERC20();
        oracle = new MockOracle(INITIAL_PRICE);
        vault =
            new Vault(address(debt), address(collateral), address(oracle), APR_BPS, LIQ_BONUS_BPS);

        address[3] memory users = [alice, bob, carol];
        for (uint256 i = 0; i < users.length; i++) {
            debt.mint(users[i], FUND);
            collateral.mint(users[i], FUND);
            vm.startPrank(users[i]);
            debt.approve(address(vault), type(uint256).max);
            collateral.approve(address(vault), type(uint256).max);
            vm.stopPrank();
        }
    }

    /* ----------------------------- constructor ----------------------------- */

    function test_constructor_initialState() public view {
        assertEq(vault.sharePrice(), 1e18);
        assertEq(vault.borrowIndex(), 1e18);
        assertEq(vault.collateralRatio(), 80_00);
        assertEq(vault.liquidationBonus(), 5_00);
        assertEq(address(vault.debtAsset()), address(debt));
        assertEq(address(vault.collateralAsset()), address(collateral));
        assertEq(address(vault.oracle()), address(oracle));
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
        assertEq(debt.balanceOf(address(vault)), 1_000e18);
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

    function test_withdraw_insufficientLiquidityReverts() public {
        // alice lends; bob posts collateral and borrows enough that the idle
        // cash can no longer cover alice's full redemption.
        vm.prank(alice);
        vault.deposit(100_000e18);
        vm.startPrank(bob);
        vault.depositCollateral(100e18); // 100 * 2,000 = 200,000 value
        vault.borrow(80_000e18); // full 80% cap → cash = 20,000
        vm.stopPrank();

        uint256 aliceShares = vault.userSupplyShares(alice);
        vm.prank(alice);
        vm.expectRevert(Vault.InsufficientLiquidity.selector);
        vault.withdraw(aliceShares);
    }

    /* ------------------------- deposit/withdraw collateral ------------------ */

    function test_depositCollateral_movesTokensAndEmits() public {
        vm.expectEmit(true, false, false, true);
        emit CollateralDeposited(bob, 10e18);

        vm.prank(bob);
        vault.depositCollateral(10e18);

        assertEq(vault.userCollateral(bob), 10e18);
        assertEq(vault.totalCollateral(), 10e18);
        assertEq(collateral.balanceOf(address(vault)), 10e18);
    }

    function test_depositCollateral_zeroReverts() public {
        vm.prank(bob);
        vm.expectRevert(Vault.ZeroAmount.selector);
        vault.depositCollateral(0);
    }

    function test_withdrawCollateral_returnsTokensAndEmits() public {
        vm.startPrank(bob);
        vault.depositCollateral(10e18);

        vm.expectEmit(true, false, false, true);
        emit CollateralWithdrawn(bob, 4e18);
        vault.withdrawCollateral(4e18);
        vm.stopPrank();

        assertEq(vault.userCollateral(bob), 6e18);
        assertEq(vault.totalCollateral(), 6e18);
    }

    function test_withdrawCollateral_zeroReverts() public {
        vm.prank(bob);
        vm.expectRevert(Vault.ZeroAmount.selector);
        vault.withdrawCollateral(0);
    }

    function test_withdrawCollateral_insufficientReverts() public {
        vm.startPrank(bob);
        vault.depositCollateral(10e18);
        vm.expectRevert(Vault.InsufficientCollateral.selector);
        vault.withdrawCollateral(10e18 + 1);
        vm.stopPrank();
    }

    function test_withdrawCollateral_breakingCollateralCapReverts() public {
        vm.prank(alice);
        vault.deposit(1_000_000e18);

        vm.startPrank(bob);
        vault.depositCollateral(10e18); // 10 * 2,000 = 20,000 value
        vault.borrow(16_000e18); // 80% of 20,000 — the full cap
        // Pulling any collateral would leave bob over the cap.
        vm.expectRevert(Vault.CollateralCapExceeded.selector);
        vault.withdrawCollateral(1);
        vm.stopPrank();
    }

    /* -------------------------------- borrow -------------------------------- */

    function test_borrow_transfersAndEmits() public {
        vm.prank(alice);
        vault.deposit(1_000_000e18);

        vm.startPrank(bob);
        vault.depositCollateral(10e18); // 10 * 2,000 = 20,000 value

        uint256 balBefore = debt.balanceOf(bob);
        vm.expectEmit(true, false, false, true);
        emit Borrowed(bob, 5_000e18, 5_000e18);
        vault.borrow(5_000e18);
        vm.stopPrank();

        assertEq(vault.userDebt(bob), 5_000e18);
        assertEq(vault.totalBorrowed(), 5_000e18);
        assertEq(debt.balanceOf(bob), balBefore + 5_000e18);
    }

    function test_borrow_zeroReverts() public {
        vm.prank(bob);
        vm.expectRevert(Vault.ZeroAmount.selector);
        vault.borrow(0);
    }

    function test_borrow_overCollateralCapReverts() public {
        vm.prank(alice);
        vault.deposit(1_000_000e18);

        vm.startPrank(bob);
        vault.depositCollateral(10e18); // 20,000 value → 16,000 cap
        vm.expectRevert(Vault.CollateralCapExceeded.selector);
        vault.borrow(16_000e18 + 1);
        vm.stopPrank();
    }

    function test_borrow_priceDropMovesCap() public {
        vm.prank(alice);
        vault.deposit(1_000_000e18);

        vm.startPrank(bob);
        vault.depositCollateral(10e18); // 20,000 value @ 2,000 → 16,000 cap
        vault.borrow(10_000e18);
        vm.stopPrank();

        // Price halves — collateral now worth 10,000 → cap 8,000. Bob is over.
        oracle.setPrice(1_000e18);

        vm.prank(bob);
        vm.expectRevert(Vault.CollateralCapExceeded.selector);
        vault.borrow(1);
    }

    /* --------------------------------- repay -------------------------------- */

    function test_repay_reducesDebtAndEmits() public {
        vm.prank(alice);
        vault.deposit(1_000_000e18);

        vm.startPrank(bob);
        vault.depositCollateral(10e18);
        vault.borrow(5_000e18);

        vm.expectEmit(true, false, false, true);
        emit Repaid(bob, 3_000e18, 3_000e18);
        vault.repay(3_000e18);
        vm.stopPrank();

        assertEq(vault.userDebt(bob), 2_000e18);
        assertEq(vault.totalBorrowed(), 2_000e18);
    }

    function test_repay_zeroReverts() public {
        vm.prank(bob);
        vm.expectRevert(Vault.ZeroAmount.selector);
        vault.repay(0);
    }

    function test_repay_noDebtReverts() public {
        vm.startPrank(bob);
        vault.depositCollateral(1e18);
        vm.expectRevert(Vault.NoDebt.selector);
        vault.repay(100e18);
        vm.stopPrank();
    }

    function test_repay_overpaymentIsClampedToDebt() public {
        vm.prank(alice);
        vault.deposit(1_000_000e18);

        vm.startPrank(bob);
        vault.depositCollateral(10e18);
        vault.borrow(5_000e18);

        uint256 balBefore = debt.balanceOf(bob);
        vault.repay(5_000e18 + 100e18); // offers more than the debt
        vm.stopPrank();

        // Only the 5,000 debt is taken — the surplus is never transferred.
        assertEq(vault.userDebt(bob), 0);
        assertEq(debt.balanceOf(bob), balBefore - 5_000e18);
    }

    /* ------------------------------- accrue --------------------------------- */

    function test_accrue_growsDebtAndLenderClaims() public {
        vm.prank(alice);
        vault.deposit(100_000e18);

        vm.startPrank(bob);
        vault.depositCollateral(100e18); // 200,000 value → 160,000 cap
        vault.borrow(50_000e18);
        vm.stopPrank();

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

        vm.startPrank(bob);
        vault.depositCollateral(10e18); // 20,000 value → 16,000 cap
        vault.borrow(5_000e18); // well within the cap
        vm.stopPrank();

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

    function test_liquidate_clearsPriceDrivenUnderwaterPosition() public {
        vm.prank(alice);
        vault.deposit(1_000_000e18);

        vm.startPrank(bob);
        vault.depositCollateral(10e18); // 20,000 value @ 2,000 → 16,000 cap
        vault.borrow(15_000e18);
        vm.stopPrank();

        // Price drop pushes bob underwater (collateral worth 10,000 < 15,000 debt).
        oracle.setPrice(1_000e18);

        uint256 debtBefore = vault.userDebt(bob);
        uint256 carolCollateralBefore = collateral.balanceOf(carol);

        // carol clears the whole position and seizes collateral + the bonus.
        vm.prank(carol);
        vault.liquidate(bob, debtBefore);

        assertEq(vault.userDebt(bob), 0);
        assertGt(collateral.balanceOf(carol), carolCollateralBefore);
        // Solvency holds after the liquidation.
        assertGe(vault.totalAssets(), vault.totalSupplyAssets());
    }

    /* -------------------- AttackableVault (demo only) ----------------------- */

    function test_attackableVault_attackBreaksSolvency() public {
        AttackableVault av = new AttackableVault(
            address(debt), address(collateral), address(oracle), APR_BPS, LIQ_BONUS_BPS, attacker
        );
        debt.mint(alice, FUND);
        vm.prank(alice);
        debt.approve(address(av), type(uint256).max);
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
        AttackableVault av = new AttackableVault(
            address(debt), address(collateral), address(oracle), APR_BPS, LIQ_BONUS_BPS, attacker
        );
        vm.prank(alice);
        vm.expectRevert(AttackableVault.NotAttacker.selector);
        av.attack();
    }

    function test_attackableVault_disabledOnMainnet() public {
        AttackableVault av = new AttackableVault(
            address(debt), address(collateral), address(oracle), APR_BPS, LIQ_BONUS_BPS, attacker
        );
        vm.chainId(8453); // Base mainnet
        vm.prank(attacker);
        vm.expectRevert(AttackableVault.MainnetDisabled.selector);
        av.attack();
    }

    /* ----------------------------- MockOracle ------------------------------- */

    function test_oracle_zeroPriceReverts() public {
        vm.expectRevert(MockOracle.ZeroPrice.selector);
        new MockOracle(0);

        vm.expectRevert(MockOracle.ZeroPrice.selector);
        oracle.setPrice(0);
    }

    function test_oracle_setPriceUpdates() public {
        oracle.setPrice(3_000e18);
        assertEq(oracle.price(), 3_000e18);
    }
}
