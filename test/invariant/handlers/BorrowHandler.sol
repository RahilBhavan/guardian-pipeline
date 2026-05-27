// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {HandlerBase} from "./HandlerBase.sol";
import {Vault} from "../../../src/Vault.sol";
import {MockERC20} from "../../../src/MockERC20.sol";

/// @title  BorrowHandler — bounded action space for borrow / repay.
/// @notice Both entrypoints succeed against any live vault state by
///         short-circuiting on the same conditions the vault would revert on:
///         no collateral posted, no debt to repay, no spare liquidity, or
///         insufficient balance to pay with. Partial repayments only — the
///         full-close path involves a one-wei index-rounding overshoot
///         ([`Vault._burnDebt`](../../../src/Vault.sol)) that is unit-tested
///         deterministically and intentionally kept out of the fuzz space so
///         the campaign can run with `fail_on_revert = true` cleanly.
contract BorrowHandler is HandlerBase {
    uint256 public borrowCalls;
    uint256 public repayCalls;

    constructor(Vault v, MockERC20 d, MockERC20 c) HandlerBase(v, d, c) {}

    /// @notice Fuzz entrypoint: borrow a bounded amount as a pseudo-random
    ///         actor. Capped at the smaller of (collateral cap - existing
    ///         debt) and the vault's free cash.
    function borrow(uint256 actorSeed, uint256 amountSeed) external {
        address actor = _pickActor(actorSeed);

        uint256 collateralVal = VAULT.collateralValue(actor);
        if (collateralVal == 0) return;

        uint256 cratio = VAULT.collateralRatio();
        uint256 maxBorrow = (collateralVal * cratio) / VAULT.BPS();
        uint256 currentDebt = VAULT.userDebt(actor);
        if (currentDebt >= maxBorrow) return;

        uint256 headroom = maxBorrow - currentDebt;
        uint256 cash = DEBT.balanceOf(address(VAULT));
        uint256 cap = headroom < cash ? headroom : cash;
        if (cap == 0) return;

        uint256 amount = bound(amountSeed, 1, cap);

        vm.prank(actor);
        VAULT.borrow(amount);
        borrowCalls++;
    }

    /// @notice Fuzz entrypoint: partial repayment by a pseudo-random actor.
    /// @dev    Bounded to leave at least one wei of debt outstanding so the
    ///         realised-drop accounting in `_burnDebt`'s full-close branch is
    ///         never invoked from the fuzzer — see contract notice.
    function repay(uint256 actorSeed, uint256 amountSeed) external {
        address actor = _pickActor(actorSeed);

        uint256 debt = VAULT.userDebt(actor);
        if (debt < 2) return;

        uint256 balance = DEBT.balanceOf(actor);
        if (balance == 0) return;

        uint256 maxRepay = debt - 1; // keep one wei outstanding — partial only
        if (balance < maxRepay) maxRepay = balance;
        if (maxRepay == 0) return;

        uint256 amount = bound(amountSeed, 1, maxRepay);

        vm.prank(actor);
        VAULT.repay(amount);
        repayCalls++;
    }
}
