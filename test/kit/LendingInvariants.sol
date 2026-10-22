// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ILendingVaultAdapter} from "./ILendingVaultAdapter.sol";

/// @title  LendingInvariants — vault-agnostic invariant predicates.
/// @notice Each function returns true when the property holds, so a harness
///         can assert it with its own message and an exploit replay can
///         evaluate it without aborting. Stateful checks (monotonicity) take
///         the prior observation as an argument; the harness stores it.
library LendingInvariants {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;

    // ----------------------------- Solvency ------------------------------ //

    /// @notice Assets cover lender claims.
    function solvent(ILendingVaultAdapter a) internal view returns (bool) {
        return a.totalAssets() >= a.totalSupplyAssets();
    }

    /// @notice Assets in excess of lender claims. Reverts on underflow when
    ///         the vault is insolvent, which {solvent} reports separately.
    function solvencyMargin(ILendingVaultAdapter a) internal view returns (uint256) {
        return a.totalAssets() - a.totalSupplyAssets();
    }

    /// @notice The solvency margin did not shrink between two observations.
    function solvencyMarginNonDecreasing(uint256 prior, uint256 current) internal pure returns (bool) {
        return current >= prior;
    }

    // ---------------------------- Share price ---------------------------- //

    /// @notice One share-price reading. `live` is false while no shares are
    ///         outstanding, when the price is a convention, not a ratio.
    struct SharePriceObservation {
        uint256 price;
        uint256 losses;
        bool live;
    }

    function observeSharePrice(ILendingVaultAdapter a) internal view returns (SharePriceObservation memory) {
        return
            SharePriceObservation({price: a.sharePrice(), losses: a.realizedLosses(), live: a.totalSupplyShares() > 0});
    }

    /// @notice The share price never falls, except across a realised loss or
    ///         an empty-vault reset.
    function sharePriceMonotone(SharePriceObservation memory prior, SharePriceObservation memory current)
        internal
        pure
        returns (bool)
    {
        if (!prior.live || !current.live) return true;
        if (current.losses > prior.losses) return true;
        return current.price >= prior.price;
    }

    /// @notice The share price is at or above `floorWad` (1e18 == 1:1).
    function sharePriceAtLeast(ILendingVaultAdapter a, uint256 floorWad) internal view returns (bool) {
        return a.sharePrice() >= floorWad;
    }

    // ---------------------------- Collateral ----------------------------- //

    /// @notice An account with no collateral owes nothing.
    function noDebtWithoutCollateral(ILendingVaultAdapter a, address account) internal view returns (bool) {
        return a.collateralOf(account) != 0 || a.debtOf(account) == 0;
    }

    // --------------------------- Conservation ---------------------------- //

    /// @notice Total lender shares equal the sum over `accounts`. Holds only
    ///         when `accounts` is every holder, as in a closed fuzz harness.
    function supplySharesConserved(ILendingVaultAdapter a, address[] memory accounts) internal view returns (bool) {
        uint256 sum;
        for (uint256 i = 0; i < accounts.length; i++) {
            sum += a.supplySharesOf(accounts[i]);
        }
        return a.totalSupplyShares() == sum;
    }

    /// @notice Total debt shares equal the sum over `accounts` (every borrower).
    function debtSharesConserved(ILendingVaultAdapter a, address[] memory accounts) internal view returns (bool) {
        uint256 sum;
        for (uint256 i = 0; i < accounts.length; i++) {
            sum += a.debtSharesOf(accounts[i]);
        }
        return a.totalDebtShares() == sum;
    }

    /// @notice Per-account debt never sums past total debt, so rounding
    ///         favours the protocol.
    function debtRoundingFavoursProtocol(ILendingVaultAdapter a, address[] memory accounts)
        internal
        view
        returns (bool)
    {
        uint256 sum;
        for (uint256 i = 0; i < accounts.length; i++) {
            sum += a.debtOf(accounts[i]);
        }
        return sum <= a.totalDebt();
    }

    /// @notice An account's debt did not fall while its debt shares stayed
    ///         flat, so interest only accrues forward.
    function debtMonotoneUnderAccrual(uint256 priorShares, uint256 priorDebt, uint256 shares, uint256 debt)
        internal
        pure
        returns (bool)
    {
        return shares != priorShares || debt >= priorDebt;
    }

    // ---------------------------- Liquidation ---------------------------- //

    /// @notice The account owes more than its collateral value permits.
    function liquidatable(ILendingVaultAdapter a, address account) internal view returns (bool) {
        return a.debtOf(account) > (a.collateralValueOf(account) * a.liquidationThresholdBps()) / BPS;
    }

    /// @notice A liquidation seized collateral worth at most the debt repaid
    ///         plus the bonus: `seized * price / WAD <= paid * (BPS + bonus) / BPS`,
    ///         multiplied through so neither side is floored.
    function liquidationWithinBonus(uint256 paid, uint256 seized, uint256 priceWad, uint256 bonusBps)
        internal
        pure
        returns (bool)
    {
        return seized * priceWad * BPS <= paid * (BPS + bonusBps) * WAD;
    }
}
