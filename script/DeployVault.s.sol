// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {AttackableVault} from "../src/AttackableVault.sol";
import {MockERC20} from "../src/MockERC20.sol";

/// @title DeployVault — Foundry deployment script for the testnet demo
/// @notice Deploys an {AttackableVault} (and a {MockERC20} when no token is
///         supplied) to Base Sepolia. The demo uses AttackableVault so the
///         Guardian bot can be filmed catching a live INV-01 breach; a
///         production deployment would deploy `src/Vault.sol` directly, which
///         carries no `attack()` backdoor at all.
/// @dev    Environment:
///         - `ATTACKER_ADDRESS` (required) — address allowed to call attack().
///         - `TOKEN_ADDRESS`    (optional) — reuse an existing ERC-20.
///         - `APR_BPS`          (optional) — borrow APR in bps, default 1000.
contract DeployVault is Script {
    function run() external {
        address attacker = vm.envAddress("ATTACKER_ADDRESS");
        address token = vm.envOr("TOKEN_ADDRESS", address(0));
        uint256 aprBps = vm.envOr("APR_BPS", uint256(10_00));

        vm.startBroadcast();

        if (token == address(0)) {
            MockERC20 mock = new MockERC20();
            token = address(mock);
            console.log("MockERC20 deployed at:", token);
        }

        AttackableVault vault = new AttackableVault(token, aprBps, attacker);
        console.log("AttackableVault deployed at:", address(vault));
        console.log("  token:   ", token);
        console.log("  aprBps:  ", aprBps);
        console.log("  attacker:", attacker);

        vm.stopBroadcast();
    }
}
