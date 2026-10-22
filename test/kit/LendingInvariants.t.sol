// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../../src/Vault.sol";
import {MockERC20} from "../../src/MockERC20.sol";
import {MockOracle} from "../../src/MockOracle.sol";
import {VaultMutantINV07} from "../mutant/VaultMutantINV07.sol";
import {VaultMutantINV08} from "../mutant/VaultMutantINV08.sol";
import {VaultMutantINV09} from "../mutant/VaultMutantINV09.sol";
import {VaultMutantINV10} from "../mutant/VaultMutantINV10.sol";
import {ILendingVaultAdapter} from "./ILendingVaultAdapter.sol";
import {LendingInvariants} from "./LendingInvariants.sol";
import {GuardianVaultAdapter} from "./adapters/GuardianVaultAdapter.sol";

/// @title  LendingInvariantsTest — the kit path is not vacuous.
/// @notice Replays the INV-07..INV-10 mutant scenarios from `test/mutant/`,
///         but evaluates the kit predicates through {GuardianVaultAdapter}
///         instead of reading the Vault directly. Each predicate must hold on
///         the real Vault and fail on the mutant, so an adapter or predicate
///         that always returned "ok" would fail here.
contract LendingInvariantsTest is Test {
    enum Kind {
        Real,
        Mutant07,
        Mutant08,
        Mutant09,
        Mutant10
    }

    uint256 internal constant PRICE = 2_000e18;

    Vault internal v;
    MockERC20 internal d;
    MockERC20 internal c;
    MockOracle internal o;
    ILendingVaultAdapter internal a;

    address internal lp = makeAddr("lp");
    address internal borrower = makeAddr("borrower");
    address internal liquidator = makeAddr("liquidator");

    // ------------------- INV-01 / INV-07 solvency ------------------------ //

    function test_solvency_holdsOnReal_failsOnMutant07() public {
        assertTrue(_borrowRoundingScenario(Kind.Real), "real Vault: kit solvency check failed");
        assertFalse(_borrowRoundingScenario(Kind.Mutant07), "MUTANT-07: kit solvency check missed floor-rounded borrow");
    }

    // ------------------------- INV-08 liquidation ------------------------ //

    function test_liquidationWithinBonus_holdsOnReal_failsOnMutant08() public {
        assertTrue(_liquidationScenario(Kind.Real), "real Vault: kit bonus bound failed");
        assertFalse(_liquidationScenario(Kind.Mutant08), "MUTANT-08: kit bonus bound missed the over-seize");
    }

    // -------------------- INV-09 debt under accrual ---------------------- //

    function test_debtMonotone_holdsOnReal_failsOnMutant09() public {
        assertTrue(_accrualScenario(Kind.Real), "real Vault: kit debt-monotone check failed");
        assertFalse(_accrualScenario(Kind.Mutant09), "MUTANT-09: kit debt-monotone check missed negative accrual");
    }

    // -------------------- INV-10 debt rounding --------------------------- //

    function test_debtRounding_holdsOnReal_failsOnMutant10() public {
        assertTrue(_debtRoundingScenario(Kind.Real), "real Vault: kit debt-rounding check failed");
        assertFalse(_debtRoundingScenario(Kind.Mutant10), "MUTANT-10: kit debt-rounding check missed ceil rounding");
    }

    // ------------------------ share price -------------------------------- //

    function test_sharePriceMonotone_rules() public pure {
        LendingInvariants.SharePriceObservation memory prior = _obs(1.5e18, 0, true);
        assertTrue(LendingInvariants.sharePriceMonotone(prior, _obs(1.6e18, 0, true)), "rise must pass");
        assertFalse(LendingInvariants.sharePriceMonotone(prior, _obs(1.4e18, 0, true)), "drop must fail");
        assertTrue(
            LendingInvariants.sharePriceMonotone(prior, _obs(1.4e18, 1, true)), "drop with a realised loss must pass"
        );
        assertTrue(LendingInvariants.sharePriceMonotone(prior, _obs(1e18, 0, false)), "empty-vault reset must pass");
        assertTrue(
            LendingInvariants.sharePriceMonotone(_obs(0, 0, false), _obs(1e18, 0, true)), "first observation must pass"
        );
    }

    function test_sharePriceRisesUnderAccrual_onReal() public {
        _deploy(Kind.Real);
        _seedLender(100_000e18);
        _postAndBorrow(borrower, 50e18, 10_000e18);
        LendingInvariants.SharePriceObservation memory before = LendingInvariants.observeSharePrice(a);
        vm.warp(block.timestamp + 365 days);
        v.accrue();
        LendingInvariants.SharePriceObservation memory after_ = LendingInvariants.observeSharePrice(a);
        assertGt(after_.price, before.price, "accrual did not raise the share price");
        assertTrue(LendingInvariants.sharePriceMonotone(before, after_), "kit flagged a rising share price");
        assertTrue(LendingInvariants.sharePriceAtLeast(a, 1e18), "INV-04 floor failed through the kit");
    }

    // ------------------------------------------------------------------- //

    function _borrowRoundingScenario(Kind kind) internal returns (bool) {
        _deploy(kind);
        _seedLender(200_000e18);
        _postAndBorrow(borrower, 80e18, 10_000e18);
        vm.warp(block.timestamp + 365 days);
        v.accrue();
        o.setLastUpdatedAt(block.timestamp);

        uint256 marginBefore = LendingInvariants.solvencyMargin(a);
        vm.prank(borrower);
        v.borrow(50_000e18 + 1);

        // The mutant drives the margin negative, so check solvency first:
        // solvencyMargin reverts on an insolvent vault.
        if (!LendingInvariants.solvent(a)) return false;
        return LendingInvariants.solvencyMarginNonDecreasing(marginBefore, LendingInvariants.solvencyMargin(a));
    }

    function _liquidationScenario(Kind kind) internal returns (bool) {
        _deploy(kind);
        _seedLender(200_000e18);
        _postAndBorrow(borrower, 50e18, 60_000e18);
        o.setPrice(PRICE / 2);
        assertTrue(LendingInvariants.liquidatable(a, borrower), "kit: under-water borrower not liquidatable");

        d.mint(liquidator, 200_000e18);
        vm.startPrank(liquidator);
        d.approve(address(v), type(uint256).max);
        uint256 debtBefore = d.balanceOf(liquidator);
        uint256 colBefore = c.balanceOf(liquidator);
        uint256 price = a.collateralPrice();
        v.liquidate(borrower, a.debtOf(borrower) / 4);
        vm.stopPrank();

        uint256 paid = debtBefore - d.balanceOf(liquidator);
        uint256 seized = c.balanceOf(liquidator) - colBefore;
        return LendingInvariants.liquidationWithinBonus(paid, seized, price, a.liquidationBonusBps());
    }

    function _accrualScenario(Kind kind) internal returns (bool) {
        _deploy(kind);
        _seedLender(100_000e18);
        _postAndBorrow(borrower, 50e18, 10_000e18);

        uint256 sharesBefore = a.debtSharesOf(borrower);
        uint256 debtBefore = a.debtOf(borrower);
        vm.warp(block.timestamp + 365 days);
        v.accrue();
        return LendingInvariants.debtMonotoneUnderAccrual(
            sharesBefore, debtBefore, a.debtSharesOf(borrower), a.debtOf(borrower)
        );
    }

    function _debtRoundingScenario(Kind kind) internal returns (bool) {
        _deploy(kind);
        _seedLender(1_000_000e18);
        address[] memory borrowers = new address[](3);
        uint256[3] memory amounts = [uint256(7_777e18 + 13), 12_345e18 + 7, 33_333e18 + 1];
        for (uint256 i = 0; i < 3; i++) {
            borrowers[i] = makeAddr(string.concat("borrower", vm.toString(i)));
            _postAndBorrow(borrowers[i], 50e18, amounts[i]);
        }
        vm.warp(block.timestamp + 365 days);
        v.accrue();
        assertTrue(LendingInvariants.debtSharesConserved(a, borrowers), "kit: debt shares not conserved");
        return LendingInvariants.debtRoundingFavoursProtocol(a, borrowers);
    }

    function _deploy(Kind kind) internal {
        d = new MockERC20();
        c = new MockERC20();
        o = new MockOracle(PRICE);
        (address da, address ca, address oa) = (address(d), address(c), address(o));
        if (kind == Kind.Mutant07) v = Vault(address(new VaultMutantINV07(da, ca, oa, 10_00, 5_00)));
        else if (kind == Kind.Mutant08) v = Vault(address(new VaultMutantINV08(da, ca, oa, 10_00, 5_00)));
        else if (kind == Kind.Mutant09) v = Vault(address(new VaultMutantINV09(da, ca, oa, 10_00, 5_00)));
        else if (kind == Kind.Mutant10) v = Vault(address(new VaultMutantINV10(da, ca, oa, 10_00, 5_00)));
        else v = new Vault(da, ca, oa, 10_00, 5_00);
        a = new GuardianVaultAdapter(v);
    }

    function _seedLender(uint256 amount) internal {
        d.mint(lp, amount);
        vm.startPrank(lp);
        d.approve(address(v), type(uint256).max);
        v.deposit(amount);
        vm.stopPrank();
        address[] memory lenders = new address[](1);
        lenders[0] = lp;
        assertTrue(LendingInvariants.supplySharesConserved(a, lenders), "kit: supply shares not conserved");
    }

    function _postAndBorrow(address who, uint256 collateralAmount, uint256 borrowAmount) internal {
        c.mint(who, collateralAmount);
        vm.startPrank(who);
        c.approve(address(v), type(uint256).max);
        v.depositCollateral(collateralAmount);
        v.borrow(borrowAmount);
        vm.stopPrank();
        assertTrue(LendingInvariants.noDebtWithoutCollateral(a, who), "kit: debt without collateral");
    }

    function _obs(uint256 price, uint256 losses, bool live)
        internal
        pure
        returns (LendingInvariants.SharePriceObservation memory)
    {
        return LendingInvariants.SharePriceObservation({price: price, losses: losses, live: live});
    }
}
