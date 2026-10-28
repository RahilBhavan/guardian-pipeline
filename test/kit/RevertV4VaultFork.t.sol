// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LendingInvariants} from "./LendingInvariants.sol";
import {RevertV4VaultAdapter, IV4Vault} from "./adapters/RevertV4VaultAdapter.sol";

interface IV4VaultLoanInfo {
    function loanInfo(uint256 tokenId) external view returns (uint256, uint256, uint256, uint256, uint256);
}

contract RevertDebtMutant is RevertV4VaultAdapter {
    constructor(IV4Vault v, address c0, address c1) RevertV4VaultAdapter(v, c0, c1) {}

    function debtOf(address) external view override returns (uint256) {
        (uint256 debt,,,,,) = vault.vaultInfo();
        return debt + 1;
    }
}

/// @notice Deployed Revert Lend USDC V4Vault on Base. The actor set is complete: every
/// vault log from deployment (block 51,223,937) to block 53,203,450 shows two lenders
/// (share mints sum to totalSupply), one borrower, no Liquidate event and no lend-rate drop.
contract RevertV4VaultForkTest is Test {
    IV4Vault constant VAULT = IV4Vault(0xaf98803a1f43afC14335360e089F6B12947924ED);
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    uint256 constant BLOCK = 52_800_000;
    address constant BORROWER = 0x8cadb20A4811f363Dadb863A190708bEd26245F8;
    address constant LENDER = 0xCD1549F523AD3606cC99950c85711C3DBe62266B;
    uint256 constant LOAN = 3_058_134;
    RevertV4VaultAdapter adapter;

    function setUp() public {
        string memory rpc = vm.envOr("BASE_MAINNET_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc, BLOCK);
        assertEq(block.chainid, 8453);
        assertGt(address(VAULT).code.length, 0);
        assertEq(VAULT.asset(), USDC);
        // Native ETH / USDC: the pair of every position the borrower holds in the vault.
        adapter = new RevertV4VaultAdapter(VAULT, address(0), USDC);
    }

    function _actors() internal pure returns (address[] memory actors) {
        actors = new address[](2);
        actors[0] = BORROWER;
        actors[1] = LENDER;
    }

    function test_realVaultPredicatesAndMutant() public {
        address[] memory actors = _actors();
        assertEq(VAULT.loanCount(BORROWER), 4);
        assertTrue(LendingInvariants.solvent(adapter));
        assertGt(LendingInvariants.solvencyMargin(adapter), 0);
        assertTrue(LendingInvariants.supplySharesConserved(adapter, actors));
        assertTrue(LendingInvariants.debtSharesConserved(adapter, actors));
        assertTrue(LendingInvariants.debtRoundingFavoursProtocol(adapter, actors));
        assertTrue(LendingInvariants.noDebtWithoutCollateral(adapter, BORROWER));
        assertTrue(LendingInvariants.noDebtWithoutCollateral(adapter, LENDER));
        assertTrue(LendingInvariants.sharePriceAtLeast(adapter, 1e18));
        assertFalse(LendingInvariants.liquidatable(adapter, BORROWER));

        // Cross-check against the vault's own per-loan view; the other three NFTs hold no liquidity.
        (uint256 debt, uint256 fullValue,, uint256 liquidationCost,) = IV4VaultLoanInfo(address(VAULT)).loanInfo(LOAN);
        assertEq(adapter.debtSharesOf(BORROWER), VAULT.loans(LOAN));
        assertEq(adapter.collateralValueOf(BORROWER), fullValue);
        assertGt(fullValue, 0);
        assertLe(adapter.debtOf(BORROWER), debt);
        assertGe(adapter.debtOf(BORROWER) + 1, debt);
        assertEq(liquidationCost, 0);
        assertEq(adapter.liquidationThresholdBps(), 7749); // min(ETH 77.5%, USDC 85%), floored
        assertEq(adapter.liquidationBonusBps(), 1000);

        assertFalse(
            LendingInvariants.debtRoundingFavoursProtocol(new RevertDebtMutant(VAULT, address(0), USDC), actors),
            "mutant debt must trip kit predicate"
        );
        vm.expectRevert("index lend-rate write-offs for losses");
        adapter.realizedLosses();
    }

    function test_depositAndAccrualPreserveKit() public {
        address newLender = makeAddr("revert-lender");
        deal(USDC, newLender, 1_000e6);
        vm.startPrank(newLender);
        IERC20(USDC).approve(address(VAULT), type(uint256).max);
        VAULT.deposit(1_000e6, newLender);
        vm.stopPrank();
        address[] memory actors = new address[](3);
        actors[0] = BORROWER;
        actors[1] = LENDER;
        actors[2] = newLender;
        assertTrue(LendingInvariants.supplySharesConserved(adapter, actors));
        assertTrue(LendingInvariants.solvent(adapter));

        uint256 shares = adapter.debtSharesOf(BORROWER);
        uint256 debt = adapter.debtOf(BORROWER);
        uint256 margin = LendingInvariants.solvencyMargin(adapter);
        // Losses are 0 on both sides: the full log scan found no write-off through this block.
        LendingInvariants.SharePriceObservation memory prior =
            LendingInvariants.SharePriceObservation({price: adapter.sharePrice(), losses: 0, live: true});
        vm.warp(block.timestamp + 1 days);
        assertTrue(
            LendingInvariants.debtMonotoneUnderAccrual(
                shares, debt, adapter.debtSharesOf(BORROWER), adapter.debtOf(BORROWER)
            )
        );
        assertGt(adapter.debtOf(BORROWER), debt);
        assertTrue(
            LendingInvariants.sharePriceMonotone(
                prior, LendingInvariants.SharePriceObservation({price: adapter.sharePrice(), losses: 0, live: true})
            )
        );
        assertGt(adapter.sharePrice(), prior.price);
        assertTrue(LendingInvariants.solvent(adapter));
        assertTrue(LendingInvariants.solvencyMarginNonDecreasing(margin, LendingInvariants.solvencyMargin(adapter)));
    }

    function testFuzz_repayPreservesKit(uint256 amount) public {
        // Partial repay must leave at least minLoanSize (0.1 USDC) of the ~6.31 USDC debt.
        amount = bound(amount, 2, 6e6);
        deal(USDC, BORROWER, amount);
        vm.startPrank(BORROWER);
        IERC20(USDC).approve(address(VAULT), type(uint256).max);
        VAULT.repay(LOAN, amount, false);
        vm.stopPrank();
        address[] memory actors = _actors();
        assertTrue(LendingInvariants.solvent(adapter));
        assertTrue(LendingInvariants.debtSharesConserved(adapter, actors));
        assertTrue(LendingInvariants.debtRoundingFavoursProtocol(adapter, actors));
        assertTrue(LendingInvariants.noDebtWithoutCollateral(adapter, BORROWER));
    }
}
