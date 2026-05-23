// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../../src/Vault.sol";
import {MockERC20} from "../../src/MockERC20.sol";
import {MockOracle} from "../../src/MockOracle.sol";
import {VaultMutantINV09} from "./VaultMutantINV09.sol";

/// @title  MutantINV09 — proves INV-09 (debt monotonicity) is load-bearing
/// @notice Pairs the real {Vault} against {VaultMutantINV09} on identical
///         pre-states: a single borrower with stable `userBorrowShares` is
///         carried across a one-year warp + accrue. The real Vault must
///         grow `userDebt`; the mutant must shrink it. If either branch
///         flips, INV-09's predicate is no longer catching this index-sign
///         class of bug.
contract MutantINV09Test is Test {
    uint256 internal constant INITIAL_PRICE = 2_000e18;
    uint256 internal constant APR_BPS = 10_00;
    uint256 internal constant LIQ_BONUS_BPS = 5_00;

    /// @notice Real Vault: with shares fixed, userDebt strictly grows under
    ///         a year-long accrual at a positive rate.
    function test_realVault_debtGrowsUnderAccrual() public {
        (Vault v, MockERC20 d, MockERC20 c,) = _deploy(false);
        address borrower = _seedAndOpenDebt(v, d, c);

        uint256 sharesBefore = v.userBorrowShares(borrower);
        uint256 debtBefore = v.userDebt(borrower);

        vm.warp(block.timestamp + 365 days);
        v.accrue();

        assertEq(v.userBorrowShares(borrower), sharesBefore, "real Vault: shares moved unexpectedly");
        assertGt(
            v.userDebt(borrower),
            debtBefore,
            "real Vault: userDebt did not grow under a year-long accrual"
        );
    }

    /// @notice Mutant Vault: the same accrual MUST shrink userDebt while
    ///         shares are flat — exactly the precondition INV-09's
    ///         predicate catches.
    function test_mutantVault_debtShrinksUnderAccrual() public {
        (Vault v, MockERC20 d, MockERC20 c,) = _deploy(true);
        address borrower = _seedAndOpenDebt(v, d, c);

        uint256 sharesBefore = v.userBorrowShares(borrower);
        uint256 debtBefore = v.userDebt(borrower);

        vm.warp(block.timestamp + 365 days);
        v.accrue();

        assertEq(v.userBorrowShares(borrower), sharesBefore, "MUTANT: shares moved unexpectedly");
        assertLt(
            v.userDebt(borrower),
            debtBefore,
            "MUTANT: userDebt did not shrink under negative-rate accrual - INV-09 would not have caught this"
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
            v = Vault(address(new VaultMutantINV09(address(d), address(c), address(o), APR_BPS, LIQ_BONUS_BPS)));
        } else {
            v = new Vault(address(d), address(c), address(o), APR_BPS, LIQ_BONUS_BPS);
        }
    }

    function _seedAndOpenDebt(Vault v, MockERC20 d, MockERC20 c) internal returns (address borrower) {
        address lp = address(uint160(uint256(keccak256("inv09.lp"))));
        borrower = address(uint160(uint256(keccak256("inv09.borrower"))));

        d.mint(lp, 100_000e18);
        c.mint(borrower, 100e18);

        vm.startPrank(lp);
        d.approve(address(v), type(uint256).max);
        v.deposit(100_000e18);
        vm.stopPrank();

        vm.startPrank(borrower);
        c.approve(address(v), type(uint256).max);
        v.depositCollateral(50e18);
        v.borrow(50_000e18);
        vm.stopPrank();
    }
}
