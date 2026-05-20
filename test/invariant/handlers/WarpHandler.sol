// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

/// @title WarpHandler — advances block time and number during invariant runs
/// @notice Gives the fuzzer the ability to explore time-dependent state. Base
///         blocks are ~2 seconds apart, so block number advances by `seconds / 2`.
contract WarpHandler is Test {
    /// @notice Fuzz entrypoint: advance time by a bounded number of seconds.
    function warp(uint256 seconds_) external {
        seconds_ = bound(seconds_, 1, 365 days);
        vm.warp(block.timestamp + seconds_);
        vm.roll(block.number + seconds_ / 2);
    }
}
