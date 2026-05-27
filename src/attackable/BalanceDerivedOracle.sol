// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPriceOracle} from "../IPriceOracle.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title  BalanceDerivedOracle — Cream/Yearn-style price feed that reads a balance
/// @notice Demo-only attackable oracle for `test/exploit/` (EXP-03). Returns
///         `asset.balanceOf(holder) * scale`, so anyone with the ability to
///         move tokens into `holder` can move the reported price. This is the
///         class that bit Cream Finance on 27 October 2021 (~$130M): an
///         oracle that priced collateral via the underlying balance of an
///         external aggregator, where a donation inflated the reported value.
/// @dev    The canonical {MockOracle} returns a stored value that has no
///         dependency on any external balance — that is the structural
///         property EXP-03 asserts by donating to the vault and confirming
///         the canonical price() does not move.
contract BalanceDerivedOracle is IPriceOracle {
    /// @notice The ERC-20 whose balance drives the price.
    IERC20 public immutable asset;

    /// @notice The account whose balance of `asset` is read.
    address public holder;

    /// @notice WAD-scaled multiplier applied to the holder's balance.
    uint256 public immutable scale;

    error HolderAlreadySet();

    /// @param _asset The ERC-20 whose balance the oracle reads.
    /// @param _scale WAD-scaled multiplier applied per balance unit.
    constructor(address _asset, uint256 _scale) {
        asset = IERC20(_asset);
        scale = _scale;
    }

    /// @notice Set the address whose balance feeds the price. One-shot — the
    ///         attackable surface deploys the vault, then wires the oracle to
    ///         point at it (chicken-and-egg with the vault's immutable oracle).
    function setHolder(address _holder) external {
        if (holder != address(0)) revert HolderAlreadySet();
        holder = _holder;
    }

    /// @inheritdoc IPriceOracle
    function price() external view returns (uint256) {
        return asset.balanceOf(holder) * scale;
    }

    /// @inheritdoc IPriceOracle
    function lastUpdatedAt() external view returns (uint256) {
        return block.timestamp;
    }
}
