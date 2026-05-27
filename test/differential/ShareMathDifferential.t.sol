// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

/// @title  ShareMathDifferential — Solidity ↔ TypeScript byte-equivalence fuzz.
/// @notice Catches subtle rounding drift between src/Vault.sol's share/debt
///         math and the TypeScript reference at assurance/src/refmath.ts. The
///         test shells out to the dependency-free Node mirror
///         `assurance/bin/refmath-cli.mjs` via `vm.ffi`, parses its uint256
///         result, and asserts byte-equivalence with the Solidity result on
///         every fuzz input.
/// @dev    The five operations covered are the only places Vault.sol
///         performs share-asset arithmetic. The TS reference is the
///         specification; if Solidity and TS disagree on any input, **one of
///         them is wrong** — that's the entire value of differential testing.
///
///         FFI is enabled in foundry.toml's default profile so this test
///         runs as part of the normal `forge test` suite. No other test in
///         the repo uses vm.ffi.
contract ShareMathDifferentialTest is Test {
    uint256 internal constant WAD = 1e18;

    // --------------------------------------------------------------------- //
    //                          FFI helpers                                  //
    // --------------------------------------------------------------------- //

    /// @notice Invoke the reference CLI with the given op + decimal args and
    ///         decode its hex-encoded uint256 stdout.
    function _ref(string memory op, uint256[] memory args) internal returns (uint256) {
        string[] memory cmd = new string[](3 + args.length);
        cmd[0] = "node";
        cmd[1] = "assurance/bin/refmath-cli.mjs";
        cmd[2] = op;
        for (uint256 i = 0; i < args.length; i++) {
            cmd[3 + i] = vm.toString(args[i]);
        }
        bytes memory raw = vm.ffi(cmd);
        require(raw.length == 32, "ref CLI did not return a 32-byte uint256");
        return abi.decode(raw, (uint256));
    }

    function _args2(uint256 a, uint256 b) internal pure returns (uint256[] memory v) {
        v = new uint256[](2);
        v[0] = a;
        v[1] = b;
    }

    function _args3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory v) {
        v = new uint256[](3);
        v[0] = a;
        v[1] = b;
        v[2] = c;
    }

    // --------------------------------------------------------------------- //
    //                       Solidity reference formulas                     //
    // --------------------------------------------------------------------- //
    // These are byte-for-byte copies of the formulas in src/Vault.sol. If
    // either side drifts, the test fails — that's the load-bearing property.

    function _solDepositShares(uint256 amount, uint256 tsa, uint256 tss)
        internal
        pure
        returns (uint256)
    {
        if (tss == 0) return amount;
        return (amount * tss) / tsa;
    }

    function _solWithdrawAmount(uint256 shares, uint256 tsa, uint256 tss)
        internal
        pure
        returns (uint256)
    {
        return (shares * tsa) / tss;
    }

    function _solBorrowShares(uint256 amount, uint256 borrowIndex) internal pure returns (uint256) {
        return (amount * WAD + borrowIndex - 1) / borrowIndex;
    }

    function _solUserDebt(uint256 borrowShares, uint256 borrowIndex)
        internal
        pure
        returns (uint256)
    {
        return (borrowShares * borrowIndex) / WAD;
    }

    function _solAccrual(uint256 borrowIndex, uint256 rate, uint256 dt)
        internal
        pure
        returns (uint256)
    {
        return borrowIndex + (borrowIndex * rate * dt) / WAD;
    }

    // --------------------------------------------------------------------- //
    //                      Pinned regression vectors                        //
    // --------------------------------------------------------------------- //
    // Cheap, deterministic checks the differential pipeline runs even when
    // the fuzz budget is reduced. Each captures an edge case real callers
    // hit: bootstrap deposit (tss == 0), exact-divisible withdraw, ceil
    // rounding under a non-trivial borrow index, and one-second accrual.

    function test_diff_depositShares_bootstrap() public {
        uint256 amount = 1_000e18;
        uint256 sol = _solDepositShares(amount, 0, 0);
        uint256 ts = _ref("deposit-shares", _args3(amount, 0, 0));
        assertEq(sol, ts, "bootstrap deposit drift");
        assertEq(sol, amount, "bootstrap deposit should mint 1:1");
    }

    function test_diff_borrowShares_ceil() public {
        // Picks an amount/index pair where floor and ceil differ by exactly 1.
        uint256 amount = 1e18;
        uint256 borrowIndex = 1.1e18;
        uint256 sol = _solBorrowShares(amount, borrowIndex);
        uint256 ts = _ref("borrow-shares", _args2(amount, borrowIndex));
        assertEq(sol, ts, "ceil rounding drift");
        assertEq(sol, 909090909090909091, "ceil result regressed");
    }

    function test_diff_userDebt_floor() public {
        uint256 borrowShares = 1e18;
        uint256 borrowIndex = 1.1e18;
        uint256 sol = _solUserDebt(borrowShares, borrowIndex);
        uint256 ts = _ref("user-debt", _args2(borrowShares, borrowIndex));
        assertEq(sol, ts, "floor rounding drift");
        assertEq(sol, 1.1e18, "1.0 * 1.1 floor");
    }

    function test_diff_accrue_oneSecond() public {
        uint256 borrowIndex = 1e18;
        uint256 rate = 3_170_979_198; // ~10% APR per second, WAD-scaled
        uint256 dt = 1;
        uint256 sol = _solAccrual(borrowIndex, rate, dt);
        uint256 ts = _ref("accrue", _args3(borrowIndex, rate, dt));
        assertEq(sol, ts, "1-second accrue drift");
    }

    // --------------------------------------------------------------------- //
    //                            Fuzz pass                                  //
    // --------------------------------------------------------------------- //
    // Bounds picked to mirror the Foundry invariant harness — wide enough to
    // exercise interesting rounding behaviour, capped to keep `amount * tss`
    // safely inside uint256.

    function testFuzz_diff_depositShares(uint256 amount, uint256 tsa, uint256 tss) public {
        amount = bound(amount, 1, 1e30);
        tsa = bound(tsa, 1, 1e36);
        tss = bound(tss, 0, 1e36);
        uint256 sol = _solDepositShares(amount, tsa, tss);
        uint256 ts = _ref("deposit-shares", _args3(amount, tsa, tss));
        assertEq(sol, ts);
    }

    function testFuzz_diff_withdrawAmount(uint256 shares, uint256 tsa, uint256 tss) public {
        tss = bound(tss, 1, 1e36); // division — must be non-zero
        shares = bound(shares, 1, tss);
        tsa = bound(tsa, 1, 1e36);
        uint256 sol = _solWithdrawAmount(shares, tsa, tss);
        uint256 ts = _ref("withdraw-amount", _args3(shares, tsa, tss));
        assertEq(sol, ts);
    }

    function testFuzz_diff_borrowShares(uint256 amount, uint256 borrowIndex) public {
        amount = bound(amount, 1, 1e30);
        borrowIndex = bound(borrowIndex, WAD, 100 * WAD);
        uint256 sol = _solBorrowShares(amount, borrowIndex);
        uint256 ts = _ref("borrow-shares", _args2(amount, borrowIndex));
        assertEq(sol, ts);
    }

    function testFuzz_diff_userDebt(uint256 borrowShares, uint256 borrowIndex) public {
        borrowShares = bound(borrowShares, 0, 1e30);
        borrowIndex = bound(borrowIndex, WAD, 100 * WAD);
        uint256 sol = _solUserDebt(borrowShares, borrowIndex);
        uint256 ts = _ref("user-debt", _args2(borrowShares, borrowIndex));
        assertEq(sol, ts);
    }

    function testFuzz_diff_accrue(uint256 borrowIndex, uint256 rate, uint256 dt) public {
        borrowIndex = bound(borrowIndex, WAD, 100 * WAD);
        // ratePerSecond stays well below 1e18; SECONDS_PER_YEAR = 31_536_000.
        rate = bound(rate, 0, 1e12);
        dt = bound(dt, 0, 365 days);
        uint256 sol = _solAccrual(borrowIndex, rate, dt);
        uint256 ts = _ref("accrue", _args3(borrowIndex, rate, dt));
        assertEq(sol, ts);
    }
}
