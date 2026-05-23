// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {HandlerBase} from "./HandlerBase.sol";
import {Vault} from "../../../src/Vault.sol";
import {MockERC20} from "../../../src/MockERC20.sol";

/// @title  CollateralHandler — bounded action space for posting / pulling collateral.
/// @notice The borrower side is split from the lender side under the
///         oracle-priced model: borrowers post the collateral asset
///         independently of the debt asset they later borrow. This handler
///         drives that surface and short-circuits on the exact pre-conditions
///         `Vault.depositCollateral` / `Vault.withdrawCollateral` would revert
///         on, so the campaign can run with `fail_on_revert = true`.
contract CollateralHandler is HandlerBase {
    uint256 public depositCalls;
    uint256 public withdrawCalls;

    constructor(Vault v, MockERC20 d, MockERC20 c) HandlerBase(v, d, c) {}

    /// @notice Fuzz entrypoint: post a bounded amount of collateral as a
    ///         pseudo-random actor. Bounded to the actor's collateral balance.
    function depositCollateral(uint256 actorSeed, uint256 amountSeed) external {
        address actor = _pickActor(actorSeed);
        uint256 balance = COLLATERAL.balanceOf(actor);
        if (balance == 0) return;

        uint256 amount = bound(amountSeed, 1, balance);

        vm.prank(actor);
        VAULT.depositCollateral(amount);
        depositCalls++;
    }

    /// @notice Fuzz entrypoint: pull a bounded amount of collateral as a
    ///         pseudo-random actor.
    /// @dev    Bounded so the post-withdrawal collateral still backs the
    ///         actor's outstanding debt at the current oracle price; otherwise
    ///         `CollateralCapExceeded` would revert the call.
    function withdrawCollateral(uint256 actorSeed, uint256 amountSeed) external {
        address actor = _pickActor(actorSeed);
        uint256 owned = VAULT.userCollateral(actor);
        if (owned == 0) return;

        uint256 maxWithdraw = owned;
        uint256 debt = VAULT.userDebt(actor);
        if (debt > 0) {
            // Minimum collateral that keeps the position within the cap:
            //   userDebt <= (collateral * price / WAD) * collateralRatio / BPS
            //   collateral >= userDebt * WAD * BPS / (price * collateralRatio)
            uint256 price = VAULT.oracle().price();
            if (price == 0) return;
            uint256 cratio = VAULT.collateralRatio();
            // Ceil-div so the post-state stays >= the cap, not equal-and-floor.
            uint256 numerator = debt * VAULT.WAD() * VAULT.BPS();
            uint256 denominator = price * cratio;
            if (denominator == 0) return;
            uint256 minCollateral = (numerator + denominator - 1) / denominator;
            if (minCollateral >= owned) return;
            maxWithdraw = owned - minCollateral;
        }
        if (maxWithdraw == 0) return;

        uint256 amount = bound(amountSeed, 1, maxWithdraw);

        vm.prank(actor);
        VAULT.withdrawCollateral(amount);
        withdrawCalls++;
    }
}
