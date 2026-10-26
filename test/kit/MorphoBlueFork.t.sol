// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "../../src/MockERC20.sol";
import {ILendingVaultAdapter} from "./ILendingVaultAdapter.sol";
import {LendingInvariants} from "./LendingInvariants.sol";
import {MorphoBlueAdapter, IMorphoBlue, MorphoMarketParams} from "./adapters/MorphoBlueAdapter.sol";

contract MorphoOracle {
    function price() external pure returns (uint256) {
        return 2e36;
    }
}

contract MorphoDebtMutant is MorphoBlueAdapter {
    constructor(IMorphoBlue m, bytes32 id) MorphoBlueAdapter(m, id) {}

    function debtOf(address) external view override returns (uint256) {
        return morpho.market(marketId).totalBorrowAssets + 1;
    }
}

/// @notice Canonical Base Morpho code, isolated market: complete actor set, no invented holders.
contract MorphoBlueForkTest is Test {
    IMorphoBlue constant MORPHO = IMorphoBlue(0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb);
    uint256 constant BLOCK = 53_120_000;
    MorphoBlueAdapter adapter;
    MorphoMarketParams params;
    address lender = makeAddr("morpho-lender");
    address borrower = makeAddr("morpho-borrower");
    MockERC20 loan;
    MockERC20 collateral;

    function setUp() public {
        string memory rpc = vm.envOr("BASE_MAINNET_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc, BLOCK);
        assertEq(block.chainid, 8453);
        assertGt(address(MORPHO).code.length, 0);
        loan = new MockERC20();
        collateral = new MockERC20();
        params = MorphoMarketParams(
            address(loan),
            address(collateral),
            address(new MorphoOracle()),
            0x46415998764C29aB2a25CbeA6254146D50D22687,
            0.86e18
        );
        MORPHO.createMarket(params);
        adapter = new MorphoBlueAdapter(MORPHO, keccak256(abi.encode(params)));
        loan.mint(lender, 1_000e18);
        vm.startPrank(lender);
        loan.approve(address(MORPHO), type(uint256).max);
        MORPHO.supply(params, 1_000e18, 0, lender, "");
        vm.stopPrank();
        collateral.mint(borrower, 1_000e18);
        vm.startPrank(borrower);
        collateral.approve(address(MORPHO), type(uint256).max);
        MORPHO.supplyCollateral(params, 1_000e18, borrower, "");
        MORPHO.borrow(params, 500e18, 0, borrower, borrower);
        vm.stopPrank();
        MORPHO.accrueInterest(params);
    }

    function test_realMorphoPredicatesAndMutant() public {
        address[] memory actors = new address[](2);
        actors[0] = lender;
        actors[1] = borrower;
        assertTrue(LendingInvariants.solvent(adapter));
        assertTrue(LendingInvariants.supplySharesConserved(adapter, actors));
        assertTrue(LendingInvariants.debtSharesConserved(adapter, actors));
        assertTrue(LendingInvariants.debtRoundingFavoursProtocol(adapter, actors));
        assertTrue(LendingInvariants.noDebtWithoutCollateral(adapter, borrower));
        assertTrue(LendingInvariants.sharePriceAtLeast(adapter, 1e12));
        assertFalse(LendingInvariants.liquidatable(adapter, borrower));
        assertEq(adapter.collateralValueOf(borrower), 2_000e18);
        assertEq(adapter.liquidationThresholdBps(), 8600);
        assertEq(adapter.liquidationBonusBps(), 439);
        assertFalse(
            LendingInvariants.debtRoundingFavoursProtocol(new MorphoDebtMutant(MORPHO, adapter.marketId()), actors),
            "mutant debt must trip kit predicate"
        );
        vm.expectRevert("use indexed Liquidate.badDebtAssets for losses");
        adapter.realizedLosses();
    }

    function test_interestAccruesThroughRealIRM() public {
        uint256 shares = adapter.debtSharesOf(borrower);
        uint256 debt = adapter.debtOf(borrower);
        uint256 price = adapter.sharePrice();
        vm.warp(block.timestamp + 1 days);
        MORPHO.accrueInterest(params);
        assertTrue(
            LendingInvariants.debtMonotoneUnderAccrual(
                shares, debt, adapter.debtSharesOf(borrower), adapter.debtOf(borrower)
            )
        );
        assertGt(adapter.debtOf(borrower), debt);
        assertGe(adapter.sharePrice(), price);
        assertTrue(LendingInvariants.solvent(adapter));
    }

    function test_existingCbBTCMarket() public {
        bytes32 id = 0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836;
        MorphoBlueAdapter existing = new MorphoBlueAdapter(MORPHO, id);
        MORPHO.accrueInterest(MORPHO.idToMarketParams(id));
        assertGt(existing.totalSupplyAssets(), 0);
        assertGt(existing.totalDebt(), 0);
        assertTrue(LendingInvariants.solvent(existing));
        assertGt(existing.collateralPrice(), 0);
        // No conservation assertions: this test does not index every holder.
    }

    function testFuzz_repayPreservesKit(uint96 amount) public {
        amount = uint96(bound(amount, 1, 500e18));
        vm.startPrank(borrower);
        loan.approve(address(MORPHO), type(uint256).max);
        MORPHO.repay(params, amount, 0, borrower, "");
        vm.stopPrank();
        address[] memory actors = new address[](2);
        actors[0] = lender;
        actors[1] = borrower;
        assertTrue(LendingInvariants.solvent(adapter));
        assertTrue(LendingInvariants.debtSharesConserved(adapter, actors));
        assertTrue(LendingInvariants.debtRoundingFavoursProtocol(adapter, actors));
    }
}
