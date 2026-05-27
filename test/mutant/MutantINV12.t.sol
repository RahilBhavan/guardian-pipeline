// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../../src/Vault.sol";
import {MockERC20} from "../../src/MockERC20.sol";
import {MockOracle} from "../../src/MockOracle.sol";
import {VaultMutantINV12} from "./VaultMutantINV12.sol";

/// @title  MutantINV12 — proves INV-12 (accrue idempotence) is load-bearing
/// @notice Pairs the real {Vault} against {VaultMutantINV12} on identical
///         pre-states and asserts the INV-12 predicate (calling accrue()
///         twice in the same block changes no state) holds for the real
///         Vault and FAILS for the mutant. If both pass — or both fail — the
///         invariant is not tensioned by this property and the suite must be
///         fixed.
contract MutantINV12Test is Test {
    uint256 internal constant INITIAL_PRICE = 2_000e18;
    uint256 internal constant APR_BPS = 10_00;
    uint256 internal constant LIQ_BONUS_BPS = 5_00;

    /// @notice Real Vault: two consecutive accrue() calls in the same block
    ///         leave every accrue-mutable field byte-identical.
    function test_realVault_isIdempotent() public {
        (Vault v, MockERC20 d, MockERC20 c,) = _deploy(false);
        _seedDebt(v, d, c);

        v.accrue();

        uint256 idx = v.borrowIndex();
        uint256 supply = v.totalSupplyAssets();
        uint256 shares = v.totalBorrowShares();
        uint256 lat = v.lastAccrualTime();

        v.accrue();

        assertEq(v.borrowIndex(), idx, "real Vault: borrowIndex moved");
        assertEq(v.totalSupplyAssets(), supply, "real Vault: totalSupplyAssets moved");
        assertEq(v.totalBorrowShares(), shares, "real Vault: totalBorrowShares moved");
        assertEq(v.lastAccrualTime(), lat, "real Vault: lastAccrualTime moved");
    }

    /// @notice Mutant Vault: the same operation MUST change state. If this
    ///         test ever stops failing the invariant predicate, the predicate
    ///         no longer catches the `dt + 1` class of bug.
    function test_mutantVault_isNotIdempotent() public {
        (Vault v, MockERC20 d, MockERC20 c,) = _deploy(true);
        _seedDebt(v, d, c);

        v.accrue();
        uint256 idx = v.borrowIndex();

        v.accrue();

        assertGt(
            v.borrowIndex(),
            idx,
            "MUTANT: borrowIndex did not move on no-op accrue - INV-12 would not have caught this"
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
            v = Vault(address(new VaultMutantINV12(address(d), address(c), address(o), APR_BPS, LIQ_BONUS_BPS)));
        } else {
            v = new Vault(address(d), address(c), address(o), APR_BPS, LIQ_BONUS_BPS);
        }
    }

    function _seedDebt(Vault v, MockERC20 d, MockERC20 c) internal {
        address lp = vm.addr(uint256(keccak256("inv12.lp")));
        address borrower = vm.addr(uint256(keccak256("inv12.borrower")));

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
