// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../../../src/Vault.sol";
import {MockERC20} from "../../../src/MockERC20.sol";

/// @title  DonationHandler — direct-token-transfer (donation) actions.
/// @notice Adds the adversarial action the other handlers cannot reach:
///         transferring an asset *straight* to the vault with `token.transfer`,
///         bypassing {Vault.deposit} / {Vault.depositCollateral} entirely.
///         This is the ERC-4626 first-depositor / share-inflation vector —
///         an attacker donates assets hoping to move the share price and
///         dilute the next depositor.
/// @dev    {Vault} derives every figure from the stored `totalSupplyAssets`
///         and stored `userCollateral`, never from `balanceOf`, so a donation
///         on either side can never move the share price or grant unearned
///         collateral — it only enlarges the solvency margin (or sits inert
///         in the collateral asset's case). Splitting into two donation
///         entrypoints lets the fuzzer exercise both asset surfaces.
contract DonationHandler is Test {
    Vault internal immutable VAULT;
    MockERC20 internal immutable DEBT;
    MockERC20 internal immutable COLLATERAL;

    /// @notice Single donor address — deliberately not one of the five
    ///         lender/borrower actors, so a donation can never be confused
    ///         with a legitimate deposit.
    address public donor;

    /// @notice Cumulative amounts donated across the campaign — exposed so
    ///         the harness can verify both donation surfaces were exercised.
    uint256 public totalDonatedDebt;
    uint256 public totalDonatedCollateral;
    uint256 public donateDebtCalls;
    uint256 public donateCollateralCalls;

    constructor(Vault _vault, MockERC20 _debt, MockERC20 _collateral) {
        VAULT = _vault;
        DEBT = _debt;
        COLLATERAL = _collateral;
        donor = makeAddr("donor");
        DEBT.mint(donor, 1_000_000e18);
        COLLATERAL.mint(donor, 1_000_000e18);
    }

    /// @notice Fuzz entrypoint: donate the debt asset straight to the vault.
    function donateDebt(uint256 amountSeed) external {
        uint256 balance = DEBT.balanceOf(donor);
        if (balance == 0) return;
        uint256 amount = bound(amountSeed, 1, balance);

        vm.prank(donor);
        DEBT.transfer(address(VAULT), amount);
        totalDonatedDebt += amount;
        donateDebtCalls++;
    }

    /// @notice Fuzz entrypoint: donate the collateral asset straight to the vault.
    function donateCollateral(uint256 amountSeed) external {
        uint256 balance = COLLATERAL.balanceOf(donor);
        if (balance == 0) return;
        uint256 amount = bound(amountSeed, 1, balance);

        vm.prank(donor);
        COLLATERAL.transfer(address(VAULT), amount);
        totalDonatedCollateral += amount;
        donateCollateralCalls++;
    }
}
