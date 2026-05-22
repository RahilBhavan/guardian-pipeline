// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../../src/Vault.sol";
import {MockERC20} from "../../src/MockERC20.sol";
import {DepositHandler} from "./handlers/DepositHandler.sol";
import {BorrowHandler} from "./handlers/BorrowHandler.sol";
import {WarpHandler} from "./handlers/WarpHandler.sol";
import {LiquidateHandler} from "./handlers/LiquidateHandler.sol";

/// @title InvariantVault — Foundry invariant fuzz harness
/// @notice Wires four handlers — deposit/withdraw, borrow/repay, time-warp +
///         accrual, and liquidation — into the fuzzer and asserts all six Vault
///         invariants hold after every randomised call sequence. Each invariant
///         is genuinely *tensioned*: interest accrual moves the borrow index
///         and lender claims, liquidation redistributes collateral, and the
///         fuzzer's job is to find any ordering or rounding that breaks the
///         maths. The same six checks are mirrored 1:1 by
///         guardian/src/evaluator.ts so the property proven pre-deployment is
///         the property monitored live.
contract InvariantVault is Test {
    Vault internal vault;
    MockERC20 internal token;
    DepositHandler internal depositHandler;
    BorrowHandler internal borrowHandler;
    WarpHandler internal warpHandler;
    LiquidateHandler internal liquidateHandler;

    function setUp() public {
        token = new MockERC20();
        vault = new Vault(address(token), 10_00); // 10% APR

        depositHandler = new DepositHandler(vault, token);
        borrowHandler = new BorrowHandler(vault, token);
        warpHandler = new WarpHandler(vault);
        liquidateHandler = new LiquidateHandler(vault, token);

        // Tell Foundry which contracts to fuzz.
        targetContract(address(depositHandler));
        targetContract(address(borrowHandler));
        targetContract(address(warpHandler));
        targetContract(address(liquidateHandler));

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
    function invariant_lenderValueFloor() public view {
        assertGe(
            vault.totalSupplyAssets(),
            vault.totalSupplyShares(),
            "INV-04: totalSupplyAssets < totalSupplyShares - share price below 1:1"
        );
    }

    /// @notice INV-05 Interest-index floor — the borrow index only ever accrues
    ///         forward; it never drops below its 1e18 starting value.
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
