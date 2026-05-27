// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title  AttackableInflatableVault — ERC-4626-style vault with balance-derived totals
/// @notice Demo-only attackable surface for `test/exploit/` (EXP-01 and
///         EXP-10). Where the canonical {Vault} stores `totalSupplyAssets`
///         and updates it on each lender action — so a direct token donation
///         to the vault is invisible to the share price — this variant
///         derives the total from `debtAsset.balanceOf(address(this))`. A
///         1-wei first depositor followed by a donation moves the share
///         price arbitrarily (EXP-01), and a sub-rounding-threshold
///         donation across N depositors compounds into a meaningful share
///         shift (EXP-10).
/// @dev    Minimal surface: deposit/withdraw only. The exploit-replay tests
///         use this exclusively as the negative control for the canonical
///         {Vault}'s donation immunity.
contract AttackableInflatableVault {
    using SafeERC20 for IERC20;

    /// @notice The debt asset deposited by lenders.
    IERC20 public immutable asset;

    /// @notice Outstanding lender shares.
    uint256 public totalSupplyShares;

    /// @notice Shares held per address.
    mapping(address => uint256) public userSupplyShares;

    error ZeroAmount();
    error InsufficientShares();

    constructor(address _asset) {
        asset = IERC20(_asset);
    }

    /// @notice Total assets backing lender shares, derived from the live
    ///         token balance — the attackable property.
    function totalAssets() public view returns (uint256) {
        return asset.balanceOf(address(this));
    }

    /// @notice Deposit `amount`, receive shares priced against the live balance.
    /// @dev    INTENTIONAL OMISSION: no zero-shares guard. After a 1-wei
    ///         first deposit + a large donation, a later depositor's `shares`
    ///         floor-divides to 0 — the canonical defense rejects that, this
    ///         attackable surface lets the deposit through. The assets are
    ///         transferred but the depositor receives no shares (and cannot
    ///         later withdraw), which is the ERC-4626 inflation-attack drain.
    function deposit(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        uint256 supplyBefore = totalAssets();
        uint256 shares =
            totalSupplyShares == 0 ? amount : (amount * totalSupplyShares) / supplyBefore;

        asset.safeTransferFrom(msg.sender, address(this), amount);
        totalSupplyShares += shares;
        userSupplyShares[msg.sender] += shares;
    }

    /// @notice Burn `shares` and redeem proportional assets at the live balance.
    function withdraw(uint256 shares) external {
        if (shares == 0) revert ZeroAmount();
        if (shares > userSupplyShares[msg.sender]) revert InsufficientShares();
        uint256 amountOut = (shares * totalAssets()) / totalSupplyShares;
        totalSupplyShares -= shares;
        userSupplyShares[msg.sender] -= shares;
        asset.safeTransfer(msg.sender, amountOut);
    }
}
