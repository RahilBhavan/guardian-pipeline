// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockOracle} from "../../../src/MockOracle.sol";

/// @title  OracleHandler — randomised collateral-price movements.
/// @notice An oracle-priced lending vault is most-tensioned when the
///         collateral price moves. This handler drives the {MockOracle}
///         within a realistic band — quarter-to-quadruple of the seed price
///         — so the fuzzer interleaves price moves with deposits, borrows,
///         repayments, warps and liquidations. Always succeeds, so safe
///         under `fail_on_revert = true`.
contract OracleHandler is Test {
    MockOracle internal immutable ORACLE;
    uint256 public immutable seedPrice;
    uint256 public priceMoves;

    /// @notice Tightest and widest price the handler will write, in WAD.
    ///         A 4x band on either side of the seed gives enough room to
    ///         push existing positions underwater (and back) without
    ///         escaping into degenerate zero-price territory.
    uint256 public immutable minPrice;
    uint256 public immutable maxPrice;

    constructor(MockOracle _oracle) {
        ORACLE = _oracle;
        seedPrice = _oracle.price();
        minPrice = seedPrice / 4;
        maxPrice = seedPrice * 4;
    }

    /// @notice Fuzz entrypoint: move the oracle price to a bounded value.
    function setPrice(uint256 priceSeed) external {
        uint256 lo = minPrice == 0 ? 1 : minPrice;
        uint256 newPrice = bound(priceSeed, lo, maxPrice);
        ORACLE.setPrice(newPrice);
        priceMoves++;
    }
}
