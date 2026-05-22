# Contract reference

Complete API reference for the Solidity layer: [`Vault.sol`](#vault), the
contract under audit, and [`MockERC20.sol`](#mockerc20), its test asset. Every
function, event, error, and storage slot is documented against the source in
[`src/`](../src).

> **Audience.** Read this if you are auditing the contract, writing a new
> handler or exploit replay, or wiring the Guardian bot to a fresh deployment.
> For *why* the invariants are shaped the way they are, see
> [invariants.md](invariants.md).

---

## Vault

`src/Vault.sol` · Solidity `^0.8.24` · inherits OpenZeppelin
[`ReentrancyGuard`](https://docs.openzeppelin.com/contracts/5.x/api/utils#ReentrancyGuard)
· uses [`SafeERC20`](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20#SafeERC20).

A minimal over-collateralised lending vault. A user deposits a single ERC-20
asset, receives ERC-4626-style shares priced at `sharePrice`, and may borrow up
to `collateralRatio` (80%) of their share value. The contract is deliberately
small — its value is the eight invariants it must never violate, enforced
*before* deployment by the Foundry harness and *after* deployment by the
Guardian bot.

### Design constraints

| Decision | Rationale |
|----------|-----------|
| `sharePrice` fixed at `1e18`, never mutated | A 1:1 peg removes share-dilution and rounding-inflation attack surface (closes EXP-02, EXP-07). Deposits and redemptions are exactly symmetric. |
| `collateralRatio` fixed at `80_00` bps | An 80% cap guarantees free liquidity always covers any single LP's redemption (closes EXP-04). |
| All mutating functions `nonReentrant` | Defence-in-depth even though `MockERC20` has no transfer hooks. |
| Single asset, no interest accrual | Keeps the reachable state space small enough to fuzz exhaustively. Interest/bad-debt is a documented non-goal (audit finding GUA-08). |
| `attack()` backdoor, chain-gated | Lets the demo force a live INV-01 breach; `revert`s on Base mainnet so the backdoor can never fire in production. See [SECURITY.md](../SECURITY.md). |

### Constants

| Name | Type | Value | Meaning |
|------|------|-------|---------|
| `WAD` | `uint256` | `1e18` | Fixed-point scaling unit. `sharePrice` and all share maths are WAD-scaled. |
| `BPS` | `uint256` | `100_00` | Basis-point denominator (`100_00` = 100%). |
| `BASE_MAINNET` | `uint256` | `8453` | Base mainnet chain id. `attack()` reverts when `block.chainid` equals this. |

### Immutables

| Name | Type | Set in | Meaning |
|------|------|--------|---------|
| `token` | `IERC20` | constructor | The ERC-20 asset deposited, borrowed, and repaid. |
| `attacker` | `address` | constructor | The only address permitted to call `attack()`. |

### Storage

| Slot | Name | Type | Meaning |
|------|------|------|---------|
| — | `totalDeposited` | `uint256` | Sum of all deposited principal currently held. |
| — | `totalBorrowed` | `uint256` | Sum of all outstanding borrows across every user. |
| — | `totalShares` | `uint256` | ERC-4626-style total share supply. |
| — | `sharePrice` | `uint256` | Share-to-asset price, WAD-scaled. Initialised to `WAD`, never changed. |
| — | `collateralRatio` | `uint256` | Maximum borrow as a fraction of collateral value, in bps. Initialised to `80_00`. |
| — | `userShares` | `mapping(address => uint256)` | Shares owned per user. |
| — | `userBorrowed` | `mapping(address => uint256)` | Outstanding borrow principal per user. |

Every storage variable is `public`, so Solidity generates a view getter for
each. The Guardian's [`fetcher.ts`](guardian-bot.md#fetcherts) reads five of
them (`totalDeposited`, `totalBorrowed`, `totalShares`, `sharePrice`,
`collateralRatio`) in a single `multicall`.

### Constructor

```solidity
constructor(address _token, address _attacker)
```

Sets `token` and `attacker`, then initialises `sharePrice = WAD` and
`collateralRatio = 80_00`. No access control — whoever deploys chooses the
asset and the demo attacker address.

| Parameter | Meaning |
|-----------|---------|
| `_token` | ERC-20 asset the vault handles. |
| `_attacker` | Address allowed to call `attack()`. In the Foundry harness this is `address(0xDEAD)` so the backdoor is unreachable during fuzzing. |

### Modifiers

| Modifier | Effect |
|----------|--------|
| `onlyAttacker` | Reverts `NotAttacker` unless `msg.sender == attacker`. Applied only to `attack()`. |
| `nonReentrant` | Inherited from OpenZeppelin. Applied to `deposit`, `withdraw`, `borrow`, `repay`. |

---

### Functions

#### `deposit`

```solidity
function deposit(uint256 amount) external nonReentrant
```

Deposits `amount` of `token` and mints shares at `sharePrice`.

- **Mints:** `sharesMinted = amount * WAD / sharePrice` (equals `amount` at the
  1:1 peg).
- **Transfers:** `amount` from `msg.sender` to the vault via `safeTransferFrom`
  — the caller must have approved the vault first.
- **State:** `totalDeposited += amount`, `totalShares += sharesMinted`,
  `userShares[msg.sender] += sharesMinted`.
- **Reverts:** `ZeroAmount` if `amount == 0`; bubbles any `safeTransferFrom`
  failure (insufficient balance or allowance).
- **Emits:** `Deposited(msg.sender, amount, sharesMinted)`.

#### `withdraw`

```solidity
function withdraw(uint256 shares) external nonReentrant
```

Burns `shares` and redeems the underlying asset at `sharePrice`.

- **Computes:** `amountOut = shares * sharePrice / WAD`.
- **INV-02 guard:** reverts `InsufficientLiquidity` if free liquidity
  (`totalDeposited - totalBorrowed`) is less than `amountOut` — the vault never
  pays out borrowed reserves.
- **INV-05 guard:** reverts `CollateralCapExceeded` if, after the burn, the
  caller's remaining collateral no longer covers their outstanding
  `userBorrowed` — a borrower cannot strip collateral and walk away with bad
  debt.
- **State:** `userShares[msg.sender] -= shares`, `totalShares -= shares`,
  `totalDeposited -= amountOut`.
- **Transfers:** `amountOut` to `msg.sender` via `safeTransfer`.
- **Reverts:** `ZeroAmount` if `shares == 0`; `InsufficientShares` if
  `shares > userShares[msg.sender]`; plus the two guards above.
- **Emits:** `Withdrawn(msg.sender, shares, amountOut)`.

#### `borrow`

```solidity
function borrow(uint256 amount) external nonReentrant
```

Borrows `amount` of `token` against the caller's deposited shares.

- **Collateral cap:** `collateralValue = userShares[msg.sender] * sharePrice /
  WAD`; `maxBorrow = collateralValue * collateralRatio / BPS`. Reverts
  `CollateralCapExceeded` if `userBorrowed[msg.sender] + amount > maxBorrow`.
- **Liquidity guard:** reverts `InsufficientLiquidity` if free liquidity is
  below `amount`.
- **State:** `userBorrowed[msg.sender] += amount`, `totalBorrowed += amount`.
- **Transfers:** `amount` to `msg.sender` via `safeTransfer`.
- **Reverts:** `ZeroAmount` if `amount == 0`; plus the two guards above.
- **Emits:** `Borrowed(msg.sender, amount)`.

#### `repay`

```solidity
function repay(uint256 amount) external nonReentrant
```

Repays `amount` of the caller's outstanding borrow.

- **Transfers:** `amount` from `msg.sender` to the vault via `safeTransferFrom`.
- **State:** `userBorrowed[msg.sender] -= amount`, `totalBorrowed -= amount`.
- **Reverts:** `ZeroAmount` if `amount == 0`; `RepayExceedsDebt` if
  `amount > userBorrowed[msg.sender]` — repayment can never push a balance
  below zero, which would underflow.
- **Emits:** `Repaid(msg.sender, amount)`.

#### `attack`

```solidity
function attack() external onlyAttacker
```

> **Demo only.** Not part of the lending protocol. It exists so the Loom demo
> can show the Guardian bot detecting a live invariant breach.

- Reverts `NotAttacker` unless `msg.sender == attacker`.
- Reverts `MainnetDisabled` if `block.chainid == BASE_MAINNET` (8453) — a hard
  backstop so the backdoor cannot be triggered if this bytecode ever reaches
  production.
- Sets `totalBorrowed = totalDeposited + 1`, deterministically breaking
  **INV-01** (Solvency) and **INV-07** (Non-negative net).
- **Emits:** `InvariantViolated("INV-01: Solvency", totalBorrowed,
  totalDeposited)`.
- **Not** `nonReentrant` — it makes no external calls.

The breach is permanent: once `attack()` runs, the vault is insolvent for
good. Redeploy for a fresh demo. See [setup.md](setup.md#8-trigger-the-demo-violation).

---

### Events

| Event | Signature | Emitted by |
|-------|-----------|------------|
| `Deposited` | `(address indexed user, uint256 amount, uint256 sharesMinted)` | `deposit` |
| `Withdrawn` | `(address indexed user, uint256 shares, uint256 amountOut)` | `withdraw` |
| `Borrowed` | `(address indexed user, uint256 amount)` | `borrow` |
| `Repaid` | `(address indexed user, uint256 amount)` | `repay` |
| `InvariantViolated` | `(string invariantName, uint256 actualValue, uint256 expectedBound)` | `attack` |

> **Note for future work.** The Guardian bot currently reads *state*, not
> events, so INV-04 and INV-05 fall back to aggregate proxies (see
> [invariants.md](invariants.md#where-each-invariant-is-enforced)). Indexing
> `Deposited` / `Withdrawn` / `Borrowed` would let the bot reconstruct exact
> per-user balances and close those proxies.

### Custom errors

| Error | Thrown when |
|-------|-------------|
| `ZeroAmount` | A mutating function is called with a zero amount or zero shares. |
| `InsufficientShares` | `withdraw` is called for more shares than the caller holds. |
| `InsufficientLiquidity` | `withdraw` / `borrow` would exceed the vault's free (un-borrowed) liquidity. |
| `CollateralCapExceeded` | `borrow` / `withdraw` would leave the caller borrowing above their 80% cap. |
| `RepayExceedsDebt` | `repay` is called for more than the caller's outstanding debt. |
| `NotAttacker` | A non-`attacker` address calls `attack()`. |
| `MainnetDisabled` | `attack()` is called while `block.chainid == 8453` (Base mainnet). |

Custom errors are used throughout instead of `require` strings — they are
cheaper and give each exploit replay a precise selector to assert against.

---

## MockERC20

`src/MockERC20.sol` · inherits OpenZeppelin
[`ERC20`](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20#ERC20).

A plain 18-decimal test token, name `Mock USD`, symbol `mUSD`.

| Member | Description |
|--------|-------------|
| `constructor()` | Mints `1_000_000e18` to the deployer. |
| `mint(address to, uint256 amount)` | Mints `amount` to `to`. **Unrestricted — no access control.** |

`mint` is intentionally permissionless so handlers and tests can fund actors
freely. `MockERC20` has **no transfer hooks** (no ERC-777-style callbacks),
which is deliberate: it keeps the fuzzer from having to model reentrancy
through the token. That is also why audit finding GUA-02 (reentrancy) is
classified *monitored-only* rather than *fully-assured* — the harness has no
hook to exercise. See [assurance.md](assurance.md#audit-traceability).

> **Never deploy `MockERC20` to mainnet.** Unrestricted `mint` makes it
> worthless as a real asset. On Base Sepolia the deploy script
> ([`DeployVault.s.sol`](#deployment-script)) creates one automatically; on a
> real network, pass `TOKEN_ADDRESS` to reuse an existing asset instead.

---

## Deployment script

`script/DeployVault.s.sol` — a Foundry script (`forge script`).

`run()`:

1. Reads `ATTACKER_ADDRESS` from the environment (required).
2. Reads `TOKEN_ADDRESS` from the environment (optional, defaults to
   `address(0)`).
3. If no token was supplied, deploys a fresh `MockERC20` and uses it.
4. Deploys `Vault(token, attacker)` and logs the vault, token, and attacker
   addresses.

Full broadcast instructions — keystore setup, RPC, `--verify` — are in
[setup.md](setup.md#4-deploy-to-base-sepolia).

---

## Related documents

- [invariants.md](invariants.md) — the eight invariants the contract must hold.
- [guardian-bot.md](guardian-bot.md) — how the off-chain bot reads this contract.
- [testing.md](testing.md) — how the harness and exploit replays exercise it.
- [SECURITY.md](../SECURITY.md) — trust boundaries and the `attack()` backdoor.
</content>
</invoke>
