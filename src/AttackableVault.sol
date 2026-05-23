// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vault} from "./Vault.sol";

/// @title  AttackableVault — a demo-only Vault with a deliberate insolvency hole
/// @notice Identical to {Vault} in every respect except for the {attack}
///         function, which exists purely so the Guardian bot can be filmed
///         detecting a live invariant breach. This contract is **never**
///         deployed to a production chain — the breach lives in a separate
///         contract so `src/Vault.sol`, the contract actually under audit,
///         carries no backdoor at all.
/// @dev    {attack} inflates {totalSupplyAssets} (the lender-side claim) far
///         beyond the assets backing it, so `cash + totalBorrowed` no longer
///         covers `totalSupplyAssets` — a direct INV-01 (solvency) violation
///         that the fuzz harness proves the real {Vault} can never reach. The
///         call reverts on Base mainnet as a hard backstop.
contract AttackableVault is Vault {
    /// @notice Base mainnet chain id — {attack} is permanently disabled here.
    uint256 public constant BASE_MAINNET = 8453;

    /// @notice Address permitted to call {attack}.
    address public immutable attacker;

    error NotAttacker();
    error MainnetDisabled();

    /// @param _token            ERC-20 asset handled by the vault.
    /// @param _aprBps           Annual borrow rate in basis points.
    /// @param _liquidationBonus Liquidation bonus in basis points (see {Vault}).
    /// @param _attacker         Address allowed to trigger the demo breach.
    constructor(address _token, uint256 _aprBps, uint256 _liquidationBonus, address _attacker)
        Vault(_token, _aprBps, _liquidationBonus)
    {
        attacker = _attacker;
    }

    /// @notice DEMO ONLY — forcibly violates INV-01 (Protocol solvency) by
    ///         inflating {totalSupplyAssets} so lender claims exceed the assets
    ///         backing them. Lets the Guardian bot be seen detecting a live
    ///         invariant breach within one block.
    /// @dev    Restricted to {attacker} and permanently disabled on Base
    ///         mainnet. This function is the only difference from {Vault}.
    function attack() external {
        if (msg.sender != attacker) revert NotAttacker();
        if (block.chainid == BASE_MAINNET) revert MainnetDisabled();
        // Inflate the lender-side claim with no matching assets.
        totalSupplyAssets = totalSupplyAssets * 1_000 + 1_000e18;
    }
}
