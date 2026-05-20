// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../../src/Vault.sol";
import {MockERC20} from "../../src/MockERC20.sol";
import {DepositHandler} from "./handlers/DepositHandler.sol";
import {BorrowHandler} from "./handlers/BorrowHandler.sol";
import {WarpHandler} from "./handlers/WarpHandler.sol";

/// @title InvariantVault — Foundry invariant fuzz harness
/// @notice Wires the three handlers into the fuzzer and asserts all eight
///         Vault invariants hold after every randomised call sequence. The
///         checks here are mirrored 1:1 by guardian/src/evaluator.ts so that
///         the property proven pre-deployment is the property monitored live.
contract InvariantVault is Test {
    Vault internal vault;
    MockERC20 internal token;
    DepositHandler internal depositHandler;
    BorrowHandler internal borrowHandler;
    WarpHandler internal warpHandler;

    function setUp() public {
        token = new MockERC20();
        vault = new Vault(address(token), address(0xDEAD)); // attacker = dead addr in tests

        depositHandler = new DepositHandler(vault, token);
        borrowHandler = new BorrowHandler(vault, token);
        warpHandler = new WarpHandler();

        // Tell Foundry which contracts to fuzz.
        targetContract(address(depositHandler));
        targetContract(address(borrowHandler));
        targetContract(address(warpHandler));

        // Exclude the vault and token from direct fuzzing — they are only ever
        // exercised through the bounded handler action space.
        excludeContract(address(vault));
        excludeContract(address(token));
    }

    /// @notice INV-01 Solvency — outstanding borrows never exceed deposits.
    function invariant_solvency() public view {
        assertGe(
            vault.totalDeposited(),
            vault.totalBorrowed(),
            "INV-01: totalBorrowed exceeds totalDeposited - vault is insolvent"
        );
    }

    /// @notice INV-02 Liquidity buffer — vault holds enough tokens to cover free liquidity.
    function invariant_liquidityBuffer() public view {
        uint256 expectedLiquidity = vault.totalDeposited() - vault.totalBorrowed();
        assertGe(
            token.balanceOf(address(vault)),
            expectedLiquidity,
            "INV-02: vault token balance < free liquidity"
        );
    }

    /// @notice INV-03 Share price floor — sharePrice never drops below the 1:1 peg.
    function invariant_sharePriceFloor() public view {
        assertGe(vault.sharePrice(), 1e18, "INV-03: sharePrice dropped below 1:1 peg");
    }

    /// @notice INV-04 Share accounting — totalShares equals the sum of every userShares.
    function invariant_shareAccounting() public view {
        uint256 sumShares = depositHandler.sumUserShares();
        assertEq(vault.totalShares(), sumShares, "INV-04: totalShares != sum of all userShares");
    }

    /// @notice INV-05 Per-user collateral cap — no user borrows beyond their cap.
    function invariant_collateralCap() public view {
        address[] memory actors = depositHandler.getActors();
        for (uint256 i = 0; i < actors.length; i++) {
            address user = actors[i];
            uint256 collateralValue = (vault.userShares(user) * vault.sharePrice()) / 1e18;
            uint256 maxBorrow = (collateralValue * vault.collateralRatio()) / 100_00;
            assertLe(vault.userBorrowed(user), maxBorrow, "INV-05: user borrow exceeds collateral cap");
        }
    }

    /// @notice INV-06 No share inflation — implied share value never exceeds deposits.
    function invariant_noShareInflation() public view {
        if (vault.totalShares() == 0) return;
        uint256 impliedValue = (vault.sharePrice() * vault.totalShares()) / 1e18;
        assertLe(impliedValue, vault.totalDeposited(), "INV-06: implied share value exceeds total deposited");
    }

    /// @notice INV-07 Non-negative net position — deposits always cover borrows.
    function invariant_nonNegativeNet() public view {
        assertGe(vault.totalDeposited(), vault.totalBorrowed(), "INV-07: net position negative");
    }

    /// @notice INV-08 Zero-state consistency — shares and deposits hit zero together.
    function invariant_zeroStateConsistency() public view {
        bool sharesZero = vault.totalShares() == 0;
        bool depositedZero = vault.totalDeposited() == 0;
        assertEq(sharesZero, depositedZero, "INV-08: totalShares and totalDeposited zero-state inconsistency");
    }
}
