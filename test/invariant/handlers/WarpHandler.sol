// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../../../src/Vault.sol";
import {MockOracle} from "../../../src/MockOracle.sol";

/// @title  WarpHandler — advances block time and triggers interest accrual.
/// @notice Lets the fuzzer explore time-dependent state. Each call jumps the
///         clock forward then accrues, so {Vault.borrowIndex} and lender
///         claims actually move — without this handler the interest-rate
///         logic would never be exercised. Base blocks are ~2 seconds apart,
///         so block number advances by `seconds / 2`. Always succeeds, so
///         it's safe under `fail_on_revert = true`.
/// @dev    After each warp the oracle's `lastUpdatedAt` is reset to
///         `block.timestamp`. Without that, the warp would push the oracle
///         past {Vault.MAX_STALENESS} on virtually every call and every
///         price-dependent handler (Borrow, Collateral.withdraw, Liquidate)
///         would short-circuit, gutting fuzz coverage. INV-11's
///         load-bearing proof lives in `test/mutant/MutantINV11.t.sol`; the
///         fuzz keeps the gate green by construction.
contract WarpHandler is Test {
    Vault internal immutable VAULT;
    MockOracle internal immutable ORACLE;
    uint256 public warpCalls;

    constructor(Vault _vault, MockOracle _oracle) {
        VAULT = _vault;
        ORACLE = _oracle;
    }

    /// @notice Fuzz entrypoint: advance time by a bounded interval, then accrue.
    function warp(uint256 seconds_) external {
        seconds_ = bound(seconds_, 1, 30 days);
        vm.warp(block.timestamp + seconds_);
        vm.roll(block.number + seconds_ / 2);
        VAULT.accrue();
        ORACLE.setLastUpdatedAt(block.timestamp);
        warpCalls++;
    }
}
