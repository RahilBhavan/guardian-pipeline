// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../../src/Vault.sol";
import {MockERC20} from "../../src/MockERC20.sol";
import {MockOracle} from "../../src/MockOracle.sol";
import {VaultMutantINV10} from "./VaultMutantINV10.sol";

/// @title  MutantINV10 — proves INV-10 (debt rounding) is load-bearing
/// @notice Pairs the real {Vault} against {VaultMutantINV10} on identical
///         pre-states. Three borrowers each take an "awkward" amount —
///         non-clean against the post-warp borrowIndex — so the per-user
///         ceil/floor decision moves at least one wei per actor. The real
///         Vault's `sum(userDebt) <= totalBorrowed`; the mutant's
///         `sum(userDebt) > totalBorrowed`. If either flips, INV-10 is no
///         longer catching the rounding-direction class.
contract MutantINV10Test is Test {
    uint256 internal constant INITIAL_PRICE = 2_000e18;
    uint256 internal constant APR_BPS = 10_00;
    uint256 internal constant LIQ_BONUS_BPS = 5_00;

    address[] internal borrowers;

    function test_realVault_debtRoundingFavoursProtocol() public {
        (Vault v, MockERC20 d, MockERC20 c,) = _deploy(false);
        _seedMany(v, d, c);

        uint256 sumDebt;
        for (uint256 i = 0; i < borrowers.length; i++) {
            sumDebt += v.userDebt(borrowers[i]);
        }
        assertLe(
            sumDebt,
            v.totalBorrowed(),
            "real Vault: sum(userDebt) exceeded totalBorrowed - INV-10 itself is broken"
        );
    }

    function test_mutantVault_debtRoundingHurtsProtocol() public {
        (Vault v, MockERC20 d, MockERC20 c,) = _deploy(true);
        _seedMany(v, d, c);

        uint256 sumDebt;
        for (uint256 i = 0; i < borrowers.length; i++) {
            sumDebt += v.userDebt(borrowers[i]);
        }
        assertGt(
            sumDebt,
            v.totalBorrowed(),
            "MUTANT: sum(userDebt) did not exceed totalBorrowed - INV-10 would not have caught this"
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
            v = Vault(address(new VaultMutantINV10(address(d), address(c), address(o), APR_BPS, LIQ_BONUS_BPS)));
        } else {
            v = new Vault(address(d), address(c), address(o), APR_BPS, LIQ_BONUS_BPS);
        }
    }

    /// @dev Three borrowers each take a non-WAD-aligned amount. After a
    ///      one-year accrual the borrowIndex is non-unit, so each
    ///      per-borrower `shares * index / WAD` division has a non-zero
    ///      remainder. Across three borrowers, the ceil-vs-floor difference
    ///      sums to at least one wei in the mutant — enough to trip INV-10.
    function _seedMany(Vault v, MockERC20 d, MockERC20 c) internal {
        address lp = address(uint160(uint256(keccak256("inv10.lp"))));
        d.mint(lp, 1_000_000e18);

        vm.startPrank(lp);
        d.approve(address(v), type(uint256).max);
        v.deposit(1_000_000e18);
        vm.stopPrank();

        // Awkward, non-aligned amounts.
        uint256[3] memory amounts = [uint256(7_777e18 + 13), 12_345e18 + 7, 33_333e18 + 1];
        for (uint256 i = 0; i < 3; i++) {
            address b = address(uint160(uint256(keccak256(abi.encodePacked("inv10.borrower", i)))));
            borrowers.push(b);
            c.mint(b, 100e18);

            vm.startPrank(b);
            c.approve(address(v), type(uint256).max);
            v.depositCollateral(50e18);
            v.borrow(amounts[i]);
            vm.stopPrank();
        }

        vm.warp(block.timestamp + 365 days);
        v.accrue();
    }
}
