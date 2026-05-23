// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPriceOracle} from "./IPriceOracle.sol";

/// @title  Vault — an interest-bearing, over-collateralised lending vault
/// @notice Lenders deposit the **debt asset** and receive shares whose value
///         rises as borrowers pay interest. Borrowers post a separate
///         **collateral asset**, valued through an {IPriceOracle}, and may
///         borrow the debt asset up to `collateralRatio` of their collateral
///         value; their debt grows over time through a `borrowIndex`.
///         Positions that drift under-water can be cleared by anyone via
///         {liquidate} for a {liquidationBonus}.
/// @dev    Two-token, oracle-priced model. The lender side uses Morpho-style
///         dual-tracked accounting (`totalSupplyAssets` stored directly,
///         interest moved by the realised drop in floored `totalBorrowed`) so
///         the solvency margin can never erode by rounding — it can only grow.
///         The borrower side is split: `userCollateral` holds the collateral
///         asset; `userBorrowShares` index the debt asset. Liquidation seizes
///         collateral priced through the oracle. The contract's value is in
///         six mathematical invariants, each one *tensioned* by interest
///         accrual, liquidation, or oracle movement, proven pre-deployment by
///         the Foundry fuzz harness (test/invariant/InvariantVault.t.sol) and
///         monitored live by the Guardian bot (guardian/src/evaluator.ts):
///
///         | ID     | Name                     | Property                                              |
///         |--------|--------------------------|-------------------------------------------------------|
///         | INV-01 | Protocol solvency        | cash + totalBorrowed >= totalSupplyAssets             |
///         | INV-02 | Supply-share integrity   | totalSupplyShares == sum(userSupplyShares[i])         |
///         | INV-03 | Debt-share integrity     | totalBorrowShares == sum(userBorrowShares[i])         |
///         | INV-04 | Lender-value floor       | totalSupplyAssets >= totalSupplyShares  (price >= 1)  |
///         | INV-05 | Interest-index floor     | borrowIndex >= 1e18                                   |
///         | INV-06 | No uncollateralised debt | userCollateral[u] == 0  =>  userDebt(u) == 0          |
contract Vault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice 1e18 fixed-point scaling unit.
    uint256 public constant WAD = 1e18;

    /// @notice Basis-point denominator (100_00 == 100%).
    uint256 public constant BPS = 100_00;

    /// @notice Seconds in a 365-day year — the interest-rate time base.
    uint256 public constant SECONDS_PER_YEAR = 365 days;

    /// @notice The ERC-20 lenders deposit and borrowers receive/repay.
    IERC20 public immutable debtAsset;

    /// @notice The ERC-20 borrowers post as collateral and liquidators seize.
    IERC20 public immutable collateralAsset;

    /// @notice Oracle giving the price of one collateral unit in debt-asset
    ///         units, scaled by {WAD}.
    IPriceOracle public immutable oracle;

    /// @notice Per-second borrow rate, scaled by {WAD}.
    uint256 public immutable borrowRatePerSecond;

    /// @notice Maximum borrow as a fraction of collateral value, in basis points.
    uint256 public immutable collateralRatio;

    /// @notice Extra collateral a liquidator seizes, in basis points.
    uint256 public immutable liquidationBonus;

    /// @notice Total debt-asset units owed to lenders. Stored directly and
    ///         grown by realised interest — never derived from the token
    ///         balance, which is what makes the vault immune to
    ///         donation/inflation attacks on the lender side.
    uint256 public totalSupplyAssets;

    /// @notice Total lender shares outstanding.
    uint256 public totalSupplyShares;

    /// @notice Lender shares held per address.
    mapping(address => uint256) public userSupplyShares;

    /// @notice Total collateral-asset units posted across every borrower.
    uint256 public totalCollateral;

    /// @notice Collateral-asset units posted per address.
    mapping(address => uint256) public userCollateral;

    /// @notice Total borrow shares outstanding.
    uint256 public totalBorrowShares;

    /// @notice Borrow shares owed per address.
    mapping(address => uint256) public userBorrowShares;

    /// @notice Debt-scaling index, scaled by {WAD}.
    uint256 public borrowIndex;

    /// @notice Unix timestamp of the most recent interest accrual.
    uint256 public lastAccrualTime;

    event Deposited(address indexed user, uint256 amount, uint256 sharesMinted);
    event Withdrawn(address indexed user, uint256 shares, uint256 amountOut);
    event CollateralDeposited(address indexed user, uint256 amount);
    event CollateralWithdrawn(address indexed user, uint256 amount);
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
    error InsufficientCollateral();
    error InsufficientLiquidity();
    error CollateralCapExceeded();
    error NoDebt();
    error PositionHealthy();
    error MustClearDebt();
    error InvalidLiquidationBonus();

    /// @param _debtAsset        ERC-20 lenders deposit and borrowers receive.
    /// @param _collateralAsset  ERC-20 borrowers post as collateral.
    /// @param _oracle           Price oracle for the collateral asset.
    /// @param _aprBps           Annual borrow rate in basis points (e.g. 1000 == 10% APR).
    /// @param _liquidationBonus Extra collateral seized by liquidators, in
    ///                          basis points. Must be in `(0, 50_00]`.
    constructor(
        address _debtAsset,
        address _collateralAsset,
        address _oracle,
        uint256 _aprBps,
        uint256 _liquidationBonus
    ) {
        if (_liquidationBonus == 0 || _liquidationBonus > 50_00) {
            revert InvalidLiquidationBonus();
        }
        debtAsset = IERC20(_debtAsset);
        collateralAsset = IERC20(_collateralAsset);
        oracle = IPriceOracle(_oracle);
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
    ///         lenders. Idempotent within a block.
    /// @dev    Borrowers are charged by raising {borrowIndex}; the *realised*
    ///         charge is then added to {totalSupplyAssets}. Both sides move by
    ///         the identical amount, so INV-01 (solvency) holds exactly.
    ///         Marked `virtual` so the mutation-testing suite under
    ///         `test/mutant/` can subclass with deliberately broken variants
    ///         and prove INV-12 (accrue idempotence) is load-bearing.
    function accrue() public virtual {
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

    /// @notice Deposit `amount` of the debt asset and receive lender shares.
    /// @param amount Quantity of the debt asset to deposit. Must be non-zero.
    function deposit(uint256 amount) external nonReentrant {
        accrue();
        if (amount == 0) revert ZeroAmount();

        // Floor division — the depositor's claim is worth no more than `amount`.
        uint256 shares =
            totalSupplyShares == 0 ? amount : (amount * totalSupplyShares) / totalSupplyAssets;
        if (shares == 0) revert ZeroAmount();

        debtAsset.safeTransferFrom(msg.sender, address(this), amount);

        totalSupplyAssets += amount;
        totalSupplyShares += shares;
        userSupplyShares[msg.sender] += shares;

        emit Deposited(msg.sender, amount, shares);
    }

    /// @notice Burn `shares` and redeem the underlying debt asset.
    /// @dev    Reverts if free liquidity is insufficient. Lender shares are
    ///         not collateral in this design, so the redemption is
    ///         independent of any borrowing the caller may have done.
    /// @param shares Quantity of lender shares to burn. Must be non-zero.
    function withdraw(uint256 shares) external nonReentrant {
        accrue();
        if (shares == 0) revert ZeroAmount();
        if (shares > userSupplyShares[msg.sender]) revert InsufficientShares();

        // Floor division — the vault pays out no more than the shares are worth.
        uint256 amountOut = (shares * totalSupplyAssets) / totalSupplyShares;
        if (debtAsset.balanceOf(address(this)) < amountOut) revert InsufficientLiquidity();

        totalSupplyAssets -= amountOut;
        totalSupplyShares -= shares;
        userSupplyShares[msg.sender] -= shares;

        debtAsset.safeTransfer(msg.sender, amountOut);

        emit Withdrawn(msg.sender, shares, amountOut);
    }

    // --------------------------------------------------------------------- //
    //                           Collateral actions                          //
    // --------------------------------------------------------------------- //

    /// @notice Post `amount` of the collateral asset to back future borrows.
    /// @param amount Quantity of the collateral asset to post. Must be non-zero.
    function depositCollateral(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();

        collateralAsset.safeTransferFrom(msg.sender, address(this), amount);

        userCollateral[msg.sender] += amount;
        totalCollateral += amount;

        emit CollateralDeposited(msg.sender, amount);
    }

    /// @notice Pull back `amount` of posted collateral.
    /// @dev    Reverts if the remaining collateral can no longer back the
    ///         caller's outstanding debt at the current oracle price.
    /// @param amount Quantity of the collateral asset to withdraw. Must be non-zero.
    function withdrawCollateral(uint256 amount) external nonReentrant {
        accrue();
        if (amount == 0) revert ZeroAmount();
        if (amount > userCollateral[msg.sender]) revert InsufficientCollateral();

        uint256 remainingCollateral = userCollateral[msg.sender] - amount;
        uint256 remainingValue = (remainingCollateral * oracle.price()) / WAD;
        uint256 maxBorrow = (remainingValue * collateralRatio) / BPS;
        if (userDebt(msg.sender) > maxBorrow) revert CollateralCapExceeded();

        userCollateral[msg.sender] = remainingCollateral;
        totalCollateral -= amount;

        collateralAsset.safeTransfer(msg.sender, amount);

        emit CollateralWithdrawn(msg.sender, amount);
    }

    // --------------------------------------------------------------------- //
    //                           Borrower actions                            //
    // --------------------------------------------------------------------- //

    /// @notice Borrow `amount` of the debt asset against posted collateral.
    /// @dev    Marked `virtual` so the INV-07 mutant subclass can swap the
    ///         ceil-rounded share computation for a floor-rounded one and
    ///         demonstrate the solvency-monotonicity invariant catches it.
    /// @param amount Quantity of the debt asset to borrow. Must be non-zero.
    function borrow(uint256 amount) external virtual nonReentrant {
        accrue();
        if (amount == 0) revert ZeroAmount();

        uint256 maxBorrow = (collateralValue(msg.sender) * collateralRatio) / BPS;
        if (userDebt(msg.sender) + amount > maxBorrow) revert CollateralCapExceeded();

        if (debtAsset.balanceOf(address(this)) < amount) revert InsufficientLiquidity();

        // Ceil division — the borrower's recorded debt is never less than the
        // asset they receive, so a borrow can only grow the solvency margin.
        uint256 borrowShares = (amount * WAD + borrowIndex - 1) / borrowIndex;

        totalBorrowShares += borrowShares;
        userBorrowShares[msg.sender] += borrowShares;

        debtAsset.safeTransfer(msg.sender, amount);

        emit Borrowed(msg.sender, amount, borrowShares);
    }

    /// @notice Repay up to the caller's full outstanding debt.
    /// @dev    Offering `amount >= debt` fully closes the position; the amount
    ///         actually collected is the realised drop in {totalBorrowed},
    ///         which equals the debt or, by at most one wei of index
    ///         rounding, one wei more. Offering less repays exactly `amount`.
    /// @param amount Quantity of the debt asset the caller offers to repay.
    function repay(uint256 amount) external nonReentrant {
        accrue();
        if (amount == 0) revert ZeroAmount();

        uint256 debt = userDebt(msg.sender);
        if (debt == 0) revert NoDebt();

        (uint256 pay, uint256 burned) = _burnDebt(msg.sender, amount, debt);

        debtAsset.safeTransferFrom(msg.sender, address(this), pay);

        emit Repaid(msg.sender, pay, burned);
    }

    /// @notice Clear an under-water borrower's position: repay part or all of
    ///         their debt and seize their collateral plus a {liquidationBonus}.
    /// @dev    Only callable when the borrower's debt exceeds their collateral
    ///         cap at the current oracle price. If the seizure would consume
    ///         all of the borrower's collateral, the liquidator must repay the
    ///         *entire* debt — this is what keeps INV-06 (no uncollateralised
    ///         debt) true.
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

        // Seizure value = repaid debt scaled up by the liquidation bonus,
        // converted into collateral units at the current oracle price.
        uint256 price = oracle.price();
        uint256 seizeValue = (plannedPay * (BPS + liquidationBonus)) / BPS;
        uint256 seizeCollateral = (seizeValue * WAD) / price;

        if (seizeCollateral >= userCollateral[borrower]) {
            // Seizing all collateral is only permitted alongside a full close,
            // otherwise the borrower would be left with debt and no collateral.
            if (!fullClose) revert MustClearDebt();
            seizeCollateral = userCollateral[borrower];
        }

        (uint256 pay,) = _burnDebt(borrower, amount, debt);

        userCollateral[borrower] -= seizeCollateral;
        totalCollateral -= seizeCollateral;

        debtAsset.safeTransferFrom(msg.sender, address(this), pay);
        collateralAsset.safeTransfer(msg.sender, seizeCollateral);

        emit Liquidated(msg.sender, borrower, pay, seizeCollateral);
    }

    // --------------------------------------------------------------------- //
    //                                 Views                                 //
    // --------------------------------------------------------------------- //

    /// @notice Total outstanding debt across all borrowers, in debt-asset units.
    function totalBorrowed() public view returns (uint256) {
        return (totalBorrowShares * borrowIndex) / WAD;
    }

    /// @notice Outstanding debt of a single borrower, in debt-asset units.
    /// @param user The borrower to value.
    function userDebt(address user) public view returns (uint256) {
        return (userBorrowShares[user] * borrowIndex) / WAD;
    }

    /// @notice The debt-asset value of a borrower's posted collateral, at the
    ///         current oracle price.
    /// @param user The account to value.
    function collateralValue(address user) public view returns (uint256) {
        return (userCollateral[user] * oracle.price()) / WAD;
    }

    /// @notice Lender share-to-asset price, scaled by {WAD}. 1e18 == 1:1.
    function sharePrice() external view returns (uint256) {
        if (totalSupplyShares == 0) return WAD;
        return (totalSupplyAssets * WAD) / totalSupplyShares;
    }

    /// @notice The vault's idle (un-borrowed) debt-asset balance.
    function cash() public view returns (uint256) {
        return debtAsset.balanceOf(address(this));
    }

    /// @notice Total debt-asset units backing lender shares: idle cash plus
    ///         debt owed by borrowers.
    function totalAssets() public view returns (uint256) {
        return cash() + totalBorrowed();
    }

    // --------------------------------------------------------------------- //
    //                               Internal                                //
    // --------------------------------------------------------------------- //

    /// @notice Burn borrow shares for a repayment and return the debt-asset
    ///         amount that must actually be collected from the payer.
    /// @dev    A full close (`offered >= debt`) burns the borrower's entire
    ///         share balance and charges the *exact* drop in floored
    ///         {totalBorrowed} — the debt, or by at most one wei of index
    ///         rounding one wei more. Charging the realised drop is what
    ///         keeps INV-01 (solvency) exact. A partial repayment
    ///         floor-divides the burned shares, so debt falls by no more
    ///         than the `offered` amount.
    /// @param borrower Account whose debt is being reduced.
    /// @param offered  Debt-asset amount the payer offers.
    /// @param debt     The borrower's current debt, as measured by {userDebt}.
    /// @return pay     Debt-asset amount to collect from the payer.
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
