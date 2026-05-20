# Spec 02 — Foundry Invariant Fuzz Harness

**Paste this into Claude and say:** "Build `foundry.toml` and `InvariantVault.t.sol` exactly as specified. The contracts from Spec 01 already exist."

---

## Context

The handler contracts (`DepositHandler`, `BorrowHandler`, `WarpHandler`) are already built from Spec 01. This spec produces:
- `foundry.toml` — project-level Foundry config with invariant tuning.
- `test/invariant/InvariantVault.t.sol` — the invariant test contract that wires up handlers and asserts all 8 invariants.

---

## File 1: `foundry.toml`

```toml
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
solc = "0.8.24"
optimizer = true
optimizer_runs = 200
remappings = [
  "@openzeppelin/=lib/openzeppelin-contracts/",
]
fs_permissions = [{ access = "read-write", path = "./"}]

[profile.default.fuzz]
runs = 256
max_test_rejects = 65536

[profile.default.invariant]
runs = 500           # per CI run (fast); override locally with --invariant-runs
depth = 100          # max calls per sequence
fail_on_revert = false
shrink_run_limit = 5000
call_override = false

[profile.ci]
# Used in GitHub Actions — more thorough
[profile.ci.invariant]
runs = 2000
depth = 150

[profile.deep]
# Run locally for maximum coverage before a release
[profile.deep.invariant]
runs = 10000
depth = 200

[rpc_endpoints]
base_sepolia = "${BASE_SEPOLIA_RPC}"
base_mainnet = "${BASE_MAINNET_RPC}"

[etherscan]
base_sepolia = { key = "${ETHERSCAN_API_KEY}", url = "https://api-sepolia.basescan.org/api", chain = 84532 }
```

---

## File 2: `test/invariant/InvariantVault.t.sol`

### Imports and setup

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vault} from "../../src/Vault.sol";
import {MockERC20} from "../../src/MockERC20.sol";
import {DepositHandler} from "./handlers/DepositHandler.sol";
import {BorrowHandler} from "./handlers/BorrowHandler.sol";
import {WarpHandler} from "./handlers/WarpHandler.sol";
```

### `setUp()` function

```solidity
function setUp() public {
    token = new MockERC20();
    vault = new Vault(address(token), address(0xDEAD)); // attacker = dead addr in tests
    
    depositHandler = new DepositHandler(vault, token);
    borrowHandler  = new BorrowHandler(vault, token);
    warpHandler    = new WarpHandler();
    
    // Tell Foundry which contracts to fuzz
    targetContract(address(depositHandler));
    targetContract(address(borrowHandler));
    targetContract(address(warpHandler));
    
    // Exclude the vault and token from direct fuzzing
    excludeContract(address(vault));
    excludeContract(address(token));
}
```

### Invariant functions

Write one `function invariant_*()` per invariant. Each must:
- Have `public view` visibility.
- Use `assertGe`, `assertLe`, `assertEq`, or `assertTrue` from forge's `Test` base.
- Include a descriptive failure message string.

**INV-01: Solvency**
```solidity
function invariant_solvency() public view {
    assertGe(
        vault.totalDeposited(),
        vault.totalBorrowed(),
        "INV-01: totalBorrowed exceeds totalDeposited — vault is insolvent"
    );
}
```

**INV-02: Liquidity buffer**
```solidity
function invariant_liquidityBuffer() public view {
    uint256 expectedLiquidity = vault.totalDeposited() - vault.totalBorrowed();
    assertGe(
        token.balanceOf(address(vault)),
        expectedLiquidity,
        "INV-02: vault token balance < free liquidity"
    );
}
```

**INV-03: Share price floor**
```solidity
function invariant_sharePriceFloor() public view {
    assertGe(
        vault.sharePrice(),
        1e18,
        "INV-03: sharePrice dropped below 1:1 peg"
    );
}
```

**INV-04: Share accounting**
```solidity
function invariant_shareAccounting() public view {
    uint256 sumShares = depositHandler.sumUserShares();
    assertEq(
        vault.totalShares(),
        sumShares,
        "INV-04: totalShares != sum of all userShares"
    );
}
```

> Note: `sumUserShares()` is a helper on `DepositHandler` that iterates `actors` and sums `vault.userShares(actor)`. Add it to `DepositHandler`.

**INV-05: Per-user collateral cap**
```solidity
function invariant_collateralCap() public view {
    address[] memory actors = depositHandler.getActors();
    for (uint256 i = 0; i < actors.length; i++) {
        address user = actors[i];
        uint256 collateralValue = vault.userShares(user) * vault.sharePrice() / 1e18;
        uint256 maxBorrow = collateralValue * vault.collateralRatio() / 100_00;
        assertLe(
            vault.userBorrowed(user),
            maxBorrow,
            "INV-05: user borrow exceeds collateral cap"
        );
    }
}
```

**INV-06: No share inflation**
```solidity
function invariant_noShareInflation() public view {
    if (vault.totalShares() == 0) return;
    uint256 impliedValue = vault.sharePrice() * vault.totalShares() / 1e18;
    assertLe(
        impliedValue,
        vault.totalDeposited(),
        "INV-06: implied share value exceeds total deposited"
    );
}
```

**INV-07: Non-negative net position**
```solidity
function invariant_nonNegativeNet() public view {
    // Solidity prevents underflow but we assert the invariant explicitly
    assertGe(
        vault.totalDeposited(),
        vault.totalBorrowed(),
        "INV-07: net position negative"
    );
}
```

**INV-08: Zero-state consistency**
```solidity
function invariant_zeroStateConsistency() public view {
    bool sharesZero = vault.totalShares() == 0;
    bool depositedZero = vault.totalDeposited() == 0;
    assertEq(
        sharesZero,
        depositedZero,
        "INV-08: totalShares and totalDeposited zero-state inconsistency"
    );
}
```

---

## How to run locally

```bash
# Fast check (500 runs, depth 100)
forge test --match-contract InvariantVault -vvv

# Deep check (10,000 runs — run before any PR)
FOUNDRY_PROFILE=deep forge test --match-contract InvariantVault -vvv

# With Base Sepolia fork (requires ALCHEMY_KEY in .env)
source .env
forge test --match-contract InvariantVault --fork-url $BASE_SEPOLIA_RPC -vvv
```

---

## Deliberately breaking the vault (for the screenshot)

Before finalising the vault code, temporarily add this line to `borrow()`:

```solidity
// BUG: intentionally missing solvency check — delete after screenshot
// totalBorrowed += amount;   ← original
totalBorrowed = totalDeposited + 1;  // ← forced violation
```

Run `FOUNDRY_PROFILE=deep forge test --match-contract InvariantVault -vvv`. Forge will output a counterexample like:

```
[FAIL] invariant_solvency()
    Counterexample:
      calldata=deposit(0, 1000000000000000000)
               borrow(0, 1000000000000000001)
```

Screenshot this terminal output. Save as `docs/counterexample.png`. Then restore the correct code. This screenshot is the most important artefact in the README.

---

## Acceptance criteria

- All 8 `invariant_*` functions pass with `FOUNDRY_PROFILE=ci`.
- `forge coverage --match-contract Vault` shows ≥ 85% line coverage.
- `forge snapshot` runs successfully and produces `.gas-snapshot`.
- The deliberately broken test produces a meaningful counterexample (not just a generic revert).
