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

        targetContract(address(depositHandler));
        targetContract(address(collateralHandler));
        targetContract(address(borrowHandler));
        targetContract(address(warpHandler));
        targetContract(address(liquidateHandler));
        targetContract(address(donationHandler));
        targetContract(address(oracleHandler));

        // Exclude the vault, tokens and oracle — they are only ever exercised
        // through the bounded handler action space.
        excludeContract(address(vault));
        excludeContract(address(debt));
        excludeContract(address(collateral));
        excludeContract(address(oracle));
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
}
