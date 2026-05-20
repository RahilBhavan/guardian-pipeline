// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockERC20 — test-only ERC-20
/// @notice Minimal ERC-20 used by the Foundry harness and testnet deployments.
///         The constructor mints an initial supply to the deployer; {mint} is
///         intentionally unrestricted so tests and handlers can fund actors.
/// @dev    NOT for production use — {mint} has no access control.
contract MockERC20 is ERC20 {
    /// @notice Deploys the token and mints 1,000,000e18 to the deployer.
    constructor() ERC20("Mock USD", "mUSD") {
        _mint(msg.sender, 1_000_000e18);
    }

    /// @notice Mint `amount` tokens to `to`. Test-only — no access control.
    /// @param to     Recipient of the freshly minted tokens.
    /// @param amount Quantity to mint, in 1e18 units.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
