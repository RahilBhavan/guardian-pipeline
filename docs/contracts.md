# Contract reference

Complete API reference for the Solidity layer: [`Vault.sol`](#vault), the
contract under review; [`AttackableVault.sol`](#attackablevault), its demo-only
subclass; and [`MockERC20.sol`](#mockerc20), the test asset. Every function,
event, error, and storage slot is documented against the source in
[`src/`](../src).

> **Audience.** Read this if you are reviewing the contract, writing a new
> handler or exploit replay, or wiring the Guardian bot to a fresh deployment.
> For *why* the invariants are shaped the way they are, see
> [invariants.md](invariants.md).

---

## Vault

`src/Vault.sol` · Solidity `^0.8.24` · inherits OpenZeppelin
[`ReentrancyGuard`](https://docs.openzeppelin.com/contracts/5.x/api/utils#ReentrancyGuard)
· uses [`SafeERC20`](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20#SafeERC20).

An interest-bearing, over-collateralised lending vault. Lenders deposit a single
ERC-20 asset and receive shares; borrowers post those shares as collateral and
may borrow up to `collateralRatio` (80%) of their share value. Borrower debt
grows over time through a `borrowIndex`; the realised interest is credited to
lenders as a rising share price. Positions that drift under-water can be cleared
by anyone via `liquidate`. The contract follows the Morpho-style dual-tracked
accounting model — the lender side stores `totalSupplyAssets` directly, the
borrow side scales an index — so the solvency margin can never erode by
rounding. Its value is the 12 invariants it must never violate, enforced
*before* deployment by the Foundry harness and *after* deployment by the
Guardian bot.

### Design constraints

| Decision | Rationale |
|----------|-----------|
| Lender side stores `totalSupplyAssets`; borrow side scales `borrowIndex` | Interest moves both sides by the *same* realised amount, so INV-01 (solvency) holds exactly — accrual introduces no rounding drift. |
| Share price derived from stored `totalSupplyAssets`, never the token balance | A direct token donation cannot move the shares-to-assets ratio — the ERC-4626 first-depositor inflation attack is structurally prevented (closes EXP-02). |
| Every operation rounds in the protocol's favour | Borrows round debt up, repayments round burns down, withdrawals pay the floor — the solvency margin can only grow. The fuzz harness exists to prove the directions are correct. |
| `collateralRatio` fixed at `80_00` bps, `liquidationBonus` at `5_00` bps | An 80% cap leaves headroom for interest to accrue before a position is liquidatable; the 5% bonus incentivises third-party liquidators. |
| All mutating functions `nonReentrant` | Defence-in-depth even though `MockERC20` has no transfer hooks. |
| No `attack()` backdoor | The demo breach lives only in [`AttackableVault`](#attackablevault); the reviewed `Vault` has no privileged accounting path. |

### Constants

| Name | Type | Value | Meaning |
|------|------|-------|---------|
| `WAD` | `uint256` | `1e18` | Fixed-point scaling unit. The share price and borrow index are WAD-scaled. |
| `BPS` | `uint256` | `100_00` | Basis-point denominator (`100_00` = 100%). |
| `SECONDS_PER_YEAR` | `uint256` | `365 days` | Time base for converting the APR to a per-second rate. |

### Immutables

| Name | Type | Set in | Meaning |
|------|------|--------|---------|
| `token` | `IERC20` | constructor | The ERC-20 asset deposited, borrowed, repaid and seized. |
| `borrowRatePerSecond` | `uint256` | constructor | Per-second borrow rate, WAD-scaled. Derived from the APR: `aprBps * WAD / BPS / SECONDS_PER_YEAR`. |
| `collateralRatio` | `uint256` | constructor | Maximum borrow as a fraction of collateral value, in bps. Set to `80_00`. |
| `liquidationBonus` | `uint256` | constructor | Extra collateral a liquidator seizes, in bps. Set to `5_00`. |

### Storage

| Name | Type | Meaning |
|------|------|---------|
| `totalSupplyAssets` | `uint256` | Total assets owed to lenders. Stored directly; grown by realised interest. |
| `totalSupplyShares` | `uint256` | Total lender shares outstanding. |
| `userSupplyShares` | `mapping(address => uint256)` | Lender shares held per address. |
| `totalBorrowShares` | `uint256` | Total borrow shares outstanding. |
| `userBorrowShares` | `mapping(address => uint256)` | Borrow shares owed per address. |
| `borrowIndex` | `uint256` | Debt-scaling index, WAD-scaled. Starts at `WAD`, rises monotonically. |
| `lastAccrualTime` | `uint256` | Unix timestamp of the most recent interest accrual. |

Every storage variable is `public`, so Solidity generates a view getter for
each. The Guardian's [`fetcher.ts`](guardian-bot.md#fetcherts) reads the
aggregates plus each discovered account's `userSupplyShares` and
`userBorrowShares` in a single `multicall`.

### Constructor

```solidity
constructor(address _token, uint256 _aprBps)
```

Sets `token`, derives `borrowRatePerSecond` from `_aprBps`, fixes
`collateralRatio = 80_00` and `liquidationBonus = 5_00`, and initialises
`borrowIndex = WAD` and `lastAccrualTime = block.timestamp`.

| Parameter | Meaning |
|-----------|---------|
| `_token` | ERC-20 asset the vault handles. |
| `_aprBps` | Annual borrow rate in basis points (e.g. `10_00` = 10% APR). The harness and replays use 10%. |

### Modifiers

| Modifier | Effect |
|----------|--------|
| `nonReentrant` | Inherited from OpenZeppelin. Applied to `deposit`, `withdraw`, `borrow`, `repay`, `liquidate`. |

---

### Functions

#### `accrue`

```solidity
function accrue() public
```

Accrues borrower interest since the last accrual and credits it to lenders.
Idempotent within a block. Called at the start of every mutating function, and
callable directly so off-chain tooling can force state to a fresh block.

- Raises `borrowIndex` by `borrowIndex * borrowRatePerSecond * dt / WAD`.
- Adds the *realised* increase in `totalBorrowed()` to `totalSupplyAssets` — the
  identical amount on both sides, which is what keeps INV-01 exact.
- No-op when no time has passed or no debt is outstanding.
- **Emits:** `Accrued(interest, newBorrowIndex)` when interest is non-zero.

#### `deposit`

```solidity
function deposit(uint256 amount) external nonReentrant
```

Deposits `amount` of `token` and mints lender shares.

- **Mints:** `shares = amount` for the first depositor, otherwise
  `amount * totalSupplyShares / totalSupplyAssets` (floor — the claim is worth
  no more than `amount`).
- **Transfers:** `amount` from `msg.sender` via `safeTransferFrom`.
- **State:** `totalSupplyAssets += amount`, `totalSupplyShares += shares`,
  `userSupplyShares[msg.sender] += shares`.
- **Reverts:** `ZeroAmount` if `amount == 0` or the deposit would mint zero
  shares; bubbles any `safeTransferFrom` failure.
- **Emits:** `Deposited(msg.sender, amount, shares)`.

#### `withdraw`

```solidity
function withdraw(uint256 shares) external nonReentrant
```

Burns `shares` and redeems the underlying asset.

- **Computes:** `amountOut = shares * totalSupplyAssets / totalSupplyShares`
  (floor).
- **Liquidity guard:** reverts `InsufficientLiquidity` if idle `cash` is below
  `amountOut` — the vault never pays out borrowed funds.
- **Collateral guard:** reverts `CollateralCapExceeded` if, after the burn, the
  caller's remaining collateral no longer covers their `userDebt` — a borrower
  cannot strip collateral and walk away with bad debt.
- **State:** `totalSupplyAssets -= amountOut`, `totalSupplyShares -= shares`,
  `userSupplyShares[msg.sender] -= shares`.
- **Transfers:** `amountOut` to `msg.sender` via `safeTransfer`.
- **Reverts:** `ZeroAmount`; `InsufficientShares` if `shares` exceeds the
  caller's balance; plus the two guards above.
- **Emits:** `Withdrawn(msg.sender, shares, amountOut)`.

#### `borrow`

```solidity
function borrow(uint256 amount) external nonReentrant
```

Borrows `amount` of `token` against the caller's deposited shares.

- **Collateral cap:** `maxBorrow = collateralValue(msg.sender) * collateralRatio
  / BPS`. Reverts `CollateralCapExceeded` if `userDebt(msg.sender) + amount`
  exceeds it.
- **Liquidity guard:** reverts `InsufficientLiquidity` if idle `cash` is below
  `amount`.
- **Mints:** `borrowShares = ceil(amount * WAD / borrowIndex)` — debt rounds up,
  so the borrower's recorded debt is never less than the asset received.
- **State:** `totalBorrowShares += borrowShares`,
  `userBorrowShares[msg.sender] += borrowShares`.
- **Transfers:** `amount` to `msg.sender` via `safeTransfer`.
- **Reverts:** `ZeroAmount`; plus the two guards above.
- **Emits:** `Borrowed(msg.sender, amount, borrowShares)`.

#### `repay`

```solidity
function repay(uint256 amount) external nonReentrant
```

Repays the caller's debt. Offering `amount >= debt` fully closes the position.

- A partial repayment burns `floor(amount * WAD / borrowIndex)` borrow shares
  and collects exactly `amount`.
- A full close burns the caller's entire borrow-share balance and collects the
  *realised* drop in `totalBorrowed()` — the debt, or by at most one wei of
  index rounding one wei more (review finding GUA-07). Charging the realised
  drop is what keeps INV-01 exact.
- **State:** `userBorrowShares` and `totalBorrowShares` decrease by the burned
  shares.
- **Transfers:** the collected amount from `msg.sender` via `safeTransferFrom`.
- **Reverts:** `ZeroAmount`; `NoDebt` if the caller has no outstanding debt.
- **Emits:** `Repaid(msg.sender, pay, borrowSharesBurned)`.

#### `liquidate`

```solidity
function liquidate(address borrower, uint256 amount) external nonReentrant
```

Clears an under-water borrower's position: repays part or all of their debt and
seizes their collateral plus the `liquidationBonus`.

- **Health check:** reverts `PositionHealthy` unless the borrower's `userDebt`
  exceeds their collateral cap (`collateralValue * collateralRatio / BPS`).
- **Seizes:** collateral shares worth `pay * (BPS + liquidationBonus) / BPS`.
- **Full-collateral rule:** if the seizure would consume all of the borrower's
  shares, the liquidator must close the *entire* debt — reverts `MustClearDebt`
  otherwise. This is what keeps INV-06 (no uncollateralised debt) true.
- **State:** burns the borrower's debt shares; transfers the seized supply
  shares from the borrower to the liquidator; collects the repaid amount.
- **Reverts:** `NoDebt`; `PositionHealthy`; `ZeroAmount`; `MustClearDebt`.
- **Emits:** `Liquidated(msg.sender, borrower, debtRepaid, collateralSeized)`.

### View functions

| View | Returns |
|------|---------|
| `totalBorrowed()` | Total debt in asset units — `totalBorrowShares * borrowIndex / WAD`. |
| `userDebt(address user)` | A borrower's debt in asset units — `userBorrowShares[user] * borrowIndex / WAD`. |
| `collateralValue(address user)` | The asset value of a lender's shares — their collateral. |
| `sharePrice()` | Lender share-to-asset price, WAD-scaled. `WAD` when no shares exist. |
| `cash()` | The vault's idle (un-borrowed) ERC-20 balance. |
| `totalAssets()` | `cash() + totalBorrowed()` — the assets backing lender claims. |

---

### Events

| Event | Signature | Emitted by |
|-------|-----------|------------|
| `Deposited` | `(address indexed user, uint256 amount, uint256 sharesMinted)` | `deposit` |
| `Withdrawn` | `(address indexed user, uint256 shares, uint256 amountOut)` | `withdraw` |
| `Borrowed` | `(address indexed user, uint256 amount, uint256 borrowShares)` | `borrow` |
| `Repaid` | `(address indexed user, uint256 amount, uint256 borrowSharesBurned)` | `repay` |
| `Liquidated` | `(address indexed liquidator, address indexed borrower, uint256 debtRepaid, uint256 collateralSeized)` | `liquidate` |
| `Accrued` | `(uint256 interest, uint256 newBorrowIndex)` | `accrue` |

The Guardian bot indexes `Deposited`, `Borrowed` and `Liquidated` to discover
every account that has held a position, then reads exact per-user state — which
is why INV-02/03/06 are checked off-chain against the real user set rather than
a proxy. See [guardian-bot.md](guardian-bot.md#fetcherts).

### Custom errors

| Error | Thrown when |
|-------|-------------|
| `ZeroAmount` | A mutating function is called with a zero amount, or an operation would mint zero shares. |
| `InsufficientShares` | `withdraw` is called for more shares than the caller holds. |
| `InsufficientLiquidity` | `withdraw` / `borrow` would exceed the vault's idle cash. |
| `CollateralCapExceeded` | `borrow` / `withdraw` would leave the caller borrowing above their 80% cap. |
| `NoDebt` | `repay` / `liquidate` targets an account with no outstanding debt. |
| `PositionHealthy` | `liquidate` targets a position still within its collateral cap. |
| `MustClearDebt` | `liquidate` would seize all of a borrower's collateral without closing the full debt. |

Custom errors are used throughout instead of `require` strings — they are
cheaper and give each exploit replay a precise selector to assert against.

---

## AttackableVault

`src/AttackableVault.sol` · inherits [`Vault`](#vault).

> **Demo only.** `AttackableVault` is identical to `Vault` except for a single
> `attack()` function — a deliberate one-line flag, not an exploit. It exists
> so the runtime monitor can be filmed detecting an invariant breach
> end-to-end. It is **never deployed to production**; isolating the flag here
> means the reviewed `Vault` carries no privileged path at all. See
> [SECURITY.md](../SECURITY.md).

| Member | Description |
|--------|-------------|
| `BASE_MAINNET` | Constant `8453` — the chain id on which `attack()` is permanently disabled. |
| `attacker` | Immutable address permitted to call `attack()`. |
| `constructor(address _token, uint256 _aprBps, address _attacker)` | As `Vault`, plus the demo `attacker` address. |
| `attack()` | Inflates `totalSupplyAssets` past the assets backing it, breaking **INV-01** (solvency). Reverts `NotAttacker` unless called by `attacker`; reverts `MainnetDisabled` when `block.chainid == BASE_MAINNET`. |

`attack()` is replayed as exploit scenario **EXP-01**, where the expected
outcome is **DETECTED** — a staged breach used to show the runtime monitor
catching an insolvency the contract code itself permitted. It demonstrates the
detection plumbing; it is not a novel exploit.

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
through the token. The reentrancy review finding (see the generated
[traceability summary](../assurance/data/TRACEABILITY_SUMMARY.md)) is bound to
the contract-level `ReentrancyGuard` and the runtime monitor; the finding's
current tier is whatever the resolver emits, not a hand-pinned value here.
See [assurance.md](assurance.md#finding-traceability).

> **Never deploy `MockERC20` to mainnet.** Unrestricted `mint` makes it
> worthless as a real asset. On Base Sepolia the deploy script
> ([`DeployVault.s.sol`](#deployment-script)) creates one automatically; on a
> real network, pass `TOKEN_ADDRESS` to reuse an existing asset instead.

---

## Deployment script

`script/DeployVault.s.sol` — a Foundry script (`forge script`).

`run()`:

1. Reads `ATTACKER_ADDRESS` from the environment (required).
2. Reads `TOKEN_ADDRESS` (optional) and `APR_BPS` (optional, default `10_00`).
3. If no token was supplied, deploys a fresh `MockERC20` and uses it.
4. Deploys `AttackableVault(token, aprBps, attacker)` — the demo deployment —
   and logs the vault, token, APR and attacker. A production deployment would
   deploy `src/Vault.sol` directly.

Full broadcast instructions — keystore setup, RPC, `--verify` — are in
[setup.md](setup.md#4-deploy-to-base-sepolia).

---

## Related documents

- [invariants.md](invariants.md) — the 12 invariants the contract must hold.
- [guardian-bot.md](guardian-bot.md) — how the off-chain bot reads this contract.
- [invariants.md#testing-strategy](invariants.md#testing-strategy) — how the harness and exploit replays exercise it.
- [SECURITY.md](../SECURITY.md) — trust boundaries and the `attack()` demo flag.
