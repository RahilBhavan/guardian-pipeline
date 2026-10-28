// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ILendingVaultAdapter} from "../ILendingVaultAdapter.sol";

// Wire types from revert-finance/v4lend src/vault/V4Vault.sol and Uniswap v4 PoolKey.
struct V4PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

interface IV4Vault {
    function asset() external view returns (address);
    function oracle() external view returns (address);
    function positionManager() external view returns (address);
    function vaultInfo() external view returns (uint256, uint256, uint256, uint256, uint256, uint256);
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function debtSharesTotal() external view returns (uint256);
    function loans(uint256 tokenId) external view returns (uint256 debtShares);
    function loanCount(address owner) external view returns (uint256);
    function loanAtIndex(address owner, uint256 index) external view returns (uint256);
    function tokenConfigs(address token) external view returns (uint32, uint32, uint192);
    function MAX_LIQUIDATION_PENALTY_X32() external view returns (uint32);
    function deposit(uint256 assets, address receiver) external returns (uint256);
    function repay(uint256 tokenId, uint256 amount, bool isShare) external returns (uint256, uint256);
}

interface IV4Oracle {
    function getValue(uint256 tokenId, address token) external view returns (uint256, uint256, uint256, uint256);
}

interface IV4PositionManager {
    function getPositionLiquidity(uint256 tokenId) external view returns (uint128);
    function getPoolAndPositionInfo(uint256 tokenId) external view returns (V4PoolKey memory, uint256);
}

/// @notice Read adapter for one Revert Lend V4Vault, scoped to one collateral pair.
/// @dev An account's debt and collateral sum over the position NFTs it owns in the
/// vault; a position outside the pair reverts so the pair's threshold stays exact.
/// Collateral is the oracle's full position value in asset units (price 1e18). A
/// position with no liquidity holds no tokens or fees (v4 pays fees out on every
/// liquidity change), so it is valued 0 without the oracle, whose pool-price guard
/// reverts on retired-hook pools. debtOf rounds DOWN; the vault's health check
/// rounds UP. realizedLosses fails closed: write-offs only lower the stored lend rate.
contract RevertV4VaultAdapter is ILendingVaultAdapter {
    uint256 internal constant Q32 = 2 ** 32;
    uint256 internal constant Q96 = 2 ** 96;

    IV4Vault public immutable vault;
    address public immutable asset;
    IV4Oracle public immutable oracle;
    IV4PositionManager public immutable positionManager;
    address public immutable currency0;
    address public immutable currency1;

    constructor(IV4Vault vault_, address currency0_, address currency1_) {
        vault = vault_;
        asset = vault_.asset();
        oracle = IV4Oracle(vault_.oracle());
        positionManager = IV4PositionManager(vault_.positionManager());
        currency0 = currency0_;
        currency1 = currency1_;
    }

    function totalAssets() external view returns (uint256) {
        (uint256 debt,, uint256 balance,,,) = vault.vaultInfo();
        return balance + debt;
    }

    function totalSupplyAssets() external view returns (uint256) {
        (, uint256 lent,,,,) = vault.vaultInfo();
        return lent;
    }

    function totalSupplyShares() external view returns (uint256) {
        return vault.totalSupply();
    }

    function supplySharesOf(address account) external view returns (uint256) {
        return vault.balanceOf(account);
    }

    function totalDebt() external view returns (uint256) {
        (uint256 debt,,,,,) = vault.vaultInfo();
        return debt;
    }

    function totalDebtShares() external view returns (uint256) {
        return vault.debtSharesTotal();
    }

    function debtSharesOf(address account) public view returns (uint256 shares) {
        uint256 n = vault.loanCount(account);
        for (uint256 i = 0; i < n; i++) {
            shares += vault.loans(_inPair(vault.loanAtIndex(account, i)));
        }
    }

    function debtOf(address account) external view virtual returns (uint256) {
        (,,,, uint256 debtRateX96,) = vault.vaultInfo();
        return Math.mulDiv(debtSharesOf(account), debtRateX96, Q96);
    }

    function collateralOf(address account) external view returns (uint256) {
        return collateralValueOf(account);
    }

    function collateralValueOf(address account) public view returns (uint256 value) {
        uint256 n = vault.loanCount(account);
        for (uint256 i = 0; i < n; i++) {
            uint256 tokenId = _inPair(vault.loanAtIndex(account, i));
            if (positionManager.getPositionLiquidity(tokenId) == 0) continue;
            (uint256 full,,,) = oracle.getValue(tokenId, asset);
            value += full;
        }
    }

    function sharePrice() external view returns (uint256) {
        (,,,,, uint256 lendRateX96) = vault.vaultInfo();
        return Math.mulDiv(lendRateX96, 1e18, Q96);
    }

    function realizedLosses() external pure returns (uint256) {
        revert("index lend-rate write-offs for losses");
    }

    function collateralPrice() external pure returns (uint256) {
        return 1e18;
    }

    function liquidationThresholdBps() external view returns (uint256) {
        (uint32 cf0,,) = vault.tokenConfigs(currency0);
        (uint32 cf1,,) = vault.tokenConfigs(currency1);
        return (uint256(Math.min(cf0, cf1)) * 10_000) / Q32;
    }

    function liquidationBonusBps() external view returns (uint256) {
        // Round UP: a fractional bps penalty must not understate the bound.
        return Math.ceilDiv(uint256(vault.MAX_LIQUIDATION_PENALTY_X32()) * 10_000, Q32);
    }

    function _inPair(uint256 tokenId) internal view returns (uint256) {
        (V4PoolKey memory key,) = positionManager.getPoolAndPositionInfo(tokenId);
        require(key.currency0 == currency0 && key.currency1 == currency1, "position outside adapter pair");
        return tokenId;
    }
}
