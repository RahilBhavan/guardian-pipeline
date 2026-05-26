// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vault} from "../../src/Vault.sol";
import {MockERC20} from "../../src/MockERC20.sol";
import {MockOracle} from "../../src/MockOracle.sol";

/// @title  EchidnaActor — a proxy address Echidna drives the vault through.
/// @notice One actor instance per concurrent fuzz identity. Holding the
///         approval and balance per address (rather than `vm.prank`-ing from
///         the harness) lets Echidna run without HEVM cheatcodes, which keeps
///         the harness portable across Echidna's local + Docker images.
contract EchidnaActor {
    Vault internal immutable VAULT;
    MockERC20 internal immutable DEBT;
    MockERC20 internal immutable COLLATERAL;

    constructor(Vault v, MockERC20 debt_, MockERC20 collateral_) {
        VAULT = v;
        DEBT = debt_;
        COLLATERAL = collateral_;
        DEBT.approve(address(VAULT), type(uint256).max);
        COLLATERAL.approve(address(VAULT), type(uint256).max);
    }

    function fund(uint256 debtAmt, uint256 collateralAmt) external {
        if (debtAmt > 0) DEBT.mint(address(this), debtAmt);
        if (collateralAmt > 0) COLLATERAL.mint(address(this), collateralAmt);
    }

    function deposit(uint256 amount) external { VAULT.deposit(amount); }
    function withdraw(uint256 shares) external { VAULT.withdraw(shares); }
    function depositCollateral(uint256 amount) external { VAULT.depositCollateral(amount); }
    function withdrawCollateral(uint256 amount) external { VAULT.withdrawCollateral(amount); }
    function borrow(uint256 amount) external { VAULT.borrow(amount); }
    function repay(uint256 amount) external { VAULT.repay(amount); }
    function liquidate(address borrower, uint256 amount) external {
        VAULT.liquidate(borrower, amount);
    }
}

/// @title  EchidnaVault — Echidna property fuzz harness.
/// @notice An independent fuzz engine cross-checking the Foundry invariant
///         campaign. Same vault, same six invariants — different generator,
///         different shrinker, different language runtime. If both Foundry
///         and Echidna agree the properties hold, the residual probability
///         that a randomly-findable bug remains is meaningfully lower than
///         either alone.
/// @dev    The harness deploys three {EchidnaActor} proxies up front and pre-
///         funds them generously, then exposes per-actor entry points that
///         clamp inputs to the live vault state. Calls that would revert
///         against the live state short-circuit with an early return — the
///         same convention the Foundry handlers use under
///         `fail_on_revert = true`. The six `echidna_*` properties mirror
///         the Foundry asserts 1:1, including the same multi-actor sums for
///         INV-02/03 and the same no-bad-debt scan for INV-06.
///
///         Run with `make echidna` (degrades gracefully if Echidna isn't
///         installed) or `echidna . --contract EchidnaVault --config echidna.yaml`.
contract EchidnaVault {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 100_00;
    uint256 internal constant APR_BPS = 10_00; // 10%
    uint256 internal constant LIQ_BONUS_BPS = 5_00; // 5%
    uint256 internal constant INITIAL_PRICE = 2_000e18;
    uint256 internal constant ACTOR_COUNT = 3;
    uint256 internal constant FUND_PER_ACTOR = 1_000_000e18;
    uint256 internal constant PRICE_MIN = 100e18;
    uint256 internal constant PRICE_MAX = 10_000e18;

    Vault internal vault;
    MockERC20 internal debt;
    MockERC20 internal collateral;
    MockOracle internal oracle;
    EchidnaActor[ACTOR_COUNT] internal actors;

    constructor() {
        debt = new MockERC20();
        collateral = new MockERC20();
        oracle = new MockOracle(INITIAL_PRICE);
        vault = new Vault(
            address(debt), address(collateral), address(oracle), APR_BPS, LIQ_BONUS_BPS
        );

        for (uint256 i = 0; i < ACTOR_COUNT; i++) {
            actors[i] = new EchidnaActor(vault, debt, collateral);
            actors[i].fund(FUND_PER_ACTOR, FUND_PER_ACTOR);
        }

        // Seed initial liquidity through actor 0 so borrows have something to
        // pull. The seed deposit is the only privileged step — every other
        // state transition is fuzz-driven.
        actors[0].deposit(100_000e18);
        actors[0].depositCollateral(10_000e18);
    }

    // --------------------------------------------------------------------- //
    //                            Fuzz entry points                          //
    // --------------------------------------------------------------------- //

    function op_deposit(uint8 actorSeed, uint256 amountSeed) external {
        EchidnaActor a = actors[actorSeed % ACTOR_COUNT];
        uint256 balance = debt.balanceOf(address(a));
        if (balance == 0) return;
        uint256 amount = (amountSeed % balance) + 1;
        a.deposit(amount);
    }

    function op_withdraw(uint8 actorSeed, uint256 sharesSeed) external {
        EchidnaActor a = actors[actorSeed % ACTOR_COUNT];
        uint256 owned = vault.userSupplyShares(address(a));
        if (owned == 0) return;
        uint256 shares = (sharesSeed % owned) + 1;
        uint256 supplyAssets = vault.totalSupplyAssets();
        uint256 supplyShares = vault.totalSupplyShares();
        if (supplyShares == 0) return;
        uint256 amountOut = (shares * supplyAssets) / supplyShares;
        if (debt.balanceOf(address(vault)) < amountOut) return;
        a.withdraw(shares);
    }

    function op_depositCollateral(uint8 actorSeed, uint256 amountSeed) external {
        EchidnaActor a = actors[actorSeed % ACTOR_COUNT];
        uint256 balance = collateral.balanceOf(address(a));
        if (balance == 0) return;
        uint256 amount = (amountSeed % balance) + 1;
        a.depositCollateral(amount);
    }

    function op_withdrawCollateral(uint8 actorSeed, uint256 amountSeed) external {
        EchidnaActor a = actors[actorSeed % ACTOR_COUNT];
        uint256 posted = vault.userCollateral(address(a));
        if (posted == 0) return;
        uint256 amount = (amountSeed % posted) + 1;
        a.withdrawCollateral(amount);
    }

    function op_borrow(uint8 actorSeed, uint256 amountSeed) external {
        EchidnaActor a = actors[actorSeed % ACTOR_COUNT];
        uint256 collateralValue =
            (vault.userCollateral(address(a)) * oracle.storedPrice()) / WAD;
        uint256 maxBorrow = (collateralValue * 80_00) / BPS;
        uint256 outstanding = vault.userDebt(address(a));
        if (outstanding >= maxBorrow) return;
        uint256 headroom = maxBorrow - outstanding;
        uint256 cash = debt.balanceOf(address(vault));
        if (cash == 0) return;
        uint256 ceil = headroom < cash ? headroom : cash;
        if (ceil == 0) return;
        uint256 amount = (amountSeed % ceil) + 1;
        a.borrow(amount);
    }

    function op_repay(uint8 actorSeed, uint256 amountSeed) external {
        EchidnaActor a = actors[actorSeed % ACTOR_COUNT];
        uint256 debtOwed = vault.userDebt(address(a));
        if (debtOwed == 0) return;
        uint256 balance = debt.balanceOf(address(a));
        // Top up so the actor can always meet a full close — the realised
        // pay can exceed `debt` by one wei of index rounding.
        if (balance < debtOwed + 1) {
            a.fund(debtOwed + 1 - balance, 0);
            balance = debt.balanceOf(address(a));
        }
        uint256 ceil = balance < debtOwed + 1 ? balance : debtOwed + 1;
        uint256 amount = (amountSeed % ceil) + 1;
        a.repay(amount);
    }

    function op_liquidate(uint8 liquidatorSeed, uint8 borrowerSeed, uint256 amountSeed)
        external
    {
        EchidnaActor liquidator = actors[liquidatorSeed % ACTOR_COUNT];
        EchidnaActor borrower = actors[borrowerSeed % ACTOR_COUNT];
        if (address(liquidator) == address(borrower)) return;

        uint256 debtOwed = vault.userDebt(address(borrower));
        if (debtOwed == 0) return;

        uint256 collateralValue =
            (vault.userCollateral(address(borrower)) * oracle.storedPrice()) / WAD;
        uint256 maxBorrow = (collateralValue * 80_00) / BPS;
        if (debtOwed <= maxBorrow) return; // position is healthy

        uint256 balance = debt.balanceOf(address(liquidator));
        if (balance < debtOwed + 1) {
            liquidator.fund(debtOwed + 1 - balance, 0);
            balance = debt.balanceOf(address(liquidator));
        }
        uint256 ceil = balance < debtOwed + 1 ? balance : debtOwed + 1;
        uint256 amount = (amountSeed % ceil) + 1;
        liquidator.liquidate(address(borrower), amount);
    }

    /// @notice Move the oracle price. Refreshes timestamp so the freshness
    ///         gate (INV-11) doesn't lock the harness out.
    function op_setPrice(uint256 priceSeed) external {
        uint256 price = PRICE_MIN + (priceSeed % (PRICE_MAX - PRICE_MIN + 1));
        oracle.setPrice(price);
    }

    /// @notice Refresh the oracle timestamp without moving the price.
    function op_pokeOracle() external {
        oracle.setLastUpdatedAt(block.timestamp);
    }

    /// @notice Donate either asset directly to the vault — Echidna's
    ///         inflation/donation-attack surface, mirroring DonationHandler.
    function op_donate(bool toDebt, uint256 amountSeed) external {
        uint256 amount = (amountSeed % 1_000_000e18) + 1;
        if (toDebt) {
            debt.mint(address(this), amount);
            debt.transfer(address(vault), amount);
        } else {
            collateral.mint(address(this), amount);
            collateral.transfer(address(vault), amount);
        }
    }

    // --------------------------------------------------------------------- //
    //                              Properties                               //
    // --------------------------------------------------------------------- //

    /// @notice INV-01 — protocol solvency: cash + totalBorrowed >= totalSupplyAssets.
    function echidna_solvency() external view returns (bool) {
        return vault.totalAssets() >= vault.totalSupplyAssets();
    }

    /// @notice INV-02 — totalSupplyShares == sum(userSupplyShares).
    function echidna_supply_share_integrity() external view returns (bool) {
        uint256 sum;
        for (uint256 i = 0; i < ACTOR_COUNT; i++) {
            sum += vault.userSupplyShares(address(actors[i]));
        }
        return vault.totalSupplyShares() == sum;
    }

    /// @notice INV-03 — totalBorrowShares == sum(userBorrowShares).
    function echidna_borrow_share_integrity() external view returns (bool) {
        uint256 sum;
        for (uint256 i = 0; i < ACTOR_COUNT; i++) {
            sum += vault.userBorrowShares(address(actors[i]));
        }
        return vault.totalBorrowShares() == sum;
    }

    /// @notice INV-04 — lender-value floor: share price never drops below 1:1.
    function echidna_lender_value_floor() external view returns (bool) {
        return vault.totalSupplyAssets() >= vault.totalSupplyShares();
    }

    /// @notice INV-05 — interest-index floor: borrowIndex never drops below 1e18.
    function echidna_index_floor() external view returns (bool) {
        return vault.borrowIndex() >= WAD;
    }

    /// @notice INV-06 — no uncollateralised debt: zero-collateral actors hold no debt.
    function echidna_no_bad_debt() external view returns (bool) {
        for (uint256 i = 0; i < ACTOR_COUNT; i++) {
            address a = address(actors[i]);
            if (vault.userCollateral(a) == 0 && vault.userDebt(a) > 0) return false;
        }
        return true;
    }
}
