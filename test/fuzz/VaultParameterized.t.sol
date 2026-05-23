// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../../src/Vault.sol";
import {MockERC20} from "../../src/MockERC20.sol";

/// @title VaultParameterized — APR and liquidation-bonus parameter coverage
/// @notice The invariant harness (`test/invariant/`) only ever fuzzes a single
///         Vault deployment at 10% APR and a 5% liquidation bonus. This suite
///         closes that gap: each fuzz run deploys a *fresh* Vault with random
///         APR and/or random liquidation bonus, drives a deterministic
///         adversarial sequence through it (deposit → borrow at the cap → warp
///         → accrue → attempted withdraw → attempted liquidation), and
///         re-asserts the four invariants that can be checked statelessly:
///
///         - **INV-01** Protocol solvency        — `totalAssets >= totalSupplyAssets`
///         - **INV-04** Lender-value floor       — `totalSupplyAssets >= totalSupplyShares`
///         - **INV-05** Interest-index floor     — `borrowIndex >= 1e18`
///         - **INV-06** No uncollateralised debt — `userSupplyShares == 0` ⇒ `userDebt == 0`
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

    /// @dev Each actor is funded with this many tokens.
    uint256 internal constant FUND = 1_000_000e18;

    // Deterministic actors — same labels mean the sequence is reproducible.
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    // --------------------------------------------------------------------- //
    //                              Fuzz tests                               //
    // --------------------------------------------------------------------- //

    /// @notice Fuzz the APR while holding the liquidation bonus at 5%.
    /// @dev    Confirms the invariants survive at any rate the constructor
    ///         accepts — including very low and very high APRs, where the
    ///         per-second rate and the index growth per warp differ by orders
    ///         of magnitude from the canonical 10%.
    function testFuzz_aprOnly(uint256 aprBps, uint256 warpSeconds) public {
        aprBps = bound(aprBps, APR_MIN, APR_MAX);
        warpSeconds = bound(warpSeconds, 1, 1_000 days);

        _runAdversarialSequence(aprBps, BONUS_FIXED, warpSeconds);
    }

    /// @notice Fuzz the liquidation bonus while holding the APR at 10%.
    /// @dev    A small bonus may be too low to cross the borrower's collateral
    ///         on a marginal liquidation; a large bonus may push `seizeShares`
    ///         above the borrower's balance and trigger the `MustClearDebt`
    ///         path. Either case should still hold the invariants.
    function testFuzz_bonusOnly(uint256 liquidationBonus, uint256 warpSeconds) public {
        liquidationBonus = bound(liquidationBonus, BONUS_MIN, BONUS_MAX);
        warpSeconds = bound(warpSeconds, 1, 1_000 days);

        _runAdversarialSequence(APR_FIXED, liquidationBonus, warpSeconds);
    }

    /// @notice Fuzz APR *and* liquidation bonus together.
    /// @dev    The combined sweep is the strongest property statement — for
    ///         any parameter pair the constructor accepts, the four invariants
    ///         hold across the adversarial sequence.
    function testFuzz_aprAndBonus(uint256 aprBps, uint256 liquidationBonus, uint256 warpSeconds)
        public
    {
        aprBps = bound(aprBps, APR_MIN, APR_MAX);
        liquidationBonus = bound(liquidationBonus, BONUS_MIN, BONUS_MAX);
        warpSeconds = bound(warpSeconds, 1, 1_000 days);

        _runAdversarialSequence(aprBps, liquidationBonus, warpSeconds);
    }

    // --------------------------------------------------------------------- //
    //                       Constructor revert paths                        //
    // --------------------------------------------------------------------- //

    /// @notice A zero liquidation bonus is rejected by the constructor.
    function test_constructor_rejectsZeroBonus() public {
        MockERC20 t = new MockERC20();
        vm.expectRevert(Vault.InvalidLiquidationBonus.selector);
        new Vault(address(t), APR_FIXED, 0);
    }

    /// @notice A liquidation bonus strictly above 50% is rejected.
    function test_constructor_rejectsBonusOver50Percent() public {
        MockERC20 t = new MockERC20();
        vm.expectRevert(Vault.InvalidLiquidationBonus.selector);
        new Vault(address(t), APR_FIXED, BONUS_MAX + 1);
    }

    /// @notice The lower-bound liquidation bonus (1 bp == 0.01%) is accepted.
    /// @dev    Asserts the inequality really is `> 0`, not `>= 1_00`.
    function test_constructor_acceptsMinimumNonZeroBonus() public {
        MockERC20 t = new MockERC20();
        Vault v = new Vault(address(t), APR_FIXED, 1);
        assertEq(v.liquidationBonus(), 1);
    }

    /// @notice The upper-bound liquidation bonus (50_00 bps == 50%) is accepted.
    function test_constructor_acceptsMaximumBonus() public {
        MockERC20 t = new MockERC20();
        Vault v = new Vault(address(t), APR_FIXED, BONUS_MAX);
        assertEq(v.liquidationBonus(), BONUS_MAX);
    }

    // --------------------------------------------------------------------- //
    //                       Adversarial-sequence core                       //
    // --------------------------------------------------------------------- //

    /// @notice Deploy a fresh Vault and drive a single adversarial sequence
    ///         through it, asserting the four parameter-sensitive invariants
    ///         after every step that touches state.
    /// @dev    The sequence is deterministic given the parameters — only the
    ///         constructor inputs and the warp duration are randomised. This
    ///         keeps each run cheap and the failure mode reproducible.
    function _runAdversarialSequence(
        uint256 aprBps,
        uint256 liquidationBonus,
        uint256 warpSeconds
    ) internal {
        // 1. Fresh deployment with the fuzzed parameters.
        MockERC20 token = new MockERC20();
        Vault vault = new Vault(address(token), aprBps, liquidationBonus);

        _fund(token, vault, alice);
        _fund(token, vault, bob);
        _fund(token, vault, carol);

        _assertParamInvariants(vault, "post-deploy");

        // 2. Alice supplies the asset; Bob supplies collateral and borrows the
        //    full 80% of his deposit. Both legs touch every storage slot
        //    INV-01..INV-04 care about.
        vm.prank(alice);
        vault.deposit(100_000e18);
        _assertParamInvariants(vault, "post-deposit-alice");

        vm.prank(bob);
        vault.deposit(10_000e18);
        _assertParamInvariants(vault, "post-deposit-bob");

        vm.prank(bob);
        vault.borrow(8_000e18); // exactly 80% of bob's collateral
        _assertParamInvariants(vault, "post-borrow-bob");

        // 3. Warp time and accrue interest. At 100% APR over 1,000 days the
        //    borrow index moves by orders of magnitude; at 0.01% it barely
        //    moves at all. Both must keep the invariants.
        vm.warp(block.timestamp + warpSeconds);
        vault.accrue();
        _assertParamInvariants(vault, "post-accrue");

        // 4. Alice tries to withdraw 1 wei worth of shares. After a long warp
        //    the vault may not hold enough idle cash, in which case the call
        //    reverts cleanly — we don't care which branch wins, only that the
        //    invariants hold either way.
        uint256 aliceShares = vault.userSupplyShares(alice);
        if (aliceShares > 0) {
            vm.prank(alice);
            try vault.withdraw(1) {
                // success path
            } catch {
                // revert path — InsufficientLiquidity / CollateralCapExceeded
            }
            _assertParamInvariants(vault, "post-withdraw-alice");
        }

        // 5. Carol attempts to liquidate Bob — only succeeds if interest has
        //    pushed him under-water. Either outcome must hold the invariants.
        uint256 bobDebt = vault.userDebt(bob);
        uint256 bobMaxBorrow = (vault.collateralValue(bob) * vault.collateralRatio()) / vault.BPS();
        if (bobDebt > 0 && bobDebt > bobMaxBorrow) {
            vm.prank(carol);
            try vault.liquidate(bob, bobDebt) {
                // success path
            } catch {
                // revert path — MustClearDebt when bonus is high enough to
                // consume the borrower's entire collateral on a partial close.
            }
            _assertParamInvariants(vault, "post-liquidate");
        }
    }

    // --------------------------------------------------------------------- //
    //                              Invariants                               //
    // --------------------------------------------------------------------- //

    /// @notice Re-assert the four parameter-sensitive invariants. INV-06 is
    ///         spot-checked against any actor whose supply-share balance is
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
        assertGe(
            vault.borrowIndex(),
            1e18,
            string.concat("INV-05 violated at ", step)
        );

        // INV-06: an actor with no supply shares cannot carry debt.
        address[3] memory actors = [alice, bob, carol];
        for (uint256 i = 0; i < actors.length; i++) {
            if (vault.userSupplyShares(actors[i]) == 0) {
                assertEq(
                    vault.userDebt(actors[i]),
                    0,
                    string.concat("INV-06 violated at ", step)
                );
            }
        }
    }

    /// @notice Mint `FUND` tokens to `who` and grant the vault an unlimited
    ///         allowance, so the sequence below never has to think about it.
    function _fund(MockERC20 token, Vault vault, address who) internal {
        token.mint(who, FUND);
        vm.prank(who);
        token.approve(address(vault), type(uint256).max);
    }
}
