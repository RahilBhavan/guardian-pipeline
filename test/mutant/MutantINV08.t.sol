// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../../src/Vault.sol";
import {MockERC20} from "../../src/MockERC20.sol";
import {MockOracle} from "../../src/MockOracle.sol";
import {VaultMutantINV08} from "./VaultMutantINV08.sol";

/// @title  MutantINV08 — proves INV-08 (no free lunch) is load-bearing
/// @notice Pairs the real {Vault} against {VaultMutantINV08} on identical
///         pre-states. After the oracle drop, a liquidator clears a slice
///         of the borrower's debt. The per-tx bound
///         `seized * price * BPS <= paid * (BPS + bonus) * WAD`
///         must hold on the real Vault and FAIL on the mutant. If either
///         branch flips, INV-08's predicate is no longer catching the
///         seize-overpayment class of bug.
contract MutantINV08Test is Test {
    uint256 internal constant INITIAL_PRICE = 2_000e18;
    uint256 internal constant APR_BPS = 10_00;
    uint256 internal constant LIQ_BONUS_BPS = 5_00;

    function test_realVault_seizeHonoursBonusBound() public {
        (Vault v, MockERC20 d, MockERC20 c, MockOracle o) = _deploy(false);
        (address liquidator, address borrower) = _openUnderwaterPosition(v, d, c, o);

        (uint256 paid, uint256 seized, uint256 price) = _liquidate(v, d, c, liquidator, borrower);

        assertLe(
            seized * price * v.BPS(),
            paid * (v.BPS() + v.liquidationBonus()) * v.WAD(),
            "real Vault: liquidation violated the bonus bound - INV-08 itself is broken"
        );
    }

    function test_mutantVault_seizeBreaksBonusBound() public {
        (Vault v, MockERC20 d, MockERC20 c, MockOracle o) = _deploy(true);
        (address liquidator, address borrower) = _openUnderwaterPosition(v, d, c, o);

        (uint256 paid, uint256 seized, uint256 price) = _liquidate(v, d, c, liquidator, borrower);

        assertGt(
            seized * price * v.BPS(),
            paid * (v.BPS() + v.liquidationBonus()) * v.WAD(),
            "MUTANT: liquidation stayed inside the bonus bound - INV-08 would not have caught this"
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
            v = Vault(address(new VaultMutantINV08(address(d), address(c), address(o), APR_BPS, LIQ_BONUS_BPS)));
        } else {
            v = new Vault(address(d), address(c), address(o), APR_BPS, LIQ_BONUS_BPS);
        }
    }

    /// @dev Seed an LP and a borrower, open a borrow at the seed price, then
    ///      halve the oracle price so the position is under water - the
    ///      precondition for {Vault.liquidate}.
    function _openUnderwaterPosition(Vault v, MockERC20 d, MockERC20 c, MockOracle o)
        internal
        returns (address liquidator, address borrower)
    {
        address lp = address(uint160(uint256(keccak256("inv08.lp"))));
        borrower = address(uint160(uint256(keccak256("inv08.borrower"))));
        liquidator = address(uint160(uint256(keccak256("inv08.liquidator"))));

        d.mint(lp, 200_000e18);
        c.mint(borrower, 100e18);
        d.mint(liquidator, 200_000e18);

        vm.startPrank(lp);
        d.approve(address(v), type(uint256).max);
        v.deposit(200_000e18);
        vm.stopPrank();

        vm.startPrank(borrower);
        c.approve(address(v), type(uint256).max);
        v.depositCollateral(50e18); // 50 * 2,000 = 100,000 -> 80,000 cap
        v.borrow(60_000e18); // healthy at the seed price
        vm.stopPrank();

        // Halve the price -> 50 * 1,000 = 50,000 value -> 40,000 cap < 60,000 debt.
        o.setPrice(INITIAL_PRICE / 2);

        vm.startPrank(liquidator);
        d.approve(address(v), type(uint256).max);
        vm.stopPrank();
    }

    function _liquidate(Vault v, MockERC20 d, MockERC20 c, address liquidator, address borrower)
        internal
        returns (uint256 paid, uint256 seized, uint256 price)
    {
        uint256 debtBefore = d.balanceOf(liquidator);
        uint256 colBefore = c.balanceOf(liquidator);
        price = v.oracle().price();

        // Partial close, well below full debt so the path doesn't clamp.
        uint256 partialAmount = v.userDebt(borrower) / 4;

        vm.prank(liquidator);
        v.liquidate(borrower, partialAmount);

        paid = debtBefore - d.balanceOf(liquidator);
        seized = c.balanceOf(liquidator) - colBefore;
    }
}
