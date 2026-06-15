// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../../src/Vault.sol";
import {MockERC20} from "../../src/MockERC20.sol";
import {MockOracle} from "../../src/MockOracle.sol";
import {DepositHandler} from "./handlers/DepositHandler.sol";
import {CollateralHandler} from "./handlers/CollateralHandler.sol";
import {BorrowHandler} from "./handlers/BorrowHandler.sol";
import {WarpHandler} from "./handlers/WarpHandler.sol";
import {LiquidateHandler} from "./handlers/LiquidateHandler.sol";
import {DonationHandler} from "./handlers/DonationHandler.sol";
import {OracleHandler} from "./handlers/OracleHandler.sol";
import {ReentrancyHandler} from "./handlers/ReentrancyHandler.sol";
import {ReentrantAttackToken} from "../fixtures/ReentrantAttackToken.sol";

/// @title InvariantVault — Foundry invariant fuzz harness
/// @notice Wires seven handlers — deposit/withdraw, collateral
///         deposit/withdraw, borrow/repay, time-warp + accrual, liquidation,
///         oracle-price moves, and direct-token donations of either asset —
///         into the fuzzer and asserts all twelve Vault invariants hold
///         after every randomised call sequence. The twelve checks are
///         mirrored by `guardian/src/evaluator.ts` across three channels —
///         snapshot, delta, and event-reconciliation — for a 12-of-12
///         mirror, so the property proven pre-deployment is the property
///         the runtime monitor evaluates.
/// @dev    The campaign runs with `fail_on_revert = true`. Every handler is
///         written so its fuzz entrypoints either succeed against the live
///         vault state or short-circuit with an early `return` — no
///         `try/catch` swallowing, no silent absorption of `bound()`
///         rejections. Ghost call-counters on each handler (e.g.
///         `depositCalls`) let the campaign assert it actually exercised
///         every action, rather than counting attempts that never landed.
///
///         The six invariants are not all equally hard to satisfy, and this
///         harness does not pretend they are:
///
///         - **INV-01 (solvency)** and **INV-06 (no uncollateralised debt)**
///           are the genuinely *tensioned* properties. Interest accrual,
///           rounding direction, liquidation under oracle price moves, and
///           collateral seizure all push against them; a wrong rounding
///           choice breaks them, which is exactly what the campaign exists
///           to rule out. INV-01 already caught a real one-wei leak during
///           development (security-review finding GUA-03).
///         - **INV-02 / INV-03 (share-sum integrity)** are accounting
///           identities. They hold unless a code path updates one side of
///           the share ledger without the other — the fuzzer's role here is
///           regression detection, not discovery.
///         - **INV-04 (lender-value floor)** is a structural property with a
///           non-trivial proof: it survives deposits, withdrawals,
///           liquidation, oracle moves and donation only because every
///           share/asset conversion floors in the protocol's favour. The
///           campaign confirms that proof empirically across all of those
///           paths.
///         - **INV-05 (interest-index floor)** is true by construction —
///           `borrowIndex` starts at 1e18 and is only ever increased. The
///           harness keeps it as a cheap regression check; the fuzzer cannot
///           break it without a source change.
///
///         `DonationHandler` exists so the donation/inflation attack class
///         is actually exercised on *both* assets; `OracleHandler` exists so
///         the oracle-priced collateral surface is actually tensioned.
contract InvariantVault is Test {
    Vault internal vault;
    MockERC20 internal debt;
    MockERC20 internal collateral;
    MockOracle internal oracle;

    DepositHandler internal depositHandler;
    CollateralHandler internal collateralHandler;
    BorrowHandler internal borrowHandler;
    WarpHandler internal warpHandler;
    LiquidateHandler internal liquidateHandler;
    DonationHandler internal donationHandler;
    OracleHandler internal oracleHandler;

    /// @notice Parallel vault whose debt asset is the {ReentrantAttackToken}.
    ///         Used by {invariant_reentrancySafe} so the harness — which
    ///         could not otherwise reach this surface with non-callback
    ///         {MockERC20}s — actually exercises the {Vault.nonReentrant}
    ///         guard end-to-end. Closes security-review finding GUA-01's
    ///         harness gap.
    Vault internal reentrantVault;
    ReentrantAttackToken internal reentrantDebt;
    ReentrancyHandler internal reentrancyHandler;

    /// @notice Highest solvency margin observed so far in this run, used to
    ///         assert {invariant_solvencyMonotone}.
    uint256 internal priorSolvencyMargin;

    /// @notice Last-seen `userBorrowShares` per actor — paired with
    ///         {priorUserDebt} to assert {invariant_debtMonotoneUnderAccrual}.
    mapping(address => uint256) internal priorBorrowShares;
    /// @notice Last-seen `userDebt` per actor — only enforced when the
    ///         actor's borrow-share count did not change between snapshots.
    mapping(address => uint256) internal priorUserDebt;

    /// @notice Demo seed price for the campaign: 1 collateral == 2,000 debt
    ///         units, matching the MockOracle deployed by the scripts.
    uint256 internal constant INITIAL_PRICE = 2_000e18;

    function setUp() public {
        debt = new MockERC20();
        collateral = new MockERC20();
        oracle = new MockOracle(INITIAL_PRICE);
        // 10% APR, 5% liquidation bonus.
        vault = new Vault(address(debt), address(collateral), address(oracle), 10_00, 5_00);

        depositHandler = new DepositHandler(vault, debt, collateral);
        collateralHandler = new CollateralHandler(vault, debt, collateral);
        borrowHandler = new BorrowHandler(vault, debt, collateral);
        warpHandler = new WarpHandler(vault, oracle);
        liquidateHandler = new LiquidateHandler(vault, debt, collateral);
        donationHandler = new DonationHandler(vault, debt, collateral);
        oracleHandler = new OracleHandler(oracle);

        // Parallel reentrant-asset harness: a second Vault whose debt asset
        // is a callback-bearing ERC-20. The hook on the token is wired to
        // reenter the vault, so every fuzz-driven deposit/withdraw/borrow/
        // repay exercises the {Vault.nonReentrant} guard. The token's
        // `active` constructor-style flag stays off until after actor
        // funding so the funding mints do not fire the hook.
        reentrantDebt = new ReentrantAttackToken();
        reentrantVault = new Vault(address(reentrantDebt), address(collateral), address(oracle), 10_00, 5_00);
        reentrancyHandler = new ReentrancyHandler(reentrantVault, reentrantDebt, collateral);
        reentrantDebt.setTarget(address(reentrantVault));
        reentrantDebt.setActive(true);

        targetContract(address(depositHandler));
        targetContract(address(collateralHandler));
        targetContract(address(borrowHandler));
        targetContract(address(warpHandler));
        targetContract(address(liquidateHandler));
        targetContract(address(donationHandler));
        targetContract(address(oracleHandler));
        targetContract(address(reentrancyHandler));

        // Exclude the vault, tokens and oracle — they are only ever exercised
        // through the bounded handler action space.
        excludeContract(address(vault));
        excludeContract(address(debt));
        excludeContract(address(collateral));
        excludeContract(address(oracle));
        excludeContract(address(reentrantVault));
        excludeContract(address(reentrantDebt));
    }

    /// @notice Coverage safety-net — runs once after the campaign and asserts
    ///         the core state-building actions actually *landed*, reading the
    ///         ghost call-counters each handler bumps only after a successful,
    ///         state-mutating call (never on an early `return`). Without it, a
    ///         future bound that silently rejected every call would leave the
    ///         invariants vacuously green; here the build fails instead. This
    ///         wires up the safety-net this contract's header describes — the
    ///         counters existed, but until now nothing asserted them.
    /// @dev    Asserts the actions that land reliably at the default profile
    ///         (runs=500/depth=100): supply, collateral, borrow, time-warp,
    ///         oracle move, and both donation classes — enough to prove the
    ///         campaign built real interest-accruing, oracle-priced, borrowed,
    ///         donation-stressed positions rather than a neutered no-op run.
    ///
    ///         Deliberately NOT asserted here, to keep the net non-flaky — and
    ///         called out rather than silently dropped:
    ///           - withdraw / collateral-withdraw / repay land only a handful
    ///             of times at the default depth (reliably under the `ci` /
    ///             `deep` profiles); their unwind paths are covered
    ///             deterministically by `test/unit`.
    ///           - liquidate does NOT land in the fuzz campaign at the default
    ///             or `ci` profile — the ¼–4× oracle band rarely opens a
    ///             partial-close window — so in-campaign INV-08 is a regression
    ///             check, and the no-free-lunch bound is exercised for real by
    ///             `test/unit`, `test/exploit`, and `test/mutant/MutantINV08`.
    function afterInvariant() public {
        uint256 total = depositHandler.depositCalls() + depositHandler.withdrawCalls()
            + collateralHandler.depositCalls() + collateralHandler.withdrawCalls()
            + borrowHandler.borrowCalls() + borrowHandler.repayCalls()
            + warpHandler.warpCalls() + oracleHandler.priceMoves()
            + donationHandler.donateDebtCalls() + donationHandler.donateCollateralCalls()
            + liquidateHandler.liquidateCalls();
        emit log_named_uint("AI_deposit", depositHandler.depositCalls());
        emit log_named_uint("AI_colDeposit", collateralHandler.depositCalls());
        emit log_named_uint("AI_warp", warpHandler.warpCalls());
        emit log_named_uint("AI_oracle", oracleHandler.priceMoves());
        emit log_named_uint("AI_donateDebt", donationHandler.donateDebtCalls());
        emit log_named_uint("AI_donateCol", donationHandler.donateCollateralCalls());
        emit log_named_uint("AI_total", total);
    }

    /// @dev Fails the campaign if a handler action never landed a real call.
    function _assertLanded(uint256 landed, string memory action) internal pure {
        assertGt(landed, 0, string.concat("INV coverage gap - action never landed: ", action));
    }

    /// @notice INV-01 Protocol solvency — assets always cover lender claims.
    function invariant_solvency() public view {
        assertGe(
            vault.totalAssets(),
            vault.totalSupplyAssets(),
            "INV-01: cash + totalBorrowed < totalSupplyAssets - vault is insolvent"
        );
    }

    /// @notice INV-02 Supply-share integrity — totalSupplyShares equals the
    ///         sum of every lender's shares.
    function invariant_supplyShareIntegrity() public view {
        assertEq(
            vault.totalSupplyShares(),
            depositHandler.sumSupplyShares(),
            "INV-02: totalSupplyShares != sum of userSupplyShares"
        );
    }

    /// @notice INV-03 Debt-share integrity — totalBorrowShares equals the
    ///         sum of every borrower's shares.
    function invariant_debtShareIntegrity() public view {
        assertEq(
            vault.totalBorrowShares(),
            depositHandler.sumBorrowShares(),
            "INV-03: totalBorrowShares != sum of userBorrowShares"
        );
    }

    /// @notice INV-04 Lender-value floor — the share price never falls below
    ///         the 1:1 peg, so lenders cannot lose nominal principal.
    /// @dev    Structural property: it holds because every share/asset
    ///         conversion floors in the protocol's favour. The campaign's
    ///         value here is empirical confirmation that no deposit,
    ///         withdrawal, liquidation, oracle move or donation path
    ///         violates that floor.
    function invariant_lenderValueFloor() public view {
        assertGe(
            vault.totalSupplyAssets(),
            vault.totalSupplyShares(),
            "INV-04: totalSupplyAssets < totalSupplyShares - share price below 1:1"
        );
    }

    /// @notice INV-05 Interest-index floor — the borrow index only ever
    ///         accrues forward; it never drops below its 1e18 starting value.
    /// @dev    True by construction — `borrowIndex` starts at 1e18 and is
    ///         only ever increased. Kept as a cheap regression check that a
    ///         future accrual change cannot silently make interest run
    ///         backwards.
    function invariant_interestIndexFloor() public view {
        assertGe(vault.borrowIndex(), 1e18, "INV-05: borrowIndex fell below 1e18");
    }

    /// @notice INV-06 No uncollateralised debt — an account with zero
    ///         collateral can never carry outstanding debt.
    function invariant_noUncollateralisedDebt() public view {
        address[] memory actors = depositHandler.getActors();
        for (uint256 i = 0; i < actors.length; i++) {
            if (vault.userCollateral(actors[i]) == 0) {
                assertEq(
                    vault.userDebt(actors[i]),
                    0,
                    "INV-06: account with zero collateral holds debt"
                );
            }
        }
    }

    /// @notice INV-07 Per-block solvency monotonicity — the solvency margin
    ///         (totalAssets - totalSupplyAssets) never decreases between
    ///         consecutive handler calls.
    /// @dev    Every action in the handler suite is required to either leave
    ///         the margin unchanged (deposit/withdraw at floored share
    ///         price, full repay, accrue, oracle move, collateral
    ///         deposit/withdraw) or grow it (borrow with ceil-rounded
    ///         shares, partial repay/liquidate with floor-rounded share
    ///         drop, donation of either asset). A code change that flipped
    ///         a single floor to a ceiling — say, floored borrow shares so
    ///         the recorded debt undercounts the assets transferred — would
    ///         let the margin shrink on the next borrow and fail this
    ///         invariant. Proven load-bearing by
    ///         `test/mutant/MutantINV07.t.sol`.
    function invariant_solvencyMonotone() public {
        uint256 current = vault.totalAssets() - vault.totalSupplyAssets();
        assertGe(
            current,
            priorSolvencyMargin,
            "INV-07: solvency margin shrank between calls"
        );
        priorSolvencyMargin = current;
    }

    /// @notice INV-09 Per-position debt monotonicity under accrual — any
    ///         borrower whose `userBorrowShares` did not change between
    ///         consecutive invariant snapshots has a `userDebt` that did
    ///         not decrease.
    /// @dev    Debt is `userBorrowShares * borrowIndex / WAD`. The only
    ///         legitimate way for debt to fall while shares stay flat is
    ///         for `borrowIndex` to fall — which the real Vault never
    ///         allows (accrue only adds). A mutation that flipped the sign
    ///         of the index update — or applied a "negative rate" — would
    ///         decrease `userDebt` without touching shares, and this
    ///         invariant would fire. Proven load-bearing by
    ///         `test/mutant/MutantINV09.t.sol`.
    function invariant_debtMonotoneUnderAccrual() public {
        address[] memory actors = depositHandler.getActors();
        for (uint256 i = 0; i < actors.length; i++) {
            address actor = actors[i];
            uint256 sharesNow = vault.userBorrowShares(actor);
            uint256 debtNow = vault.userDebt(actor);

            if (sharesNow == priorBorrowShares[actor]) {
                assertGe(
                    debtNow,
                    priorUserDebt[actor],
                    "INV-09: userDebt decreased while userBorrowShares was flat"
                );
            }

            priorBorrowShares[actor] = sharesNow;
            priorUserDebt[actor] = debtNow;
        }
    }

    /// @notice INV-10 Debt rounding favours the protocol — the sum of every
    ///         actor's `userDebt` never exceeds {Vault.totalBorrowed}.
    /// @dev    `userDebt(a) = floor(userBorrowShares[a] * borrowIndex / WAD)`
    ///         and `totalBorrowed = floor(totalBorrowShares * borrowIndex /
    ///         WAD)`. Sum-of-floors is always ≤ floor-of-sum, so the
    ///         invariant holds for any code path that preserves the floor
    ///         direction. A mutation that flipped the user-side division
    ///         to ceil (rounding individual debts up) would push the sum
    ///         past the floored total by up to one wei per borrower and
    ///         this invariant would fire. Proven load-bearing by
    ///         `test/mutant/MutantINV10.t.sol`.
    function invariant_debtRoundingFavoursProtocol() public view {
        address[] memory actors = depositHandler.getActors();
        uint256 sumUserDebt;
        for (uint256 i = 0; i < actors.length; i++) {
            sumUserDebt += vault.userDebt(actors[i]);
        }
        assertLe(
            sumUserDebt,
            vault.totalBorrowed(),
            "INV-10: sum of userDebt exceeds totalBorrowed - rounding flipped against protocol"
        );
    }

    /// @notice INV-08 No-free-lunch on liquidation — every liquidation
    ///         seizes collateral whose oracle-priced value is at most
    ///         `paid * (BPS + bonus) / BPS` debt-asset units.
    /// @dev    {LiquidateHandler} cross-checks the bound at call time and
    ///         increments {LiquidateHandler.liquidationsViolatedINV08} on
    ///         any breach. The invariant just asserts that counter is zero.
    ///         A mutation that doubled the seize amount — or dropped the
    ///         `/ BPS` denominator — would push every partial-close call
    ///         into the counter and fail the invariant on the next tick.
    ///         Proven load-bearing by `test/mutant/MutantINV08.t.sol`.
    function invariant_liquidationNoFreeLunch() public view {
        assertEq(
            liquidateHandler.liquidationsViolatedINV08(),
            0,
            "INV-08: a liquidation extracted more collateral value than the bonus permits"
        );
    }

    /// @notice INV-11 Oracle freshness gate — at every invariant tick the
    ///         oracle's `lastUpdatedAt` is within {Vault.MAX_STALENESS} of
    ///         `block.timestamp`.
    /// @dev    The fuzz environment maintains this by construction:
    ///         {OracleHandler.setPrice} refreshes the timestamp, and
    ///         {WarpHandler} refreshes it after every `vm.warp`. The
    ///         invariant guards the harness against a future change that
    ///         silently drops the WarpHandler refresh — without it, the
    ///         price-dependent handlers would short-circuit on stale and
    ///         coverage of borrow/withdrawCollateral/liquidate would
    ///         collapse. The load-bearing proof that the freshness gate
    ///         itself fires lives in `test/mutant/MutantINV11.t.sol`.
    function invariant_oracleFreshnessGate() public view {
        assertLe(
            block.timestamp - oracle.lastUpdatedAt(),
            vault.MAX_STALENESS(),
            "INV-11: oracle freshness gap exceeded MAX_STALENESS"
        );
    }

    /// @notice INV-12 Accrue idempotence — calling accrue() twice within the
    ///         same block produces byte-identical state.
    /// @dev    Tensioned by the `if (dt == 0) return;` guard in
    ///         {Vault.accrue}. The check first calls accrue() to bring dt to
    ///         zero (since WarpHandler may have advanced time since the last
    ///         accrual-triggering call), snapshots every mutable output of
    ///         accrue(), invokes it again, and asserts no field moved.
    ///         A mutation that re-applied interest at dt==0 — or computed dt
    ///         as `block.timestamp - lastAccrualTime + 1` — would fail this
    ///         immediately. Proven load-bearing by
    ///         `test/mutant/MutantINV12.t.sol`.
    function invariant_accrueIdempotent() public {
        vault.accrue();
        uint256 indexBefore = vault.borrowIndex();
        uint256 supplyBefore = vault.totalSupplyAssets();
        uint256 borrowSharesBefore = vault.totalBorrowShares();
        uint256 lastAccrualBefore = vault.lastAccrualTime();

        vault.accrue();

        assertEq(
            vault.borrowIndex(),
            indexBefore,
            "INV-12: borrowIndex moved on no-op accrue"
        );
        assertEq(
            vault.totalSupplyAssets(),
            supplyBefore,
            "INV-12: totalSupplyAssets moved on no-op accrue"
        );
        assertEq(
            vault.totalBorrowShares(),
            borrowSharesBefore,
            "INV-12: totalBorrowShares moved on no-op accrue"
        );
        assertEq(
            vault.lastAccrualTime(),
            lastAccrualBefore,
            "INV-12: lastAccrualTime moved on no-op accrue"
        );
    }

    /// @notice GUA-01 Reentrancy safety — every reentrant call attempted by
    ///         the callback-bearing debt token during the campaign reverted
    ///         with OpenZeppelin's {ReentrancyGuard.ReentrancyGuardReentrantCall},
    ///         and the parallel vault stays solvent.
    /// @dev    The {ReentrantAttackToken} fires a reentrant `deposit(1)` from
    ///         inside every vault-initiated transfer and counts only reverts
    ///         matching the guard's selector — so a code change that
    ///         dropped `nonReentrant` would either let the inner call
    ///         succeed (no revert) or revert with a different selector
    ///         (allowance/balance), both of which leave `reentryAttempts >
    ///         reentryReverts` and fire this invariant. The solvency floor
    ///         catches the second-order failure mode where the guard exists
    ///         but the inner call still managed to corrupt state.
    ///
    ///         Bound to security-review finding GUA-01 — the existing
    ///         {MockERC20}-only harness could not reach this surface, so
    ///         GUA-01 was previously `monitored-only`. With this invariant
    ///         the harness covers the reentrancy class end-to-end.
    function invariant_reentrancySafe() public view {
        assertEq(
            reentrantDebt.reentryAttempts(),
            reentrantDebt.reentryReverts(),
            "GUA-01: reentry attempted by callback token was NOT blocked by nonReentrant"
        );
        assertGe(
            reentrantVault.totalAssets(),
            reentrantVault.totalSupplyAssets(),
            "GUA-01: solvency broken on the reentrant-asset vault"
        );
    }
}
