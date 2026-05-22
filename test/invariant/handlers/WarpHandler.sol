// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../../../src/Vault.sol";

/// @title WarpHandler — advances block time and triggers interest accrual
/// @notice Gives the fuzzer the ability to explore time-dependent state. Each
///         call jumps the clock forward and then accrues interest, so the
///         borrow index and lender claims actually move — without this handler
///         the interest-rate logic would never be exercised. Base blocks are
///         ~2 seconds apart, so block number advances by `seconds / 2`.
contract WarpHandler is Test {
    Vault public vault;

    /// @param _vault The vault under test.
    constructor(Vault _vault) {
        vault = _vault;
    }

    /// @notice Fuzz entrypoint: advance time by a bounded interval, then accrue.
    function warp(uint256 seconds_) external {
        seconds_ = bound(seconds_, 1, 30 days);
        vm.warp(block.timestamp + seconds_);
        vm.roll(block.number + seconds_ / 2);
        vault.accrue();
    }
}
