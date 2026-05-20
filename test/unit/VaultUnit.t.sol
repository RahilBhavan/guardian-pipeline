// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../../src/Vault.sol";
import {MockERC20} from "../../src/MockERC20.sol";

/// @title VaultUnit — deterministic unit coverage for the Vault
/// @notice The invariant harness proves the eight properties hold across random
///         sequences; this suite pins down every happy path, every revert path,
///         and the demo-only {Vault.attack} function so behaviour is fully
///         specified and branch coverage is meaningful.
contract VaultUnit is Test {
    Vault internal vault;
    MockERC20 internal token;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal attacker = makeAddr("attacker");

    uint256 internal constant FUND = 1_000_000e18;

    event Deposited(address indexed user, uint256 amount, uint256 sharesMinted);
    event Withdrawn(address indexed user, uint256 shares, uint256 amountOut);
    event Borrowed(address indexed user, uint256 amount);
    event Repaid(address indexed user, uint256 amount);
    event InvariantViolated(string invariantName, uint256 actualValue, uint256 expectedBound);

    function setUp() public {
        token = new MockERC20();
        vault = new Vault(address(token), attacker);

        for (uint256 i = 0; i < 2; i++) {
            address user = i == 0 ? alice : bob;
            token.mint(user, FUND);
            vm.prank(user);
            token.approve(address(vault), type(uint256).max);
        }
    }

    /* ----------------------------- constructor ----------------------------- */

    function test_constructor_initialState() public view {
        assertEq(vault.sharePrice(), 1e18);
        assertEq(vault.collateralRatio(), 80_00);
        assertEq(address(vault.token()), address(token));
        assertEq(vault.attacker(), attacker);
    }

    /* ------------------------------- deposit -------------------------------- */

    function test_deposit_mintsSharesAndEmits() public {
        vm.expectEmit(true, false, false, true);
        emit Deposited(alice, 1_000e18, 1_000e18);

        vm.prank(alice);
        vault.deposit(1_000e18);

        assertEq(vault.totalDeposited(), 1_000e18);
        assertEq(vault.totalShares(), 1_000e18);
        assertEq(vault.userShares(alice), 1_000e18);
        assertEq(token.balanceOf(address(vault)), 1_000e18);
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

        assertEq(vault.userShares(alice), 600e18);
        assertEq(vault.totalShares(), 600e18);
        assertEq(vault.totalDeposited(), 600e18);
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

    // Note: the `InsufficientLiquidity` guards in withdraw() and borrow() are
    // provably unreachable given the 80% collateral cap — free liquidity always
    // stays >= any single user's withdrawable or borrowable amount. They are
    // retained as defence-in-depth (e.g. against a future collateralRatio change)
    // and so have no dedicated test.

    /* -------------------------------- borrow -------------------------------- */

    function test_borrow_transfersAndEmits() public {
        vm.startPrank(alice);
        vault.deposit(1_000e18);

        uint256 balBefore = token.balanceOf(alice);
        vm.expectEmit(true, false, false, true);
        emit Borrowed(alice, 500e18);
        vault.borrow(500e18);
        vm.stopPrank();

        assertEq(vault.userBorrowed(alice), 500e18);
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
        emit Repaid(alice, 300e18);
        vault.repay(300e18);
        vm.stopPrank();

        assertEq(vault.userBorrowed(alice), 200e18);
        assertEq(vault.totalBorrowed(), 200e18);
    }

    function test_repay_zeroReverts() public {
        vm.prank(alice);
        vm.expectRevert(Vault.ZeroAmount.selector);
        vault.repay(0);
    }

    function test_repay_exceedingDebtReverts() public {
        vm.startPrank(alice);
        vault.deposit(1_000e18);
        vault.borrow(500e18);
        vm.expectRevert(Vault.RepayExceedsDebt.selector);
        vault.repay(500e18 + 1);
        vm.stopPrank();
    }

    /* -------------------------- attack (demo only) -------------------------- */

    function test_attack_breaksSolvency() public {
        vm.prank(alice);
        vault.deposit(1_000e18);

        vm.expectEmit(false, false, false, true);
        emit InvariantViolated("INV-01: Solvency", 1_000e18 + 1, 1_000e18);

        vm.prank(attacker);
        vault.attack();

        assertGt(vault.totalBorrowed(), vault.totalDeposited());
    }

    function test_attack_onlyAttacker() public {
        vm.prank(alice);
        vm.expectRevert(Vault.NotAttacker.selector);
        vault.attack();
    }
}
