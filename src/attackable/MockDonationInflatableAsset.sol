// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title  MockDonationInflatableAsset — a plain ERC-20 wired to a balance-derived oracle
/// @notice The collateral token used by `test/exploit/` (EXP-03). Mechanically
///         it is a stock OpenZeppelin ERC-20; what makes it "inflatable" is
///         the oracle wired to read this token's balance at a fixed holder.
///         Donating units of this token to that holder inflates the reported
///         price — the Cream 2021 mechanism (~$130M).
/// @dev    Test-only — {mint} has no access control.
contract MockDonationInflatableAsset is ERC20 {
    constructor() ERC20("Inflatable", "INFL") {
        _mint(msg.sender, 1_000_000e18);
    }

    /// @notice Mint freely. Test-only.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
