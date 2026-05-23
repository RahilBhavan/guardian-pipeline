// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title  Vault — an interest-bearing, over-collateralised lending vault
/// @notice Lenders deposit a single ERC-20 and receive shares whose value rises
///         as borrowers pay interest. Borrowers post shares as collateral and
///         may borrow up to `collateralRatio` of their share value; their debt
///         grows over time through a `borrowIndex`. Positions that drift
///         under-water can be cleared by anyone via {liquidate} for a bonus.
/// @dev    Accounting follows the Morpho-style dual-tracked model: the lender
///         side stores `totalSupplyAssets` directly, the borrower side scales a
///         `borrowIndex`. Interest moves both sides by the *same* realised
///         amount, so the solvency margin can never erode by rounding — it can
///         only grow. The contract's value is in six mathematical invariants,
///         each one *tensioned* by interest accrual and liquidation, proven
///         pre-deployment by the Foundry fuzz harness
///         (test/invariant/InvariantVault.t.sol) and monitored live by the
///         Guardian bot (guardian/src/evaluator.ts):
///
///         | ID     | Name                     | Property                                              |
///         |--------|--------------------------|-------------------------------------------------------|
///         | INV-01 | Protocol solvency        | cash + totalBorrowed >= totalSupplyAssets             |
///         | INV-02 | Supply-share integrity   | totalSupplyShares == sum(userSupplyShares[i])         |
///         | INV-03 | Debt-share integrity     | totalBorrowShares == sum(userBorrowShares[i])         |
///         | INV-04 | Lender-value floor       | totalSupplyAssets >= totalSupplyShares  (price >= 1)  |
///         | INV-05 | Interest-index floor     | borrowIndex >= 1e18                                   |
///         | INV-06 | No uncollateralised debt | userSupplyShares[u] == 0  =>  userDebt(u) == 0        |
contract Vault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice 1e18 fixed-point scaling unit.
    uint256 public constant WAD = 1e18;

    /// @notice Basis-point denominator (100_00 == 100%).
    uint256 public constant BPS = 100_00;

    /// @notice Seconds in a 365-day year — the interest-rate time base.
    uint256 public constant SECONDS_PER_YEAR = 365 days;

    /// @notice The ERC-20 asset deposited, borrowed, repaid and seized.
    IERC20 public immutable token;

    /// @notice Per-second borrow rate, scaled by {WAD}. Derived from the APR
    ///         passed to the constructor: `aprBps * WAD / BPS / SECONDS_PER_YEAR`.
    uint256 public immutable borrowRatePerSecond;

    /// @notice Maximum borrow as a fraction of collateral value, in basis points.
    uint256 public immutable collateralRatio;

    /// @notice Extra collateral a liquidator seizes, in basis points — the bonus
    ///         that incentivises third parties to clear under-water positions.
    uint256 public immutable liquidationBonus;

    /// @notice Total assets owed to lenders, in asset units. Stored directly and
    ///         grown by realised interest — never derived from the token balance,
    ///         which is what makes the vault immune to donation/inflation attacks.
    uint256 public totalSupplyAssets;

    /// @notice Total lender shares outstanding.
    uint256 public totalSupplyShares;

    /// @notice Lender shares held per address.
    mapping(address => uint256) public userSupplyShares;

    /// @notice Total borrow shares outstanding. A borrow share's asset value is
    ///         `borrowIndex`-scaled, so interest accrues to every borrower at
    ///         once without a per-user storage write.
    uint256 public totalBorrowShares;

    /// @notice Borrow shares owed per address.
    mapping(address => uint256) public userBorrowShares;

    /// @notice Debt-scaling index, scaled by {WAD}. Starts at 1e18 and rises
    ///         monotonically — `userDebt = userBorrowShares * borrowIndex / 1e18`.
    uint256 public borrowIndex;

    /// @notice Unix timestamp of the most recent interest accrual.
    uint256 public lastAccrualTime;

    event Deposited(address indexed user, uint256 amount, uint256 sharesMinted);
    event Withdrawn(address indexed user, uint256 shares, uint256 amountOut);
    event Borrowed(address indexed user, uint256 amount, uint256 borrowShares);
    event Repaid(address indexed user, uint256 amount, uint256 borrowSharesBurned);
    event Liquidated(
        address indexed liquidator,
        address indexed borrower,
        uint256 debtRepaid,
        uint256 collateralSeized
    );
    event Accrued(uint256 interest, uint256 newBorrowIndex);

    error ZeroAmount();
    error InsufficientShares();
    error InsufficientLiquidity();
    error CollateralCapExceeded();
    error NoDebt();
    error PositionHealthy();
    error MustClearDebt();
    error InvalidLiquidationBonus();

    /// @param _token            Address of the ERC-20 asset handled by the vault.
    /// @param _aprBps           Annual borrow rate in basis points (e.g. 1000 == 10% APR).
    /// @param _liquidationBonus Extra collateral seized by liquidators, in basis
    ///                          points. Must be in `(0, 50_00]` — i.e. strictly
    ///                          positive and no more than 50%. A zero bonus
    ///                          removes the liquidator's incentive to clear
    ///                          under-water positions; a bonus above 50% lets a
    ///                          single liquidation seize disproportionate
    ///                          collateral relative to the debt repaid.
    constructor(address _token, uint256 _aprBps, uint256 _liquidationBonus) {
        if (_liquidationBonus == 0 || _liquidationBonus > 50_00) {
            revert InvalidLiquidationBonus();
        }
        token = IERC20(_token);
        borrowRatePerSecond = (_aprBps * WAD) / BPS / SECONDS_PER_YEAR;
        collateralRatio = 80_00; // 80%
        liquidationBonus = _liquidationBonus;
        borrowIndex = WAD;
        lastAccrualTime = block.timestamp;
    }

    // --------------------------------------------------------------------- //
    //                              Interest                                 //
    // --------------------------------------------------------------------- //

    /// @notice Accrue borrower interest since the last accrual and credit it to
    ///         lenders. Idempotent within a block. Called at the start of every
    ///         state-mutating function; also callable directly so off-chain
    ///         tooling can force state to a fresh block.
    /// @dev    Borrowers are charged by raising {borrowIndex}; the *realised*
    ///         charge is then added to {totalSupplyAssets}. Both sides move by
    ///         the identical amount, so INV-01 (solvency) holds exactly — the
    ///         accrual path introduces no rounding drift in either direction.
    function accrue() public {
        uint256 dt = block.timestamp - lastAccrualTime;
        if (dt == 0) return;
        lastAccrualTime = block.timestamp;

        uint256 borrowedBefore = totalBorrowed();
        if (borrowedBefore == 0) return;

        borrowIndex += (borrowIndex * borrowRatePerSecond * dt) / WAD;

        uint256 interest = totalBorrowed() - borrowedBefore;
        if (interest > 0) {
            totalSupplyAssets += interest;
            emit Accrued(interest, borrowIndex);
        }
    }

    // --------------------------------------------------------------------- //
    //                            Lender actions                             //
    // --------------------------------------------------------------------- //

    /// @notice Deposit `amount` of the asset and receive lender shares.
    /// @param amount Quantity of the ERC-20 asset to deposit. Must be non-zero.
    function deposit(uint256 amount) external nonReentrant {
        accrue();
        if (amount == 0) revert ZeroAmount();

        // Floor division — the depositor's claim is worth no more than `amount`.
        uint256 shares =
            totalSupplyShares == 0 ? amount : (amount * totalSupplyShares) / totalSupplyAssets;
        if (shares == 0) revert ZeroAmount();

        token.safeTransferFrom(msg.sender, address(this), amount);

        totalSupplyAssets += amount;
        totalSupplyShares += shares;
        userSupplyShares[msg.sender] += shares;

        emit Deposited(msg.sender, amount, shares);
    }

    /// @notice Burn `shares` and redeem the underlying asset.
    /// @dev    Reverts if free liquidity is insufficient or if the redemption
    ///         would leave the caller under-collateralised.
    /// @param shares Quantity of lender shares to burn. Must be non-zero.
    function withdraw(uint256 shares) external nonReentrant {
        accrue();
        if (shares == 0) revert ZeroAmount();
        if (shares > userSupplyShares[msg.sender]) revert InsufficientShares();

        // Floor division — the vault pays out no more than the shares are worth.
        uint256 amountOut = (shares * totalSupplyAssets) / totalSupplyShares;
        if (token.balanceOf(address(this)) < amountOut) revert InsufficientLiquidity();

        // The caller must remain collateralised against the shares they keep.
        uint256 remainingShares = userSupplyShares[msg.sender] - shares;
        uint256 remainingCollateral =
            (remainingShares * totalSupplyAssets) / totalSupplyShares;
        uint256 maxBorrow = (remainingCollateral * collateralRatio) / BPS;
        if (userDebt(msg.sender) > maxBorrow) revert CollateralCapExceeded();

        totalSupplyAssets -= amountOut;
        totalSupplyShares -= shares;
        userSupplyShares[msg.sender] = remainingShares;

        token.safeTransfer(msg.sender, amountOut);

        emit Withdrawn(msg.sender, shares, amountOut);
    }

    // --------------------------------------------------------------------- //
    //                           Borrower actions                            //
    // --------------------------------------------------------------------- //

    /// @notice Borrow `amount` of the asset against the caller's deposited shares.
    /// @dev    Reverts unless the caller stays within their collateral cap and
    ///         the vault holds enough free liquidity.
    /// @param amount Quantity of the asset to borrow. Must be non-zero.
    function borrow(uint256 amount) external nonReentrant {
        accrue();
        if (amount == 0) revert ZeroAmount();

        uint256 maxBorrow = (collateralValue(msg.sender) * collateralRatio) / BPS;
        if (userDebt(msg.sender) + amount > maxBorrow) revert CollateralCapExceeded();

        if (token.balanceOf(address(this)) < amount) revert InsufficientLiquidity();

        // Ceil division — the borrower's recorded debt is never less than the
        // asset they receive, so a borrow can only grow the solvency margin.
        uint256 borrowShares = (amount * WAD + borrowIndex - 1) / borrowIndex;

        totalBorrowShares += borrowShares;
        userBorrowShares[msg.sender] += borrowShares;

        token.safeTransfer(msg.sender, amount);

        emit Borrowed(msg.sender, amount, borrowShares);
    }

    /// @notice Repay up to the caller's full outstanding debt.
    /// @dev    Offering `amount >= debt` fully closes the position; the amount
    ///         actually collected is the realised drop in {totalBorrowed}, which
    ///         equals the debt or, by at most one wei of index rounding, one wei
    ///         more. Offering less repays exactly `amount`.
    /// @param amount Quantity of the asset the caller offers to repay.
    function repay(uint256 amount) external nonReentrant {
        accrue();
        if (amount == 0) revert ZeroAmount();

        uint256 debt = userDebt(msg.sender);
        if (debt == 0) revert NoDebt();

        (uint256 pay, uint256 burned) = _burnDebt(msg.sender, amount, debt);

        token.safeTransferFrom(msg.sender, address(this), pay);

        emit Repaid(msg.sender, pay, burned);
    }

    /// @notice Clear an under-water borrower's position: repay part or all of
    ///         their debt and seize their collateral plus a {liquidationBonus}.
    /// @dev    Only callable when the borrower's debt exceeds their collateral
    ///         cap. If the seizure would consume all of the borrower's
    ///         collateral, the liquidator must repay the *entire* debt — this is
    ///         what keeps INV-06 (no uncollateralised debt) true.
    /// @param borrower The under-water position to liquidate.
    /// @param amount   Debt the liquidator offers to repay; clamped to the debt.
    function liquidate(address borrower, uint256 amount) external nonReentrant {
        accrue();

        uint256 debt = userDebt(borrower);
        if (debt == 0) revert NoDebt();

        uint256 maxBorrow = (collateralValue(borrower) * collateralRatio) / BPS;
        if (debt <= maxBorrow) revert PositionHealthy();

        bool fullClose = amount >= debt;
        uint256 plannedPay = fullClose ? debt : amount;
        if (plannedPay == 0) revert ZeroAmount();

        // Collateral seized = repaid value scaled up by the liquidation bonus.
        uint256 seizeValue = (plannedPay * (BPS + liquidationBonus)) / BPS;
        uint256 seizeShares = (seizeValue * totalSupplyShares) / totalSupplyAssets;

        if (seizeShares >= userSupplyShares[borrower]) {
            // Seizing all collateral is only permitted alongside a full close,
            // otherwise the borrower would be left with debt and no shares.
            if (!fullClose) revert MustClearDebt();
            seizeShares = userSupplyShares[borrower];
        }

        (uint256 pay,) = _burnDebt(borrower, amount, debt);

        userSupplyShares[borrower] -= seizeShares;
        userSupplyShares[msg.sender] += seizeShares;

        token.safeTransferFrom(msg.sender, address(this), pay);

        emit Liquidated(msg.sender, borrower, pay, seizeShares);
    }

    // --------------------------------------------------------------------- //
    //                                 Views                                 //
    // --------------------------------------------------------------------- //

    /// @notice Total outstanding debt across all borrowers, in asset units.
    function totalBorrowed() public view returns (uint256) {
        return (totalBorrowShares * borrowIndex) / WAD;
    }

    /// @notice Outstanding debt of a single borrower, in asset units.
    /// @param user The borrower to value.
    function userDebt(address user) public view returns (uint256) {
        return (userBorrowShares[user] * borrowIndex) / WAD;
    }

    /// @notice The asset value of a lender's shares — their collateral.
    /// @param user The account to value.
    function collateralValue(address user) public view returns (uint256) {
        if (totalSupplyShares == 0) return 0;
        return (userSupplyShares[user] * totalSupplyAssets) / totalSupplyShares;
    }

    /// @notice Lender share-to-asset price, scaled by {WAD}. 1e18 == 1:1.
    function sharePrice() external view returns (uint256) {
        if (totalSupplyShares == 0) return WAD;
        return (totalSupplyAssets * WAD) / totalSupplyShares;
    }

    /// @notice The vault's idle (un-borrowed) asset balance.
    function cash() public view returns (uint256) {
        return token.balanceOf(address(this));
    }

    /// @notice Total assets backing lender shares: idle cash plus debt owed.
    function totalAssets() public view returns (uint256) {
        return cash() + totalBorrowed();
    }

    // --------------------------------------------------------------------- //
    //                               Internal                                //
    // --------------------------------------------------------------------- //

    /// @notice Burn borrow shares for a repayment and return the asset amount
    ///         that must actually be collected from the payer.
    /// @dev    A full close (`offered >= debt`) burns the borrower's entire
    ///         share balance and charges the *exact* drop in floored
    ///         {totalBorrowed} — the debt, or by at most one wei of index
    ///         rounding one wei more. Charging the realised drop is what keeps
    ///         INV-01 (solvency) exact: cash rises by precisely what debt falls
    ///         by. A partial repayment floor-divides the burned shares, so the
    ///         debt falls by no more than the `offered` amount.
    /// @param borrower Account whose debt is being reduced.
    /// @param offered  Asset amount the payer offers.
    /// @param debt     The borrower's current debt, as measured by {userDebt}.
    /// @return pay     Asset amount to collect from the payer.
    /// @return burned  Borrow shares burned.
    function _burnDebt(address borrower, uint256 offered, uint256 debt)
        private
        returns (uint256 pay, uint256 burned)
    {
        if (offered >= debt) {
            uint256 borrowedBefore = totalBorrowed();
            burned = userBorrowShares[borrower];
            userBorrowShares[borrower] = 0;
            totalBorrowShares -= burned;
            pay = borrowedBefore - totalBorrowed();
        } else {
            pay = offered;
            burned = (pay * WAD) / borrowIndex;
            userBorrowShares[borrower] -= burned;
            totalBorrowShares -= burned;
        }
    }
}
