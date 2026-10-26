// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ILendingVaultAdapter} from "../ILendingVaultAdapter.sol";

// Wire types from morpho-org/morpho-blue/src/interfaces/IMorpho.sol (MIT).
struct MorphoMarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

struct MorphoMarket {
    uint128 totalSupplyAssets;
    uint128 totalSupplyShares;
    uint128 totalBorrowAssets;
    uint128 totalBorrowShares;
    uint128 lastUpdate;
    uint128 fee;
}

struct MorphoPosition {
    uint256 supplyShares;
    uint128 borrowShares;
    uint128 collateral;
}

interface IMorphoBlue {
    function market(bytes32 id) external view returns (MorphoMarket memory);
    function position(bytes32 id, address account) external view returns (MorphoPosition memory);
    function idToMarketParams(bytes32 id) external view returns (MorphoMarketParams memory);
    function createMarket(MorphoMarketParams memory params) external;
    function accrueInterest(MorphoMarketParams memory params) external;
    function supply(MorphoMarketParams memory, uint256, uint256, address, bytes calldata)
        external
        returns (uint256, uint256);
    function supplyCollateral(MorphoMarketParams memory, uint256, address, bytes calldata) external;
    function borrow(MorphoMarketParams memory, uint256, uint256, address, address) external returns (uint256, uint256);
    function repay(MorphoMarketParams memory, uint256, uint256, address, bytes calldata)
        external
        returns (uint256, uint256);
}

interface IMorphoPrice {
    function price() external view returns (uint256);
}

/// @notice Read adapter for ONE accrued Morpho Blue market, not the shared token pool.
/// @dev Call accrueInterest before observing. debtOf deliberately rounds DOWN for
/// the kit's debt-sum predicate; Morpho's borrower health check rounds UP instead.
/// This read-only adapter cannot reconstruct historical bad-debt events. It fails
/// closed for realizedLosses; use a harness-supplied loss observation for monotonicity
/// across liquidations. Do not interpret its solvency identity as token custody proof.
contract MorphoBlueAdapter is ILendingVaultAdapter {
    IMorphoBlue public immutable morpho;
    bytes32 public immutable marketId;
    address public immutable oracle;
    uint256 public immutable lltv;

    constructor(IMorphoBlue morpho_, bytes32 id_) {
        morpho = morpho_;
        marketId = id_;
        MorphoMarketParams memory p = morpho_.idToMarketParams(id_);
        require(p.loanToken != address(0) && morpho_.market(id_).lastUpdate != 0, "unknown market");
        oracle = p.oracle;
        lltv = p.lltv;
    }

    function totalAssets() external view returns (uint256) {
        MorphoMarket memory m = morpho.market(marketId);
        // Subtract first: invalid debt > claims must fail, not pass by identity.
        return uint256(m.totalSupplyAssets) - m.totalBorrowAssets + m.totalBorrowAssets;
    }

    function totalSupplyAssets() external view returns (uint256) {
        return morpho.market(marketId).totalSupplyAssets;
    }

    function totalSupplyShares() external view returns (uint256) {
        return morpho.market(marketId).totalSupplyShares;
    }

    function supplySharesOf(address account) external view returns (uint256) {
        return morpho.position(marketId, account).supplyShares;
    }

    function totalDebt() external view returns (uint256) {
        return morpho.market(marketId).totalBorrowAssets;
    }

    function totalDebtShares() external view returns (uint256) {
        return morpho.market(marketId).totalBorrowShares;
    }

    function debtSharesOf(address account) external view returns (uint256) {
        return morpho.position(marketId, account).borrowShares;
    }

    function debtOf(address account) external view virtual returns (uint256) {
        MorphoMarket memory m = morpho.market(marketId);
        return Math.mulDiv(
            morpho.position(marketId, account).borrowShares,
            uint256(m.totalBorrowAssets) + 1,
            uint256(m.totalBorrowShares) + 1e6
        );
    }

    function collateralOf(address account) external view returns (uint256) {
        return morpho.position(marketId, account).collateral;
    }

    function collateralValueOf(address account) external view returns (uint256) {
        return Math.mulDiv(morpho.position(marketId, account).collateral, IMorphoPrice(oracle).price(), 1e36);
    }

    function sharePrice() external view returns (uint256) {
        MorphoMarket memory m = morpho.market(marketId);
        return Math.mulDiv(uint256(m.totalSupplyAssets) + 1, 1e18, uint256(m.totalSupplyShares) + 1e6);
    }

    function realizedLosses() external pure returns (uint256) {
        revert("use indexed Liquidate.badDebtAssets for losses");
    }

    function collateralPrice() external view returns (uint256) {
        return IMorphoPrice(oracle).price() / 1e18;
    }

    function liquidationThresholdBps() external view returns (uint256) {
        return lltv / 1e14;
    }

    function liquidationBonusBps() external view returns (uint256) {
        uint256 factor = Math.min(1.15e18, 1e36 / (1e18 - (0.3e18 * (1e18 - lltv)) / 1e18));
        // Round UP: a fractional bps incentive must not understate the bound.
        return Math.ceilDiv((factor - 1e18) * 10_000, 1e18);
    }
}
