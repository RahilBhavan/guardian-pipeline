// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPriceOracle} from "./IPriceOracle.sol";

/// @title  MockOracle — settable price feed for tests, the harness and demos
/// @notice Stores a single WAD-scaled price for `collateralAsset` denominated
///         in `debtAsset`. `setPrice` is intentionally permissionless: in the
///         fuzz harness the oracle handler drives the price to exercise
///         liquidation paths; in scripted demos the deployer pre-seeds a
///         realistic value. Not for production use — a real deployment must
///         wrap an authenticated feed (Chainlink, Pyth, ...) behind
///         {IPriceOracle}.
contract MockOracle is IPriceOracle {
    /// @notice 1e18 fixed-point scaling unit — kept here so callers can
    ///         construct prices without re-deriving the constant.
    uint256 public constant WAD = 1e18;

    /// @notice Current price of one collateral unit in debt-asset units, scaled by 1e18.
    uint256 public storedPrice;

    /// @notice Emitted whenever {setPrice} successfully writes a new value.
    /// @param oldPrice The price before the update, in WAD.
    /// @param newPrice The price after the update, in WAD.
    event PriceSet(uint256 oldPrice, uint256 newPrice);

    /// @notice Zero is rejected as a price — it would zero out every
    ///         borrower's collateral value and instantly mark every position
    ///         insolvent, which is not a meaningful test condition.
    error ZeroPrice();

    /// @param initialPrice Starting price in WAD. Must be non-zero.
    constructor(uint256 initialPrice) {
        if (initialPrice == 0) revert ZeroPrice();
        storedPrice = initialPrice;
    }

    /// @notice Update the price. Permissionless by design — see contract notice.
    /// @param newPrice New price in WAD. Must be non-zero.
    function setPrice(uint256 newPrice) external {
        if (newPrice == 0) revert ZeroPrice();
        uint256 old = storedPrice;
        storedPrice = newPrice;
        emit PriceSet(old, newPrice);
    }

    /// @inheritdoc IPriceOracle
    function price() external view returns (uint256) {
        return storedPrice;
    }
}
