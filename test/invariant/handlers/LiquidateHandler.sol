// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {HandlerBase} from "./HandlerBase.sol";
import {Vault} from "../../../src/Vault.sol";
import {MockERC20} from "../../../src/MockERC20.sol";

/// @title  LiquidateHandler — bounded action space for liquidations.
/// @notice Liquidations only fire when the borrower's debt has been pushed
///         past their collateral cap — typically by interest accrual driven
///         by {WarpHandler} or by an oracle price drop driven by
///         {OracleHandler}. Each call short-circuits unless the live vault
///         state actually permits a partial-close liquidation, so the
///         campaign can run with `fail_on_revert = true`. Partial only — the
///         full-close path is exercised deterministically by the unit and
///         exploit-replay suites and intentionally left out of the fuzz
///         space to avoid the one-wei full-close overshoot in `_burnDebt`.
contract LiquidateHandler is HandlerBase {
    uint256 public liquidateCalls;

    /// @notice Count of liquidations that violated INV-08's per-call bound
    ///         `seized * price * BPS <= paid * (BPS + bonus) * WAD`. Read
    ///         by {InvariantVault.invariant_liquidationNoFreeLunch}.
    uint256 public liquidationsViolatedINV08;

    constructor(Vault v, MockERC20 d, MockERC20 c) HandlerBase(v, d, c) {}

    /// @notice Fuzz entrypoint: a pseudo-random liquidator clears a bounded
    ///         slice of a pseudo-random borrower's debt.
    /// @dev    Snapshots the liquidator's debt-asset and collateral-asset
    ///         balances around the call so the realised `paid` and `seized`
    ///         deltas can be cross-checked against the bonus formula. A
    ///         seize that exceeds `paid * (BPS + bonus) / BPS` in
    ///         debt-asset terms is recorded in {liquidationsViolatedINV08}
    ///         and surfaces on the next invariant tick.
    function liquidate(uint256 liqSeed, uint256 borrowerSeed, uint256 amountSeed) external {
        address liquidator = _pickActor(liqSeed);
        address borrower = _pickActor(borrowerSeed);

        uint256 maxPay = _maxPartialPay(liquidator, borrower);
        if (maxPay == 0) return;

        uint256 amount = bound(amountSeed, 1, maxPay);

        uint256 debtBefore = DEBT.balanceOf(liquidator);
        uint256 colBefore = COLLATERAL.balanceOf(liquidator);
        uint256 price = VAULT.oracle().price();

        vm.prank(liquidator);
        VAULT.liquidate(borrower, amount);
        liquidateCalls++;

        uint256 paid = debtBefore - DEBT.balanceOf(liquidator);
        uint256 seized = COLLATERAL.balanceOf(liquidator) - colBefore;

        // INV-08: seized * price / WAD <= paid * (BPS + bonus) / BPS.
        // Multiply through to avoid the inner floor:
        //   seized * price * BPS  <=  paid * (BPS + bonus) * WAD.
        uint256 bps = VAULT.BPS();
        uint256 bonus = VAULT.liquidationBonus();
        uint256 wad = VAULT.WAD();
        if (seized * price * bps > paid * (bps + bonus) * wad) {
            liquidationsViolatedINV08++;
        }
    }

    /// @notice The largest debt-asset amount the liquidator can repay against
    ///         the borrower without (a) hitting `PositionHealthy`, (b)
    ///         tripping `MustClearDebt` by seizing all collateral on a partial
    ///         close, or (c) running out of liquidator balance. Returns 0
    ///         whenever any of those pre-conditions excludes a valid call.
    /// @dev    Split out so the entrypoint stays inside the EVM stack limit.
    function _maxPartialPay(address liquidator, address borrower)
        internal
        view
        returns (uint256)
    {
        uint256 debt = VAULT.userDebt(borrower);
        if (debt < 2) return 0;

        // Must actually be under-water at the current oracle price.
        uint256 maxBorrow = (VAULT.collateralValue(borrower) * VAULT.collateralRatio()) / VAULT.BPS();
        if (debt <= maxBorrow) return 0;

        uint256 ownedCollateral = VAULT.userCollateral(borrower);
        if (ownedCollateral == 0) return 0;

        uint256 liquidatorBalance = DEBT.balanceOf(liquidator);
        if (liquidatorBalance == 0) return 0;

        uint256 price = VAULT.oracle().price();
        if (price == 0) return 0;

        // Partial-close cap: seizeCollateral < ownedCollateral.
        //   seizeCol = pay * (BPS + bonus) * WAD / (BPS * price)
        //   pay < (ownedCollateral - 1) * BPS * price / (WAD * (BPS + bonus))
        uint256 denominator = VAULT.WAD() * (VAULT.BPS() + VAULT.liquidationBonus());
        if (denominator == 0) return 0;
        uint256 collateralCap = ((ownedCollateral - 1) * VAULT.BPS() * price) / denominator;

        uint256 maxPay = collateralCap;
        // Keep one wei of debt outstanding — partial close only.
        if (debt - 1 < maxPay) maxPay = debt - 1;
        if (liquidatorBalance < maxPay) maxPay = liquidatorBalance;

        return maxPay;
    }
}
