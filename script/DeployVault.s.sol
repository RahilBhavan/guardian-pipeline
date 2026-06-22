// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {AttackableVault} from "../src/AttackableVault.sol";
import {MockERC20} from "../src/MockERC20.sol";
import {MockOracle} from "../src/MockOracle.sol";

/// @title DeployVault — Foundry deployment script for the testnet demo
/// @notice Deploys an {AttackableVault} (and the supporting debt asset,
///         collateral asset and {MockOracle} when not supplied) to Base
///         Sepolia. The demo uses AttackableVault so the Guardian bot can be
///         observed catching a live INV-01 breach; a production deployment
///         would deploy `src/Vault.sol` directly, which carries no
///         `attack()` backdoor at all.
/// @dev    Environment:
///         - `ATTACKER_ADDRESS`   (required) — address allowed to call attack().
///         - `DEBT_ASSET`         (optional) — reuse an existing debt ERC-20.
///         - `COLLATERAL_ASSET`   (optional) — reuse an existing collateral ERC-20.
///         - `ORACLE_ADDRESS`     (optional) — reuse an existing IPriceOracle.
///         - `INITIAL_PRICE_WAD`  (optional) — seed price for a fresh MockOracle, default 2000e18.
///         - `APR_BPS`            (optional) — borrow APR in bps, default 1000.
///         - `LIQ_BONUS_BPS`      (optional) — liquidation bonus in bps, default 500.
contract DeployVault is Script {
    function run() external {
        address attacker = vm.envAddress("ATTACKER_ADDRESS");
        address debt = vm.envOr("DEBT_ASSET", address(0));
        address collateral = vm.envOr("COLLATERAL_ASSET", address(0));
        address oracle = vm.envOr("ORACLE_ADDRESS", address(0));
        uint256 initialPrice = vm.envOr("INITIAL_PRICE_WAD", uint256(2_000e18));
        uint256 aprBps = vm.envOr("APR_BPS", uint256(10_00));
        uint256 liquidationBonus = vm.envOr("LIQ_BONUS_BPS", uint256(5_00));

        vm.startBroadcast();

        if (debt == address(0)) {
            debt = address(new MockERC20());
            console.log("Debt MockERC20 deployed at:      ", debt);
        }
        if (collateral == address(0)) {
            collateral = address(new MockERC20());
            console.log("Collateral MockERC20 deployed at:", collateral);
        }
        if (oracle == address(0)) {
            oracle = address(new MockOracle(initialPrice));
            console.log("MockOracle deployed at:          ", oracle);
            console.log("  initial price (WAD):           ", initialPrice);
        }

        AttackableVault vault =
            new AttackableVault(debt, collateral, oracle, aprBps, liquidationBonus, attacker);

        console.log("AttackableVault deployed at:     ", address(vault));
        console.log("  debt asset:                    ", debt);
        console.log("  collateral asset:              ", collateral);
        console.log("  oracle:                        ", oracle);
        console.log("  aprBps:                        ", aprBps);
        console.log("  liquidationBonus:              ", liquidationBonus);
        console.log("  attacker:                      ", attacker);

        vm.stopBroadcast();
    }
}
