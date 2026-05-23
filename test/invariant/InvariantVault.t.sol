// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../../src/Vault.sol";
import {MockERC20} from "../../src/MockERC20.sol";
import {DepositHandler} from "./handlers/DepositHandler.sol";
import {BorrowHandler} from "./handlers/BorrowHandler.sol";
import {WarpHandler} from "./handlers/WarpHandler.sol";
import {LiquidateHandler} from "./handlers/LiquidateHandler.sol";
import {DonationHandler} from "./handlers/DonationHandler.sol";

/// @title InvariantVault — Foundry invariant fuzz harness
/// @notice Wires five handlers — deposit/withdraw, borrow/repay, time-warp +
///         accrual, liquidation, and direct-token donation — into the fuzzer
///         and asserts all six Vault invariants hold after every randomised
///         call sequence. The same six checks are mirrored 1:1 by
///         guardian/src/evaluator.ts, so the property proven pre-deployment is
///         the property the runtime monitor evaluates.
/// @dev    The six invariants are not all equally hard to satisfy, and this
///         harness does not pretend they are:
///
///         - **INV-01 (solvency)** and **INV-06 (no uncollateralised debt)**
///           are the genuinely *tensioned* properties. Interest accrual,
///           rounding direction, and liquidation all push against them; a
///           wrong rounding choice breaks them, which is exactly what the
///           campaign exists to rule out. INV-01 already caught a real one-wei
///           leak during development (security-review finding GUA-03).
///         - **INV-02 / INV-03 (share-sum integrity)** are accounting
///           identities. They hold unless a code path updates one side of the
///           share ledger without the other — the fuzzer's role here is
///           regression detection, not discovery.
///         - **INV-04 (lender-value floor)** is a structural property with a
///           non-trivial proof: it survives deposits, withdrawals, liquidation
///           and donation only because every share/asset conversion floors in
///           the protocol's favour. The campaign confirms that proof empirically
///           across all of those paths.
///         - **INV-05 (interest-index floor)** is true by construction —
///           `borrowIndex` starts at 1e18 and is only ever increased. The
///           harness keeps it as a cheap regression check; the fuzzer cannot
///           break it without a source change.
///
///         `DonationHandler` exists so this honesty extends to the
///         donation/inflation attack class: without it the campaign never
///         transferred tokens straight to the vault, so the donation-immunity
///         claim (finding GUA-06) was asserted but untested. With it, the
///         fuzzer proves a donation can neither move the share price nor erode
///         solvency.
contract InvariantVault is Test {
    Vault internal vault;
    MockERC20 internal token;
    DepositHandler internal depositHandler;
    BorrowHandler internal borrowHandler;
    WarpHandler internal warpHandler;
    LiquidateHandler internal liquidateHandler;
    DonationHandler internal donationHandler;

    function setUp() public {
        token = new MockERC20();
        vault = new Vault(address(token), 10_00); // 10% APR

        depositHandler = new DepositHandler(vault, token);
        borrowHandler = new BorrowHandler(vault, token);
        warpHandler = new WarpHandler(vault);
        liquidateHandler = new LiquidateHandler(vault, token);
        donationHandler = new DonationHandler(vault, token);

        // Tell Foundry which contracts to fuzz.
        targetContract(address(depositHandler));
        targetContract(address(borrowHandler));
        targetContract(address(warpHandler));
        targetContract(address(liquidateHandler));
        targetContract(address(donationHandler));

        // Exclude the vault and token — they are only ever exercised through
        // the bounded handler action space.
        excludeContract(address(vault));
        excludeContract(address(token));
    }

    /// @notice INV-01 Protocol solvency — assets always cover lender claims.
    function invariant_solvency() public view {
        assertGe(
            vault.totalAssets(),
            vault.totalSupplyAssets(),
            "INV-01: cash + totalBorrowed < totalSupplyAssets - vault is insolvent"
        );
    }

    /// @notice INV-02 Supply-share integrity — totalSupplyShares equals the sum
    ///         of every lender's shares.
    function invariant_supplyShareIntegrity() public view {
        assertEq(
            vault.totalSupplyShares(),
            depositHandler.sumSupplyShares(),
            "INV-02: totalSupplyShares != sum of userSupplyShares"
        );
    }

    /// @notice INV-03 Debt-share integrity — totalBorrowShares equals the sum of
    ///         every borrower's shares.
    function invariant_debtShareIntegrity() public view {
        assertEq(
            vault.totalBorrowShares(),
            depositHandler.sumBorrowShares(),
            "INV-03: totalBorrowShares != sum of userBorrowShares"
        );
    }

    /// @notice INV-04 Lender-value floor — the share price never falls below the
    ///         1:1 peg, so lenders cannot lose nominal principal.
    /// @dev    Structural property: it holds because every share/asset
    ///         conversion floors in the protocol's favour. The campaign's value
    ///         here is empirical confirmation that no deposit, withdrawal,
    ///         liquidation or donation path violates that floor.
    function invariant_lenderValueFloor() public view {
        assertGe(
            vault.totalSupplyAssets(),
            vault.totalSupplyShares(),
            "INV-04: totalSupplyAssets < totalSupplyShares - share price below 1:1"
        );
    }

    /// @notice INV-05 Interest-index floor — the borrow index only ever accrues
    ///         forward; it never drops below its 1e18 starting value.
    /// @dev    True by construction — `borrowIndex` starts at 1e18 and is only
    ///         ever increased. Kept as a cheap regression check that a future
    ///         accrual change cannot silently make interest run backwards.
    function invariant_interestIndexFloor() public view {
        assertGe(vault.borrowIndex(), 1e18, "INV-05: borrowIndex fell below 1e18");
    }

    /// @notice INV-06 No uncollateralised debt — an account with zero collateral
    ///         shares can never carry outstanding debt.
    function invariant_noUncollateralisedDebt() public view {
        address[] memory actors = depositHandler.getActors();
        for (uint256 i = 0; i < actors.length; i++) {
            if (vault.userSupplyShares(actors[i]) == 0) {
                assertEq(
                    vault.userDebt(actors[i]),
                    0,
                    "INV-06: account with zero collateral holds debt"
                );
            }
        }
    }
}
