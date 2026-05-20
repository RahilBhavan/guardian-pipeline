// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {Vault} from "../src/Vault.sol";
import {MockERC20} from "../src/MockERC20.sol";

/// @title DeployVault — Foundry deployment script
/// @notice Deploys the {Vault} (and a {MockERC20} when no token is supplied).
///         Reads `ATTACKER_ADDRESS` from the environment; optionally reads
///         `TOKEN_ADDRESS` to reuse an existing asset on mainnet.
contract DeployVault is Script {
    function run() external {
        address attacker = vm.envAddress("ATTACKER_ADDRESS");
        address token = vm.envOr("TOKEN_ADDRESS", address(0));

        vm.startBroadcast();

        if (token == address(0)) {
            MockERC20 mock = new MockERC20();
            token = address(mock);
            console.log("MockERC20 deployed at:", token);
        }

        Vault vault = new Vault(token, attacker);
        console.log("Vault deployed at:", address(vault));
        console.log("  token:   ", token);
        console.log("  attacker:", attacker);

        vm.stopBroadcast();
    }
}
