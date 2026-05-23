// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../../src/Vault.sol";
import {MockERC20} from "../../src/MockERC20.sol";
import {MockOracle} from "../../src/MockOracle.sol";

/// @title VaultParameterized — APR, liquidation-bonus and price parameter coverage
/// @notice The invariant harness (`test/invariant/`) only ever fuzzes a single
///         Vault deployment at fixed parameters. This suite closes that gap:
///         each fuzz run deploys a *fresh* Vault with random APR, random
///         liquidation bonus and random oracle price, drives a deterministic
///         adversarial sequence through it (lend → post collateral → borrow at
///         the cap → warp → accrue → attempted withdraw → attempted
///         liquidation), and re-asserts the four invariants that can be
///         checked statelessly:
///
///         - **INV-01** Protocol solvency        — `totalAssets >= totalSupplyAssets`
///         - **INV-04** Lender-value floor       — `totalSupplyAssets >= totalSupplyShares`
///         - **INV-05** Interest-index floor     — `borrowIndex >= 1e18`
///         - **INV-06** No uncollateralised debt — `userCollateral == 0` ⇒ `userDebt == 0`
///
///         INV-02 and INV-03 (sum-of-shares identities) are deliberately
///         omitted — they need a per-actor walk that the dedicated invariant
///         campaign already covers, and they are not parameter-sensitive.
contract VaultParameterized is Test {
    // Constants — bounds defined by the spec.

    /// @dev 0.01% APR — the lower fuzz bound, just above zero.
    uint256 internal constant APR_MIN = 1;

    /// @dev 100% APR — the upper fuzz bound, the project's `BPS` value.
    uint256 internal constant APR_MAX = 100_00;

    /// @dev 1% liquidation bonus — small but non-zero (the Vault rejects zero).
    uint256 internal constant BONUS_MIN = 1_00;

    /// @dev 50% liquidation bonus — the Vault's hard upper limit.
    uint256 internal constant BONUS_MAX = 50_00;

    /// @dev Fixed APR for the "vary the bonus" test.
    uint256 internal constant APR_FIXED = 10_00;

    /// @dev Fixed liquidation bonus for the "vary the APR" test.
    uint256 internal constant BONUS_FIXED = 5_00;

    /// @dev Each actor is funded with this many tokens of *each* asset.
    uint256 internal constant FUND = 1_000_000e18;

    /// @dev Default collateral price for the deterministic-parameter tests.
    uint256 internal constant PRICE_FIXED = 2_000e18;

    /// @dev Inclusive fuzz bounds on the oracle price (1 ↔ 10,000 debt units
    ///      per collateral unit) — wide enough to cross every interesting
    ///      regime, bounded away from zero (which {MockOracle} rejects).
    uint256 internal constant PRICE_MIN = 1e18;
    uint256 internal constant PRICE_MAX = 10_000e18;

    // Deterministic actors — same labels mean the sequence is reproducible.
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    // --------------------------------------------------------------------- //
    //                              Fuzz tests                               //
    // --------------------------------------------------------------------- //

    /// @notice Fuzz the APR while holding bonus and price fixed.
    function testFuzz_aprOnly(uint256 aprBps, uint256 warpSeconds) public {
        aprBps = bound(aprBps, APR_MIN, APR_MAX);
        warpSeconds = bound(warpSeconds, 1, 1_000 days);

        _runAdversarialSequence(aprBps, BONUS_FIXED, PRICE_FIXED, warpSeconds);
    }

    /// @notice Fuzz the liquidation bonus while holding APR and price fixed.
    function testFuzz_bonusOnly(uint256 liquidationBonus, uint256 warpSeconds) public {
        liquidationBonus = bound(liquidationBonus, BONUS_MIN, BONUS_MAX);
        warpSeconds = bound(warpSeconds, 1, 1_000 days);

        _runAdversarialSequence(APR_FIXED, liquidationBonus, PRICE_FIXED, warpSeconds);
    }

    /// @notice Fuzz the oracle price while holding APR and bonus fixed.
    /// @dev    Captures parameter sensitivity to oracle-driven liquidation
    ///         — at a high price the borrow cap dwarfs the requested loan
    ///         and the liquidation branch never fires; at a low price the
    ///         position is born under-water and the liquidator clears it.
    function testFuzz_priceOnly(uint256 priceWad, uint256 warpSeconds) public {
        priceWad = bound(priceWad, PRICE_MIN, PRICE_MAX);
        warpSeconds = bound(warpSeconds, 1, 1_000 days);

        _runAdversarialSequence(APR_FIXED, BONUS_FIXED, priceWad, warpSeconds);
    }

    /// @notice Fuzz APR, liquidation bonus and oracle price together — the
    ///         strongest property statement.
    function testFuzz_aprBonusPrice(
        uint256 aprBps,
        uint256 liquidationBonus,
        uint256 priceWad,
        uint256 warpSeconds
    ) public {
        aprBps = bound(aprBps, APR_MIN, APR_MAX);
        liquidationBonus = bound(liquidationBonus, BONUS_MIN, BONUS_MAX);
        priceWad = bound(priceWad, PRICE_MIN, PRICE_MAX);
        warpSeconds = bound(warpSeconds, 1, 1_000 days);

        _runAdversarialSequence(aprBps, liquidationBonus, priceWad, warpSeconds);
    }

    // --------------------------------------------------------------------- //
    //                       Constructor revert paths                        //
    // --------------------------------------------------------------------- //

    /// @notice A zero liquidation bonus is rejected by the constructor.
    function test_constructor_rejectsZeroBonus() public {
        (MockERC20 d, MockERC20 c, MockOracle o) = _freshAssets(PRICE_FIXED);
        vm.expectRevert(Vault.InvalidLiquidationBonus.selector);
        new Vault(address(d), address(c), address(o), APR_FIXED, 0);
    }

    /// @notice A liquidation bonus strictly above 50% is rejected.
    function test_constructor_rejectsBonusOver50Percent() public {
        (MockERC20 d, MockERC20 c, MockOracle o) = _freshAssets(PRICE_FIXED);
        vm.expectRevert(Vault.InvalidLiquidationBonus.selector);
        new Vault(address(d), address(c), address(o), APR_FIXED, BONUS_MAX + 1);
    }

    /// @notice The lower-bound liquidation bonus (1 bp == 0.01%) is accepted.
    function test_constructor_acceptsMinimumNonZeroBonus() public {
        (MockERC20 d, MockERC20 c, MockOracle o) = _freshAssets(PRICE_FIXED);
        Vault v = new Vault(address(d), address(c), address(o), APR_FIXED, 1);
        assertEq(v.liquidationBonus(), 1);
    }

    /// @notice The upper-bound liquidation bonus (50_00 bps == 50%) is accepted.
    function test_constructor_acceptsMaximumBonus() public {
        (MockERC20 d, MockERC20 c, MockOracle o) = _freshAssets(PRICE_FIXED);
        Vault v = new Vault(address(d), address(c), address(o), APR_FIXED, BONUS_MAX);
        assertEq(v.liquidationBonus(), BONUS_MAX);
    }

    // --------------------------------------------------------------------- //
    //                       Adversarial-sequence core                       //
    // --------------------------------------------------------------------- //

    /// @notice Deploy a fresh Vault and drive a single adversarial sequence
    ///         through it, asserting the four parameter-sensitive invariants
    ///         after every step that touches state.
    function _runAdversarialSequence(
        uint256 aprBps,
        uint256 liquidationBonus,
        uint256 priceWad,
        uint256 warpSeconds
    ) internal {
        // 1. Fresh deployment with the fuzzed parameters.
        (MockERC20 debt, MockERC20 col, MockOracle oracle) = _freshAssets(priceWad);
        Vault vault =
            new Vault(address(debt), address(col), address(oracle), aprBps, liquidationBonus);

        _fund(debt, col, vault, alice);
        _fund(debt, col, vault, bob);
        _fund(debt, col, vault, carol);

        _assertParamInvariants(vault, "post-deploy");

        // 2. Alice lends the debt asset; Bob posts collateral and borrows
        //    against it — possibly at 0 if the priced collateral cap rounds
        //    below 1 wei. Both legs touch the storage INV-01..INV-04 care about.
        vm.prank(alice);
        vault.deposit(100_000e18);
        _assertParamInvariants(vault, "post-deposit-alice");

        vm.prank(bob);
        vault.depositCollateral(10e18); // 10 collateral units posted
        _assertParamInvariants(vault, "post-collateral-bob");

        uint256 bobCap =
            (vault.collateralValue(bob) * vault.collateralRatio()) / vault.BPS();
        if (bobCap > 0) {
            uint256 bobBorrow = bobCap < 100_000e18 ? bobCap : 100_000e18;
            vm.prank(bob);
            vault.borrow(bobBorrow);
            _assertParamInvariants(vault, "post-borrow-bob");
        }

        // 3. Warp and accrue. At 100% APR over 1,000 days the borrow index
        //    moves by orders of magnitude; at 0.01% it barely moves at all.
        //    Both must keep the invariants.
        vm.warp(block.timestamp + warpSeconds);
        vault.accrue();
        _assertParamInvariants(vault, "post-accrue");

        // 4. Alice tries to withdraw 1 wei of shares. After a long warp the
        //    vault may not hold enough idle cash — we don't care which branch
        //    wins, only that the invariants hold either way.
        uint256 aliceShares = vault.userSupplyShares(alice);
        if (aliceShares > 0) {
            vm.prank(alice);
            try vault.withdraw(1) {
                // success path
            } catch {
                // revert path — InsufficientLiquidity
            }
            _assertParamInvariants(vault, "post-withdraw-alice");
        }

        // 5. Carol attempts to liquidate Bob — only succeeds if interest (or
        //    a low price) has pushed him under-water. Either outcome must
        //    hold the invariants.
        uint256 bobDebt = vault.userDebt(bob);
        uint256 bobMaxBorrow =
            (vault.collateralValue(bob) * vault.collateralRatio()) / vault.BPS();
        if (bobDebt > 0 && bobDebt > bobMaxBorrow) {
            vm.prank(carol);
            try vault.liquidate(bob, bobDebt) {
                // success path
            } catch {
                // revert path — MustClearDebt when the bonus consumes all collateral
            }
            _assertParamInvariants(vault, "post-liquidate");
        }
    }

    // --------------------------------------------------------------------- //
    //                              Invariants                               //
    // --------------------------------------------------------------------- //

    /// @notice Re-assert the four parameter-sensitive invariants. INV-06 is
    ///         spot-checked against any actor whose collateral balance is
    ///         currently zero — the only state in which it has bite.
    function _assertParamInvariants(Vault vault, string memory step) internal view {
        assertGe(
            vault.totalAssets(),
            vault.totalSupplyAssets(),
            string.concat("INV-01 violated at ", step)
        );
        assertGe(
            vault.totalSupplyAssets(),
            vault.totalSupplyShares(),
            string.concat("INV-04 violated at ", step)
        );
        assertGe(vault.borrowIndex(), 1e18, string.concat("INV-05 violated at ", step));

        // INV-06: an actor with no posted collateral cannot carry debt.
        address[3] memory actors = [alice, bob, carol];
        for (uint256 i = 0; i < actors.length; i++) {
            if (vault.userCollateral(actors[i]) == 0) {
                assertEq(
                    vault.userDebt(actors[i]),
                    0,
                    string.concat("INV-06 violated at ", step)
                );
            }
        }
    }

    /// @notice Deploy a fresh debt token, collateral token and oracle.
    function _freshAssets(uint256 priceWad)
        internal
        returns (MockERC20 d, MockERC20 c, MockOracle o)
    {
        d = new MockERC20();
        c = new MockERC20();
        o = new MockOracle(priceWad);
    }

    /// @notice Mint `FUND` of each asset to `who` and grant the vault unlimited allowances.
    function _fund(MockERC20 d, MockERC20 c, Vault vault, address who) internal {
        d.mint(who, FUND);
        c.mint(who, FUND);
        vm.startPrank(who);
        d.approve(address(vault), type(uint256).max);
        c.approve(address(vault), type(uint256).max);
        vm.stopPrank();
    }
}
