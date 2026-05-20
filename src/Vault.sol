// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Vault — a minimal over-collateralised lending vault
/// @notice Users deposit a single ERC-20, receive ERC-4626-style shares, and may
///         borrow up to `collateralRatio` of their share value. The contract is
///         intentionally simple — the value of this project is in the eight
///         mathematical invariants enforced both by the Foundry fuzz harness and
///         by the off-chain Guardian bot.
/// @dev    Invariants (mirrored 1:1 in test/invariant/InvariantVault.t.sol and in
///         guardian/src/evaluator.ts):
///
///         | ID     | Name                  | Formula                                                                  |
///         |--------|-----------------------|--------------------------------------------------------------------------|
///         | INV-01 | Solvency              | totalBorrowed <= totalDeposited                                          |
///         | INV-02 | Liquidity buffer      | token.balanceOf(vault) >= totalDeposited - totalBorrowed                 |
///         | INV-03 | Share price floor     | sharePrice >= 1e18                                                       |
///         | INV-04 | Share accounting      | totalShares == sum(userShares[i])                                        |
///         | INV-05 | Collateral cap        | userBorrowed[u] <= userShares[u] * sharePrice / 1e18 * collateralRatio   |
///         | INV-06 | No share inflation    | sharePrice * totalShares / 1e18 <= totalDeposited                        |
///         | INV-07 | Non-negative net      | totalDeposited >= totalBorrowed                                          |
///         | INV-08 | Zero-state            | totalShares == 0  <->  totalDeposited == 0                               |
contract Vault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice 1e18 fixed-point scaling unit.
    uint256 public constant WAD = 1e18;

    /// @notice Basis-point denominator (100_00 == 100%).
    uint256 public constant BPS = 100_00;

    /// @notice Base mainnet chain id — the demo-only {attack} function is
    ///         permanently disabled here so the backdoor can never be triggered
    ///         if this bytecode is ever deployed to production.
    uint256 public constant BASE_MAINNET = 8453;

    /// @notice The ERC-20 asset deposited, borrowed and repaid.
    IERC20 public immutable token;

    /// @notice Address allowed to call the demo-only {attack} function.
    address public immutable attacker;

    /// @notice Sum of all deposited principal currently held as shares.
    uint256 public totalDeposited;

    /// @notice Sum of all outstanding borrows across every user.
    uint256 public totalBorrowed;

    /// @notice ERC-4626-style total share supply.
    uint256 public totalShares;

    /// @notice Share-to-asset price, scaled by {WAD}. 1e18 == 1:1.
    uint256 public sharePrice;

    /// @notice Maximum borrow as a fraction of collateral value, in basis points.
    uint256 public collateralRatio;

    /// @notice Shares owned per user.
    mapping(address => uint256) public userShares;

    /// @notice Outstanding borrow principal per user.
    mapping(address => uint256) public userBorrowed;

    event Deposited(address indexed user, uint256 amount, uint256 sharesMinted);
    event Withdrawn(address indexed user, uint256 shares, uint256 amountOut);
    event Borrowed(address indexed user, uint256 amount);
    event Repaid(address indexed user, uint256 amount);
    event InvariantViolated(string invariantName, uint256 actualValue, uint256 expectedBound);

    error ZeroAmount();
    error InsufficientShares();
    error InsufficientLiquidity();
    error CollateralCapExceeded();
    error RepayExceedsDebt();
    error NotAttacker();
    error MainnetDisabled();

    /// @param _token    Address of the ERC-20 asset handled by the vault.
    /// @param _attacker Address permitted to call the demo-only {attack} function.
    constructor(address _token, address _attacker) {
        token = IERC20(_token);
        attacker = _attacker;
        sharePrice = WAD;
        collateralRatio = 80_00; // 80%
    }

    /// @notice Restricts a function to the configured attacker address.
    modifier onlyAttacker() {
        if (msg.sender != attacker) revert NotAttacker();
        _;
    }

    /// @notice Deposit `amount` of the asset and receive shares priced at {sharePrice}.
    /// @param amount Quantity of the ERC-20 asset to deposit. Must be non-zero.
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();

        uint256 sharesMinted = (amount * WAD) / sharePrice;

        token.safeTransferFrom(msg.sender, address(this), amount);

        totalDeposited += amount;
        totalShares += sharesMinted;
        userShares[msg.sender] += sharesMinted;

        emit Deposited(msg.sender, amount, sharesMinted);
    }

    /// @notice Burn `shares` and redeem the underlying asset at {sharePrice}.
    /// @dev    Reverts if free liquidity is insufficient (protects INV-02) or if the
    ///         redemption would leave the caller under-collateralised (protects INV-05).
    /// @param shares Quantity of shares to burn. May be zero (no-op).
    function withdraw(uint256 shares) external nonReentrant {
        if (shares == 0) revert ZeroAmount();
        if (shares > userShares[msg.sender]) revert InsufficientShares();

        uint256 amountOut = (shares * sharePrice) / WAD;

        // INV-02: never pay out more than the vault's free (un-borrowed) liquidity.
        if (totalDeposited - totalBorrowed < amountOut) revert InsufficientLiquidity();

        uint256 remainingShares = userShares[msg.sender] - shares;

        // INV-05: the caller must remain collateralised after the withdrawal.
        uint256 remainingCollateral = (remainingShares * sharePrice) / WAD;
        uint256 maxBorrow = (remainingCollateral * collateralRatio) / BPS;
        if (userBorrowed[msg.sender] > maxBorrow) revert CollateralCapExceeded();

        userShares[msg.sender] = remainingShares;
        totalShares -= shares;
        totalDeposited -= amountOut;

        token.safeTransfer(msg.sender, amountOut);

        emit Withdrawn(msg.sender, shares, amountOut);
    }

    /// @notice Borrow `amount` of the asset against the caller's deposited shares.
    /// @dev    Reverts unless the caller stays within their collateral cap (INV-05)
    ///         and the vault holds enough free liquidity (INV-02).
    /// @param amount Quantity of the asset to borrow. Must be non-zero.
    function borrow(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();

        uint256 collateralValue = (userShares[msg.sender] * sharePrice) / WAD;
        uint256 maxBorrow = (collateralValue * collateralRatio) / BPS;
        if (userBorrowed[msg.sender] + amount > maxBorrow) revert CollateralCapExceeded();

        if (totalDeposited - totalBorrowed < amount) revert InsufficientLiquidity();

        userBorrowed[msg.sender] += amount;
        totalBorrowed += amount;

        token.safeTransfer(msg.sender, amount);

        emit Borrowed(msg.sender, amount);
    }

    /// @notice Repay `amount` of the caller's outstanding borrow.
    /// @param amount Quantity of the asset to repay. Must not exceed the caller's debt.
    function repay(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (amount > userBorrowed[msg.sender]) revert RepayExceedsDebt();

        token.safeTransferFrom(msg.sender, address(this), amount);

        userBorrowed[msg.sender] -= amount;
        totalBorrowed -= amount;

        emit Repaid(msg.sender, amount);
    }

    /// @notice DEMO ONLY — forcibly violates INV-01 (Solvency) so the Guardian bot
    ///         can be seen detecting and alerting on a live invariant breach.
    /// @dev    Restricted to the configured attacker address AND permanently
    ///         disabled on Base mainnet ({BASE_MAINNET}) — a hard backstop so the
    ///         backdoor cannot be triggered if this bytecode ever reaches
    ///         production. This function exists purely for the Loom demo.
    function attack() external onlyAttacker {
        if (block.chainid == BASE_MAINNET) revert MainnetDisabled();
        totalBorrowed = totalDeposited + 1;
        emit InvariantViolated("INV-01: Solvency", totalBorrowed, totalDeposited);
    }
}
