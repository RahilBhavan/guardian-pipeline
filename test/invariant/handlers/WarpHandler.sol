// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../../../src/Vault.sol";

/// @title  WarpHandler — advances block time and triggers interest accrual.
/// @notice Lets the fuzzer explore time-dependent state. Each call jumps the
///         clock forward then accrues, so {Vault.borrowIndex} and lender
///         claims actually move — without this handler the interest-rate
///         logic would never be exercised. Base blocks are ~2 seconds apart,
///         so block number advances by `seconds / 2`. Always succeeds, so
///         it's safe under `fail_on_revert = true`.
contract WarpHandler is Test {
    Vault internal immutable VAULT;
    uint256 public warpCalls;

    constructor(Vault _vault) {
        VAULT = _vault;
    }

    /// @notice Fuzz entrypoint: advance time by a bounded interval, then accrue.
    function warp(uint256 seconds_) external {
        seconds_ = bound(seconds_, 1, 30 days);
        vm.warp(block.timestamp + seconds_);
        vm.roll(block.number + seconds_ / 2);
        VAULT.accrue();
        warpCalls++;
    }
}
