// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../../../src/Vault.sol";
import {MockERC20} from "../../../src/MockERC20.sol";
import {ReentrantAttackToken} from "../../fixtures/ReentrantAttackToken.sol";

/// @title  ReentrancyHandler — drives a parallel Vault whose debt asset is a
///         callback-bearing ERC-20, so {invariant_reentrancySafe} can see
///         the {Vault.nonReentrant} guard actually fire.
/// @notice Walks the same deposit / withdraw / borrow / repay / collateral
///         path as the production handlers, but against a dedicated
///         {Vault} constructed with {ReentrantAttackToken} as the debt
///         asset. Every call routes through the vault, so every successful
///         debt-asset transfer fires the token's reentry hook and exercises
///         the nonReentrant guard end-to-end. Pre-checks short-circuit on
///         conditions the vault would revert on so the campaign can keep
///         running with `fail_on_revert = true`.
contract ReentrancyHandler is Test {
    Vault internal immutable VAULT;
    ReentrantAttackToken internal immutable DEBT;
    MockERC20 internal immutable COLLATERAL;

    address[] internal actors;
    uint256 internal constant ACTOR_FUND = 500_000e18;

    uint256 public depositCalls;
    uint256 public withdrawCalls;
    uint256 public depositCollateralCalls;
    uint256 public borrowCalls;
    uint256 public repayCalls;

    /// @param _vault       Parallel Vault whose debt asset is the reentrant token.
    /// @param _debt        The reentrant debt asset (still dormant — the harness
    ///                     activates the hook after this constructor returns).
    /// @param _collateral  A plain ERC-20 used as collateral; reentrancy here
    ///                     is exercised on the debt-asset surface only.
    constructor(Vault _vault, ReentrantAttackToken _debt, MockERC20 _collateral) {
        VAULT = _vault;
        DEBT = _debt;
        COLLATERAL = _collateral;

        // Reuse the same five-actor pattern as HandlerBase so the parallel
        // vault is exercised by a non-trivial actor set without sharing
        // state with the main campaign's actors.
        for (uint256 i = 0; i < 5; i++) {
            address actor = makeAddr(string.concat("reentrantUser", vm.toString(i + 1)));
            actors.push(actor);
            DEBT.mint(actor, ACTOR_FUND);
            COLLATERAL.mint(actor, ACTOR_FUND);
            vm.startPrank(actor);
            DEBT.approve(address(VAULT), type(uint256).max);
            COLLATERAL.approve(address(VAULT), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _pickActor(uint256 seed) internal view returns (address) {
        return actors[bound(seed, 0, actors.length - 1)];
    }

    /// @notice Fuzz entrypoint: deposit the reentrant debt asset. Every
    ///         successful call moves the token, which fires the hook.
    /// @dev    Accrues the parallel vault up front so the pre-check reads
    ///         the same state the vault's own `accrue` would produce — the
    ///         {WarpHandler} only accrues the main vault, so without this
    ///         the share-floor pre-check can lag the post-accrual reality
    ///         and a deposit can round to zero shares.
    function deposit(uint256 actorSeed, uint256 amountSeed) external {
        VAULT.accrue();
        address actor = _pickActor(actorSeed);
        uint256 balance = DEBT.balanceOf(actor);
        if (balance == 0) return;

        uint256 minAmount = 1;
        uint256 totalShares = VAULT.totalSupplyShares();
        if (totalShares > 0) {
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

    /// @notice Fuzz entrypoint: withdraw lender shares.
    function withdraw(uint256 actorSeed, uint256 sharesSeed) external {
        VAULT.accrue();
        address actor = _pickActor(actorSeed);
        uint256 ownShares = VAULT.userSupplyShares(actor);
        if (ownShares == 0) return;

        uint256 totalShares = VAULT.totalSupplyShares();
        uint256 totalAssets = VAULT.totalSupplyAssets();
        if (totalShares == 0 || totalAssets == 0) return;

        // Cap by available cash so we never trip InsufficientLiquidity.
        uint256 cash = DEBT.balanceOf(address(VAULT));
        uint256 maxShares = ownShares;
        uint256 cashShares = (cash * totalShares) / totalAssets;
        if (cashShares < maxShares) maxShares = cashShares;
        if (maxShares == 0) return;

        uint256 shares = bound(sharesSeed, 1, maxShares);
        vm.prank(actor);
        VAULT.withdraw(shares);
        withdrawCalls++;
    }

    /// @notice Fuzz entrypoint: post collateral. Does not fire the debt-asset
    ///         hook (collateral asset is a plain MockERC20), but it lets the
    ///         actor accumulate enough collateral to actually borrow.
    function depositCollateral(uint256 actorSeed, uint256 amountSeed) external {
        address actor = _pickActor(actorSeed);
        uint256 balance = COLLATERAL.balanceOf(actor);
        if (balance == 0) return;
        uint256 amount = bound(amountSeed, 1, balance);
        vm.prank(actor);
        VAULT.depositCollateral(amount);
        depositCollateralCalls++;
    }

    /// @notice Fuzz entrypoint: borrow the reentrant debt asset against
    ///         posted collateral. Hook fires on the outgoing transfer.
    /// @dev    Accrues first so the cap pre-check uses the same `userDebt`
    ///         the vault's own `accrue` would produce; otherwise a long
    ///         {WarpHandler} gap can let pre-check pass against a small
    ///         debt that the in-vault accrue then inflates past the cap.
    function borrow(uint256 actorSeed, uint256 amountSeed) external {
        VAULT.accrue();
        address actor = _pickActor(actorSeed);
        uint256 cValue = VAULT.collateralValue(actor);
        if (cValue == 0) return;

        uint256 maxBorrow = (cValue * VAULT.collateralRatio()) / VAULT.BPS();
        uint256 currentDebt = VAULT.userDebt(actor);
        if (currentDebt >= maxBorrow) return;

        uint256 headroom = maxBorrow - currentDebt;
        uint256 cash = DEBT.balanceOf(address(VAULT));
        if (cash == 0) return;
        if (headroom > cash) headroom = cash;
        if (headroom == 0) return;

        uint256 amount = bound(amountSeed, 1, headroom);
        vm.prank(actor);
        VAULT.borrow(amount);
        borrowCalls++;
    }

    /// @notice Fuzz entrypoint: repay outstanding debt. Hook fires on the
    ///         incoming `safeTransferFrom`. Partial only — full-close
    ///         repayments are deterministic and exercised by the unit suite.
    function repay(uint256 actorSeed, uint256 amountSeed) external {
        VAULT.accrue();
        address actor = _pickActor(actorSeed);
        uint256 debt = VAULT.userDebt(actor);
        if (debt < 2) return;

        uint256 balance = DEBT.balanceOf(actor);
        if (balance == 0) return;

        // Stay strictly below `debt` so we keep this in the partial-close
        // branch; the full-close one wei of overshoot in `_burnDebt` is
        // already covered by the main campaign's solvency invariants.
        uint256 maxPay = debt - 1;
        if (balance < maxPay) maxPay = balance;
        if (maxPay == 0) return;

        uint256 amount = bound(amountSeed, 1, maxPay);
        vm.prank(actor);
        VAULT.repay(amount);
        repayCalls++;
    }
}
