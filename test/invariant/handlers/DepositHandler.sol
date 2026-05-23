// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {HandlerBase} from "./HandlerBase.sol";
import {Vault} from "../../../src/Vault.sol";
import {MockERC20} from "../../../src/MockERC20.sol";

/// @title  DepositHandler — bounded action space for lender deposit / withdraw.
/// @notice With `fail_on_revert = true`, every fuzz call must succeed against
///         the live vault state. Each entrypoint pre-checks the conditions
///         the vault would revert on (zero amount, zero shares, insufficient
///         liquidity, would-be-zero share mint) and short-circuits with an
///         early `return` instead of attempting a call that would fail the
///         campaign. Ghost counters expose how many of the fuzzer's *attempted*
///         calls actually mutated state, so the campaign can prove it
///         exercised the action space rather than just bouncing off bounds.
contract DepositHandler is HandlerBase {
    uint256 public depositCalls;
    uint256 public withdrawCalls;

    constructor(Vault v, MockERC20 d, MockERC20 c) HandlerBase(v, d, c) {}

    /// @notice Fuzz entrypoint: a bounded deposit by a pseudo-random actor.
    /// @dev    Bounded to the actor's debt-asset balance. When pre-existing
    ///         lender shares exist, the amount is also raised above the
    ///         floor at which `shares = amount * totalShares / totalAssets`
    ///         would round to zero, otherwise `Vault.deposit` reverts with
    ///         `ZeroAmount`.
    function deposit(uint256 actorSeed, uint256 amountSeed) external {
        address actor = _pickActor(actorSeed);
        uint256 balance = DEBT.balanceOf(actor);
        if (balance == 0) return;

        uint256 minAmount = 1;
        uint256 totalShares = VAULT.totalSupplyShares();
        if (totalShares > 0) {
            // Ensure the floor-divided share count is strictly positive.
            uint256 totalAssets = VAULT.totalSupplyAssets();
            uint256 floor = totalAssets / totalShares + 1;
            if (floor > minAmount) minAmount = floor;
        }
        if (minAmount > balance) return;

        uint256 amount = bound(amountSeed, minAmount, balance);

        vm.prank(actor);
        VAULT.deposit(amount);
        depositCalls++;
    }

    /// @notice Fuzz entrypoint: a bounded withdraw by a pseudo-random actor.
    /// @dev    Bounded to the actor's outstanding shares; further capped so
    ///         the redemption amount never exceeds the vault's free cash
    ///         (otherwise `InsufficientLiquidity` reverts the call).
    function withdraw(uint256 actorSeed, uint256 sharesSeed) external {
        address actor = _pickActor(actorSeed);
        uint256 ownShares = VAULT.userSupplyShares(actor);
        if (ownShares == 0) return;

        uint256 totalShares = VAULT.totalSupplyShares();
        uint256 totalAssets = VAULT.totalSupplyAssets();
        uint256 cash = DEBT.balanceOf(address(VAULT));
        if (totalShares == 0 || totalAssets == 0 || cash == 0) return;

        // Max shares withdrawable without exceeding free cash:
        // sharesMax = floor(cash * totalShares / totalAssets).
        uint256 cashBoundedShares = (cash * totalShares) / totalAssets;
        uint256 maxShares = cashBoundedShares < ownShares ? cashBoundedShares : ownShares;
        if (maxShares == 0) return;

        uint256 shares = bound(sharesSeed, 1, maxShares);

        vm.prank(actor);
        VAULT.withdraw(shares);
        withdrawCalls++;
    }
}
