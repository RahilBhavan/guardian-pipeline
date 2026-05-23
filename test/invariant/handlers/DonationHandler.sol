// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../../../src/Vault.sol";
import {MockERC20} from "../../../src/MockERC20.sol";

/// @title DonationHandler — direct-token-transfer (donation) action for the fuzzer
/// @notice Adds one adversarial action the other handlers cannot reach:
///         transferring the asset straight to the vault with `token.transfer`,
///         bypassing `deposit` entirely. This is the ERC-4626 first-depositor /
///         share-inflation vector — an attacker donates assets hoping to move
///         the share price and dilute the next depositor.
/// @dev    `Vault` derives every figure from the stored `totalSupplyAssets`,
///         never from `token.balanceOf`, so a donation cannot move the share
///         price — it only enlarges the solvency margin. Before this handler
///         existed the invariant campaign never exercised a donation at all,
///         so the claim that the harness *proves* donation-immunity
///         (security-review finding GUA-06) was asserted but untested. This
///         handler closes that gap: the fuzzer now interleaves donations with
///         every other action, and INV-01 (solvency) and INV-04 (lender-value
///         floor) must continue to hold. If a future refactor ever derived the
///         share price from the token balance, this handler would break it.
contract DonationHandler is Test {
    Vault public vault;
    MockERC20 public token;

    /// @notice The donor address — deliberately not one of the five lender/
    ///         borrower actors, so a donation can never be confused with a
    ///         legitimate deposit.
    address public donor;

    /// @notice Cumulative amount donated across the campaign — exposed so the
    ///         harness can assert the donation path was actually exercised.
    uint256 public totalDonated;

    /// @param _vault The vault under test.
    /// @param _token The ERC-20 asset the vault handles.
    constructor(Vault _vault, MockERC20 _token) {
        vault = _vault;
        token = _token;
        donor = makeAddr("donor");
        token.mint(donor, 1_000_000e18);
    }

    /// @notice Fuzz entrypoint: donate a bounded amount straight to the vault.
    function donate(uint256 amount) external {
        amount = bound(amount, 1, 50_000e18);
        if (token.balanceOf(donor) < amount) return;

        vm.prank(donor);
        token.transfer(address(vault), amount);
        totalDonated += amount;
    }
}
