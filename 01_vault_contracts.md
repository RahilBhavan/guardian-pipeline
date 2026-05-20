# Spec 01 — Protocol Contracts + Invariant Handlers

**Paste this into Claude and say:** "Build all contracts in this spec exactly. Output each file with its full path as a header."

---

## Context

We are building a simple lending vault in Solidity. The protocol complexity is intentionally minimal — three user-facing functions. All the interesting logic lives in the invariant definitions and the Foundry handlers. Do not add features not listed here.

**Chain:** Base L2 (Solidity compiles identically; no chain-specific opcodes needed)
**Solidity:** `^0.8.24`
**Dependencies:** OpenZeppelin Contracts v5 (install via `forge install OpenZeppelin/openzeppelin-contracts`)

---

## File 1: `src/Vault.sol`

### What it does

A simple over-collateralised lending vault. Users deposit ERC-20 tokens, receive shares, and can borrow up to 80% of their deposited value. All amounts are in a single ERC-20 token (e.g. USDC on Base, but use a mock in tests).

### State variables (exact names — the Guardian bot reads these by name)

```
totalDeposited   uint256   // sum of all deposits, never decremented below repaid amounts
totalBorrowed    uint256   // sum of all outstanding borrows
totalShares      uint256   // ERC-4626-style share supply
sharePrice       uint256   // 1e18 = 1:1, grows with interest accrual
collateralRatio  uint256   // 80_00 = 80% (basis points, i.e. divide by 100_00)
```

Also maintain:
```
mapping(address => uint256) public userShares;
mapping(address => uint256) public userBorrowed;
```

### Functions to implement

| Function | Signature | Behaviour |
|---|---|---|
| `deposit` | `deposit(uint256 amount)` | Transfer token from caller → vault. Mint shares proportional to `sharePrice`. Update `totalDeposited`, `totalShares`, `userShares[msg.sender]`. |
| `withdraw` | `withdraw(uint256 shares)` | Burn shares, return tokens. Revert if `totalDeposited - totalBorrowed < redemption amount`. Update state. |
| `borrow` | `borrow(uint256 amount)` | Transfer tokens to caller. Revert if `userBorrowed[msg.sender] + amount > (userShares[msg.sender] * sharePrice / 1e18) * collateralRatio / 100_00`. Update `totalBorrowed`, `userBorrowed[msg.sender]`. |
| `repay` | `repay(uint256 amount)` | Transfer tokens from caller → vault. Decrement `userBorrowed[msg.sender]` and `totalBorrowed`. |
| `attack` | `attack()` | **Intentional exploit function for demo only.** Sets `totalBorrowed = totalDeposited + 1` directly. Protected by `onlyAttacker` modifier (set in constructor). Used in the Loom demo to trigger Guardian. |

### Events

```solidity
event Deposited(address indexed user, uint256 amount, uint256 sharesMinted);
event Withdrawn(address indexed user, uint256 shares, uint256 amountOut);
event Borrowed(address indexed user, uint256 amount);
event Repaid(address indexed user, uint256 amount);
event InvariantViolated(string invariantName, uint256 actualValue, uint256 expectedBound);
```

### Constructor

```solidity
constructor(address _token, address _attacker)
```

Takes the ERC-20 token address and an attacker address (for the `attack()` demo function).

---

## File 2: `src/MockERC20.sol`

A minimal ERC-20 token for tests. Inherits `ERC20` from OpenZeppelin. Constructor mints 1_000_000e18 to `msg.sender`. Add a `mint(address to, uint256 amount)` function with no access control (test only).

---

## File 3: `test/invariant/handlers/DepositHandler.sol`

### Purpose

Foundry handler contract. Gives the fuzzer a valid action space for deposits and withdrawals. Foundry will call these functions with random inputs. The handler bounds the inputs to reasonable ranges to avoid trivial reverts.

### State

```solidity
Vault public vault;
MockERC20 public token;
address[] public actors;          // array of test user addresses
address internal currentActor;
```

### Functions

**`deposit(uint256 actorSeed, uint256 amount)`**
- Bound `actorSeed` to `actors` array length to pick a caller.
- Bound `amount` to `[1, 100_000e18]`.
- `prank` as the actor. Approve vault. Call `vault.deposit(amount)`.
- Handle reverts gracefully with a try/catch — do not let handler revert.

**`withdraw(uint256 actorSeed, uint256 sharesSeed)`**
- Pick actor. Bound shares to `[0, vault.userShares(actor)]`.
- `prank` as actor. Call `vault.withdraw(shares)` in try/catch.

### Actors

In the constructor, create 5 actors using `makeAddr("user1")` through `makeAddr("user5")`. Pre-fund each with 500_000e18 of token. Approve the vault for `type(uint256).max`.

---

## File 4: `test/invariant/handlers/BorrowHandler.sol`

### Functions

**`borrow(uint256 actorSeed, uint256 amount)`**
- Pick actor. Bound amount to `[1, 50_000e18]`.
- `prank` as actor. Call `vault.borrow(amount)` in try/catch.

**`repay(uint256 actorSeed, uint256 amount)`**
- Pick actor. Bound amount to `[0, vault.userBorrowed(actor)]`.
- If amount == 0, skip.
- `prank` as actor. Approve token. Call `vault.repay(amount)` in try/catch.

---

## File 5: `test/invariant/handlers/WarpHandler.sol`

### Purpose

Advances block time and number to simulate interest accrual and time-dependent state. Foundry's fuzzer needs this to explore time-sensitive invariants.

### Functions

**`warp(uint256 seconds_)`**
- Bound seconds to `[1, 365 days]`.
- Call `vm.warp(block.timestamp + seconds_)`.
- Call `vm.roll(block.number + seconds_ / 12)` (approximate Base block time = 2s; use 2 for Base).

---

## File 6: `script/DeployVault.s.sol`

A Foundry script that:
1. Reads `ATTACKER_ADDRESS` from env (`vm.envAddress`).
2. Deploys `MockERC20` (for testnet) or reads token address from env (for mainnet).
3. Deploys `Vault(token, attacker)`.
4. Logs the deployed address with `console.log("Vault deployed at:", address(vault))`.
5. Uses `vm.startBroadcast()` / `vm.stopBroadcast()`.

---

## Invariants — mathematical definitions

Document these as NatSpec comments on the Vault contract AND as a table in the spec. The Guardian bot TypeScript evaluator must implement each one identically.

| ID | Name | Formula | Severity |
|---|---|---|---|
| INV-01 | Solvency | `totalBorrowed ≤ totalDeposited` | Critical |
| INV-02 | Liquidity buffer | `token.balanceOf(vault) ≥ totalDeposited - totalBorrowed` | Critical |
| INV-03 | Share price floor | `sharePrice ≥ 1e18` | High |
| INV-04 | Share accounting | `totalShares == sum(userShares[i] for all i)` | High |
| INV-05 | Collateral cap | `for all users: userBorrowed[u] ≤ userShares[u] * sharePrice / 1e18 * collateralRatio / 100_00` | High |
| INV-06 | No share inflation | `totalShares > 0 → sharePrice * totalShares / 1e18 ≤ totalDeposited` | Medium |
| INV-07 | Non-negative borrow | `totalBorrowed ≤ totalDeposited` (enforced; no underflow possible) | Medium |
| INV-08 | Zero-state consistency | `totalShares == 0 ↔ totalDeposited == 0` | Low |

---

## Acceptance criteria

- `forge build` exits 0 with no warnings.
- `forge test --match-contract InvariantVault` passes (before adding the fuzz harness — unit test the handlers at least compile).
- `Vault.sol` has NatSpec `@notice` on every public function.
- No use of `assembly` blocks.
- No use of `tx.origin`.
