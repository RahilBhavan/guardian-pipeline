# Contract reference

Complete API reference for the Solidity layer: [`Vault.sol`](#vault), the
contract under review; [`AttackableVault.sol`](#attackablevault), its demo-only
subclass; [`IPriceOracle.sol`](#ipriceoracle) and
[`MockOracle.sol`](#mockoracle), the price-feed interface and its test
implementation; [`MockERC20.sol`](#mockerc20), the test asset; and the
[`src/attackable/`](#attackable-family) family of deliberately broken variants
that back the exploit replays. Every function, event, error, and storage slot
is documented against the source in [`src/`](../src).

> **Audience.** Read this if you are reviewing the contract, writing a new
> handler or exploit replay, or wiring the Guardian bot to a fresh deployment.
> For *why* the invariants are shaped the way they are, see
> [invariants.md](invariants.md).

---

## Vault

`src/Vault.sol` · Solidity `^0.8.24` · inherits OpenZeppelin
[`ReentrancyGuard`](https://docs.openzeppelin.com/contracts/5.x/api/utils#ReentrancyGuard)
· uses [`SafeERC20`](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20#SafeERC20).

An interest-bearing, over-collateralised lending vault. Lenders deposit the
**debt asset** and receive shares whose value rises as borrowers pay interest.
Borrowers post a separate **collateral asset**, priced through an
[`IPriceOracle`](#ipriceoracle), and may borrow the debt asset up to
`collateralRatio` (80%) of their collateral value; their debt grows over time
through a `borrowIndex`. Positions that drift under-water can be cleared by
anyone via `liquidate` for a `liquidationBonus`. The contract follows the
Morpho-style dual-tracked accounting model — the lender side stores
`totalSupplyAssets` directly, the borrow side scales an index — so the
solvency margin can never erode by rounding. Its value is the 12 invariants it
must never violate, enforced *before* deployment by the Foundry harness and
*after* deployment by the Guardian bot.

### Design constraints

| Decision | Rationale |
|----------|-----------|
| Lender side stores `totalSupplyAssets`; borrow side scales `borrowIndex` | Interest moves both sides by the *same* realised amount, so INV-01 (solvency) holds exactly — accrual introduces no rounding drift. |
| Share price derived from stored `totalSupplyAssets`, never the token balance | A direct token donation cannot move the shares-to-assets ratio — the ERC-4626 first-depositor inflation attack is structurally prevented (closes EXP-01 and EXP-10 on the lender side). |
| Collateral is a **separate** ERC-20 priced through an oracle | Lender shares are not collateral. A lender may withdraw shares freely (subject only to liquidity) regardless of any borrow position they hold — the cap is enforced on `borrow` and `withdrawCollateral`. |
| Oracle freshness gate (`MAX_STALENESS = 1 days`) | Every price-dependent path reads the oracle through `_freshPrice`, which reverts `OraclePriceStale` when the oracle is older than `MAX_STALENESS` — closes the Beanstalk-style stale-price class (INV-11, EXP-09). |
| Every operation rounds in the protocol's favour | Borrows round debt up, repayments round burns down, withdrawals pay the floor — the solvency margin can only grow. The fuzz harness exists to prove the directions are correct. |
| `collateralRatio` fixed at `80_00` bps; `liquidationBonus` a constructor parameter in `(0, 50_00]` | An 80% cap leaves headroom for interest to accrue before a position is liquidatable; the bonus incentivises third-party liquidators while the upper bound prevents liquidators from seizing more than half again a position's value. |
| All mutating functions `nonReentrant` | Defence-in-depth even though `MockERC20` has no transfer hooks. |
| No `attack()` backdoor | The demo breach lives only in [`AttackableVault`](#attackablevault); the reviewed `Vault` has no privileged accounting path. |

### Constants

| Name | Type | Value | Meaning |
|------|------|-------|---------|
| `WAD` | `uint256` | `1e18` | Fixed-point scaling unit. The share price, borrow index and oracle prices are WAD-scaled. |
| `BPS` | `uint256` | `100_00` | Basis-point denominator (`100_00` = 100%). |
| `SECONDS_PER_YEAR` | `uint256` | `365 days` | Time base for converting the APR to a per-second rate. |
| `MAX_STALENESS` | `uint256` | `1 days` | Maximum tolerated gap between `oracle.lastUpdatedAt()` and `block.timestamp`. Price-dependent paths revert `OraclePriceStale` when the gap exceeds this — the freshness gate INV-11 enforces via `_freshPrice`. |

### Immutables

| Name | Type | Set in | Meaning |
|------|------|--------|---------|
| `debtAsset` | `IERC20` | constructor | The ERC-20 lenders deposit and borrowers receive and repay. |
| `collateralAsset` | `IERC20` | constructor | The ERC-20 borrowers post as collateral and liquidators seize. |
| `oracle` | `IPriceOracle` | constructor | Price oracle giving the value of one collateral unit in debt-asset units, WAD-scaled. |
| `borrowRatePerSecond` | `uint256` | constructor | Per-second borrow rate, WAD-scaled. Derived from the APR: `aprBps * WAD / BPS / SECONDS_PER_YEAR`. |
| `collateralRatio` | `uint256` | constructor | Maximum borrow as a fraction of collateral value, in bps. Hardcoded to `80_00` (80%). Not a constructor parameter. |
| `liquidationBonus` | `uint256` | constructor | Extra collateral a liquidator seizes, in bps. Must be in `(0, 50_00]`; reverts `InvalidLiquidationBonus` otherwise. |

### Storage

| Name | Type | Meaning |
|------|------|---------|
| `totalSupplyAssets` | `uint256` | Total debt-asset units owed to lenders. Stored directly; grown by realised interest. Never derived from the token balance, which is what makes the vault immune to donation attacks on the lender side. |
| `totalSupplyShares` | `uint256` | Total lender shares outstanding. |
| `userSupplyShares` | `mapping(address => uint256)` | Lender shares held per address. |
| `totalCollateral` | `uint256` | Total collateral-asset units posted across every borrower. |
| `userCollateral` | `mapping(address => uint256)` | Collateral-asset units posted per address. |
| `totalBorrowShares` | `uint256` | Total borrow shares outstanding. |
| `userBorrowShares` | `mapping(address => uint256)` | Borrow shares owed per address. |
| `borrowIndex` | `uint256` | Debt-scaling index, WAD-scaled. Starts at `WAD`, rises monotonically. |
| `lastAccrualTime` | `uint256` | Unix timestamp of the most recent interest accrual. |

Every storage variable is `public`, so Solidity generates a view getter for
each. The Guardian's [`fetcher.ts`](guardian-bot.md#fetcherts) reads the
aggregates plus each discovered account's `userSupplyShares`, `userCollateral`
and `userBorrowShares` in a single `multicall`.

### Constructor

```solidity
constructor(
    address _debtAsset,
    address _collateralAsset,
    address _oracle,
    uint256 _aprBps,
    uint256 _liquidationBonus
)
```

Sets `debtAsset`, `collateralAsset` and `oracle`; derives `borrowRatePerSecond`
from `_aprBps`; fixes `collateralRatio = 80_00`; sets `liquidationBonus` from
`_liquidationBonus`; and initialises `borrowIndex = WAD` and
`lastAccrualTime = block.timestamp`.

Reverts `InvalidLiquidationBonus` if `_liquidationBonus == 0` or
`_liquidationBonus > 50_00`.

| Parameter | Meaning |
|-----------|---------|
| `_debtAsset` | ERC-20 lenders deposit and borrowers receive/repay. |
| `_collateralAsset` | ERC-20 borrowers post as collateral. |
| `_oracle` | `IPriceOracle` giving the collateral price in debt-asset units, WAD-scaled. |
| `_aprBps` | Annual borrow rate in basis points (e.g. `10_00` = 10% APR). The harness and replays use 10%. |
| `_liquidationBonus` | Extra collateral seized by liquidators, in basis points. Must be in `(0, 50_00]`. |

### Modifiers

| Modifier | Effect |
|----------|--------|
| `nonReentrant` | Inherited from OpenZeppelin. Applied to `deposit`, `withdraw`, `depositCollateral`, `withdrawCollateral`, `borrow`, `repay`, `liquidate`. |

---

### Functions

#### `accrue`

```solidity
function accrue() public virtual
```

Accrues borrower interest since the last accrual and credits it to lenders.
Idempotent within a block. Called at the start of every mutating function, and
callable directly so off-chain tooling can force state to a fresh block.

- Raises `borrowIndex` by `borrowIndex * borrowRatePerSecond * dt / WAD`.
- Adds the *realised* increase in `totalBorrowed()` to `totalSupplyAssets` — the
  identical amount on both sides, which is what keeps INV-01 exact.
- No-op when no time has passed or no debt is outstanding.
- Marked `virtual` so the mutation-testing suite under `test/mutant/` can
  subclass with deliberately broken variants and prove INV-12 (accrue
  idempotence) is load-bearing.
- **Emits:** `Accrued(interest, newBorrowIndex)` when interest is non-zero.

#### `deposit`

```solidity
function deposit(uint256 amount) external nonReentrant
```

Deposits `amount` of the debt asset and mints lender shares.

- **Mints:** `shares = amount` for the first depositor, otherwise
  `amount * totalSupplyShares / totalSupplyAssets` (floor — the claim is worth
  no more than `amount`).
- **Transfers:** `amount` of `debtAsset` from `msg.sender` via `safeTransferFrom`.
- **State:** `totalSupplyAssets += amount`, `totalSupplyShares += shares`,
  `userSupplyShares[msg.sender] += shares`.
- **Reverts:** `ZeroAmount` if `amount == 0` or the deposit would mint zero
  shares; bubbles any `safeTransferFrom` failure.
- **Emits:** `Deposited(msg.sender, amount, shares)`.

#### `withdraw`

```solidity
function withdraw(uint256 shares) external nonReentrant
```

Burns `shares` and redeems the underlying debt asset.

Lender shares are **not** collateral in this design. The redemption is
independent of any borrow position the caller may hold — the collateral cap is
enforced on `borrow` and `withdrawCollateral`, not here.

- **Computes:** `amountOut = shares * totalSupplyAssets / totalSupplyShares`
  (floor).
- **Liquidity guard:** reverts `InsufficientLiquidity` if the vault's debt-asset
  balance is below `amountOut` — the vault never pays out borrowed funds.
- **State:** `totalSupplyAssets -= amountOut`, `totalSupplyShares -= shares`,
  `userSupplyShares[msg.sender] -= shares`.
- **Transfers:** `amountOut` of `debtAsset` to `msg.sender` via `safeTransfer`.
- **Reverts:** `ZeroAmount`; `InsufficientShares` if `shares` exceeds the
  caller's balance; `InsufficientLiquidity` as above.
- **Emits:** `Withdrawn(msg.sender, shares, amountOut)`.

#### `depositCollateral`

```solidity
function depositCollateral(uint256 amount) external nonReentrant
```

Posts `amount` of the collateral asset to back future borrows.

- **Transfers:** `amount` of `collateralAsset` from `msg.sender` via
  `safeTransferFrom`.
- **State:** `userCollateral[msg.sender] += amount`, `totalCollateral += amount`.
- **Reverts:** `ZeroAmount` if `amount == 0`; bubbles any `safeTransferFrom`
  failure.
- **Emits:** `CollateralDeposited(msg.sender, amount)`.

#### `withdrawCollateral`

```solidity
function withdrawCollateral(uint256 amount) external nonReentrant
```

Pulls back `amount` of posted collateral. Reverts if the remaining collateral
can no longer cover the caller's outstanding debt at the current oracle price.

- **Collateral cap (post-withdrawal):** computes
  `remainingValue = (userCollateral[msg.sender] - amount) * _freshPrice() / WAD`
  and `maxBorrow = remainingValue * collateralRatio / BPS`. Reverts
  `CollateralCapExceeded` if `userDebt(msg.sender) > maxBorrow`.
- **State:** `userCollateral[msg.sender] -= amount`, `totalCollateral -= amount`.
- **Transfers:** `amount` of `collateralAsset` to `msg.sender` via `safeTransfer`.
- **Reverts:** `ZeroAmount`; `InsufficientCollateral` if `amount` exceeds the
  caller's posted collateral; `CollateralCapExceeded` as above.
- **Emits:** `CollateralWithdrawn(msg.sender, amount)`.

#### `borrow`

```solidity
function borrow(uint256 amount) external virtual nonReentrant
```

Borrows `amount` of the debt asset against the caller's posted collateral,
priced through the oracle.

- **Collateral cap:** `maxBorrow = collateralValue(msg.sender) * collateralRatio
  / BPS` (calls through `_freshPrice`; reverts `OraclePriceStale` if the oracle
  is stale). Reverts `CollateralCapExceeded` if `userDebt(msg.sender) + amount`
  exceeds it.
- **Liquidity guard:** reverts `InsufficientLiquidity` if the vault's idle
  debt-asset balance is below `amount`.
- **Mints:** `borrowShares = ceil(amount * WAD / borrowIndex)` — debt rounds up,
  so the borrower's recorded debt is never less than the asset received.
- **State:** `totalBorrowShares += borrowShares`,
  `userBorrowShares[msg.sender] += borrowShares`.
- **Transfers:** `amount` of `debtAsset` to `msg.sender` via `safeTransfer`.
- **Reverts:** `ZeroAmount`; plus the two guards above; plus `OraclePriceStale`
  via `collateralValue` → `_freshPrice`.
- **Emits:** `Borrowed(msg.sender, amount, borrowShares)`.
- Marked `virtual` so the INV-07 mutant subclass can swap the ceil-rounded share
  computation for a floor-rounded one and demonstrate the solvency-monotonicity
  invariant catches it.

#### `repay`

```solidity
function repay(uint256 amount) external nonReentrant
```

Repays the caller's debt. Offering `amount >= debt` fully closes the position.

- A partial repayment burns `floor(amount * WAD / borrowIndex)` borrow shares
  and collects exactly `amount`.
- A full close burns the caller's entire borrow-share balance and collects the
  *realised* drop in `totalBorrowed()` — the debt, or by at most one wei of
  index rounding one wei more (review finding GUA-06). Charging the realised
  drop is what keeps INV-01 exact.
- **State:** `userBorrowShares` and `totalBorrowShares` decrease by the burned
  shares.
- **Transfers:** the collected amount of `debtAsset` from `msg.sender` via
  `safeTransferFrom`.
- **Reverts:** `ZeroAmount`; `NoDebt` if the caller has no outstanding debt.
- **Emits:** `Repaid(msg.sender, pay, borrowSharesBurned)`.

#### `liquidate`

```solidity
function liquidate(address borrower, uint256 amount) external virtual nonReentrant
```

Clears an under-water borrower's position: repays part or all of their debt and
seizes their **collateral asset** plus the `liquidationBonus`.

- **Health check:** reverts `PositionHealthy` unless the borrower's `userDebt`
  exceeds their collateral cap (`collateralValue(borrower) * collateralRatio /
  BPS`, through `_freshPrice` — reverts `OraclePriceStale` when the oracle
  is stale).
- **Seizure:** computes
  `seizeCollateral = (plannedPay * (BPS + liquidationBonus) / BPS) * WAD / price`
  — the amount of the collateral asset transferred to the liquidator.
- **Full-collateral rule:** if the seizure would consume all of the borrower's
  collateral, the liquidator must close the *entire* debt — reverts
  `MustClearDebt` otherwise. This is what keeps INV-06 (no uncollateralised
  debt) true.
- **State:** burns the borrower's debt shares; decrements
  `userCollateral[borrower]` and `totalCollateral` by the seized amount;
  collects the repaid debt.
- **Transfers:** `debtAsset` from the liquidator via `safeTransferFrom`;
  `collateralAsset` to the liquidator via `safeTransfer`.
- **Reverts:** `NoDebt`; `PositionHealthy`; `ZeroAmount`; `MustClearDebt`;
  `OraclePriceStale`.
- **Emits:** `Liquidated(msg.sender, borrower, debtRepaid, collateralSeized)`.
- Marked `virtual` so the INV-08 mutant subclass can inflate the seizure
  formula and prove the no-free-lunch invariant catches it.

### View functions

| View | Returns |
|------|---------|
| `totalBorrowed()` | Total debt in debt-asset units — `totalBorrowShares * borrowIndex / WAD`. |
| `userDebt(address user)` | A borrower's debt in debt-asset units — `userBorrowShares[user] * borrowIndex / WAD` (floor). Marked `virtual` so the INV-10 mutant can flip floor to ceil and prove the invariant catches it. |
| `collateralValue(address user)` | The debt-asset value of a borrower's posted collateral at the current oracle price — `userCollateral[user] * _freshPrice() / WAD`. Reverts `OraclePriceStale` when the oracle is stale. |
| `sharePrice()` | Lender share-to-asset price, WAD-scaled. Returns `WAD` when no shares exist. |
| `cash()` | The vault's idle (un-borrowed) debt-asset balance — `debtAsset.balanceOf(address(this))`. |
| `totalAssets()` | `cash() + totalBorrowed()` — the debt-asset units backing lender claims. |

### Internal functions

| Function | Visibility | Description |
|----------|-----------|-------------|
| `_freshPrice()` | `internal view virtual` | Reads `oracle.price()` after asserting `block.timestamp - oracle.lastUpdatedAt() <= MAX_STALENESS`; reverts `OraclePriceStale` when stale. Marked `virtual` so the INV-11 mutant subclass can drop the freshness check and prove the invariant catches an ungated price read. |
| `_burnDebt(address borrower, uint256 offered, uint256 debt)` | `private` | Reduces a borrower's borrow shares for a repayment. Returns `(pay, burned)`: the debt-asset amount to collect from the payer, and the shares burned. A full close (`offered >= debt`) burns the entire share balance and charges the realised drop in `totalBorrowed()`; a partial repayment floor-divides the burned shares. Charging the realised drop is what keeps INV-01 exact. |

---

### Events

| Event | Signature | Emitted by |
|-------|-----------|------------|
| `Deposited` | `(address indexed user, uint256 amount, uint256 sharesMinted)` | `deposit` |
| `Withdrawn` | `(address indexed user, uint256 shares, uint256 amountOut)` | `withdraw` |
| `CollateralDeposited` | `(address indexed user, uint256 amount)` | `depositCollateral` |
| `CollateralWithdrawn` | `(address indexed user, uint256 amount)` | `withdrawCollateral` |
| `Borrowed` | `(address indexed user, uint256 amount, uint256 borrowShares)` | `borrow` |
| `Repaid` | `(address indexed user, uint256 amount, uint256 borrowSharesBurned)` | `repay` |
| `Liquidated` | `(address indexed liquidator, address indexed borrower, uint256 debtRepaid, uint256 collateralSeized)` | `liquidate` |
| `Accrued` | `(uint256 interest, uint256 newBorrowIndex)` | `accrue` |

The Guardian bot indexes `Deposited`, `CollateralDeposited`, `Borrowed` and
`Liquidated` to discover every account that has held a position, then reads
exact per-user state — which is why INV-02/03/06 are checked off-chain against
the real user set rather than a proxy. See
[guardian-bot.md](guardian-bot.md#fetcherts).

### Custom errors

| Error | Thrown when |
|-------|-------------|
| `ZeroAmount` | A mutating function is called with a zero amount, or a deposit would mint zero shares. |
| `InsufficientShares` | `withdraw` is called for more shares than the caller holds. |
| `InsufficientCollateral` | `withdrawCollateral` is called for more than the caller's posted collateral. |
| `InsufficientLiquidity` | `withdraw` or `borrow` would exceed the vault's idle debt-asset cash. |
| `CollateralCapExceeded` | `borrow` or `withdrawCollateral` would leave the caller borrowing above their 80% cap. |
| `NoDebt` | `repay` or `liquidate` targets an account with no outstanding debt. |
| `PositionHealthy` | `liquidate` targets a position still within its collateral cap. |
| `MustClearDebt` | `liquidate` would seize all of a borrower's collateral without closing the full debt. |
| `InvalidLiquidationBonus` | Constructor called with `_liquidationBonus == 0` or `_liquidationBonus > 50_00`. |
| `OraclePriceStale` | A price-dependent path (`borrow`, `withdrawCollateral`, `liquidate` health check via `_freshPrice`) detects that `block.timestamp - oracle.lastUpdatedAt() > MAX_STALENESS`. |

Custom errors are used throughout instead of `require` strings — they are
cheaper and give each exploit replay a precise selector to assert against.

---

## IPriceOracle

`src/IPriceOracle.sol` · Solidity `^0.8.24`.

A minimal two-function interface that decouples the Vault from any particular
price-feed implementation. A production deployment would adapt Chainlink, Pyth
or Redstone behind this interface; the Vault depends only on these two views.

| Member | Signature | Description |
|--------|-----------|-------------|
| `price()` | `function price() external view returns (uint256)` | Price of one whole collateral unit in debt-asset units, WAD-scaled. A return value of `2_000e18` means one collateral token is worth 2,000 debt-asset tokens. Both assets are assumed to be 18-decimal. |
| `lastUpdatedAt()` | `function lastUpdatedAt() external view returns (uint256)` | Unix timestamp at which `price()` was last refreshed. Consumed by the Vault's `_freshPrice` freshness gate — if `block.timestamp - lastUpdatedAt() > MAX_STALENESS`, price-dependent paths revert `OraclePriceStale` (INV-11). |

---

## MockOracle

`src/MockOracle.sol` · implements [`IPriceOracle`](#ipriceoracle).

A settable price feed for tests, the Foundry harness and demos. `setPrice` is
intentionally permissionless: the fuzz harness's `WarpHandler` drives the price
to exercise liquidation paths; scripted demos pre-seed a realistic value. Not
for production use — a real deployment must wrap an authenticated feed behind
`IPriceOracle`.

| Member | Description |
|--------|-------------|
| `WAD` | Constant `1e18` — kept here so callers can construct prices without re-deriving the constant. |
| `storedPrice` | Current price of one collateral unit in debt-asset units, WAD-scaled. |
| `storedTimestamp` | Unix timestamp of the last refresh of `storedPrice`. |
| `constructor(uint256 initialPrice)` | Sets `storedPrice = initialPrice` and `storedTimestamp = block.timestamp`. Reverts `ZeroPrice` if `initialPrice == 0`. |
| `setPrice(uint256 newPrice)` | Updates `storedPrice` and refreshes `storedTimestamp` to `block.timestamp`. Reverts `ZeroPrice` if `newPrice == 0`. Emits `PriceSet(oldPrice, newPrice)`. Permissionless. |
| `setLastUpdatedAt(uint256 timestamp)` | Overwrites `storedTimestamp` without touching the price. Used by `WarpHandler` after each `vm.warp` to control the oracle's apparent freshness in the fuzz harness, and by tests that need to place the oracle in a specific staleness state. |
| `price()` | Returns `storedPrice`. Implements `IPriceOracle`. |
| `lastUpdatedAt()` | Returns `storedTimestamp`. Implements `IPriceOracle`. |

**Errors:**

| Error | Thrown when |
|-------|-------------|
| `ZeroPrice` | `constructor` or `setPrice` is called with `0`. A zero price would zero out every borrower's collateral value and instantly mark every position insolvent — not a meaningful test condition. |

---

## AttackableVault

`src/AttackableVault.sol` · inherits [`Vault`](#vault).

> **Demo only.** `AttackableVault` is identical to `Vault` except for a single
> `attack()` function — a deliberate one-line flag, not an exploit. It exists
> so the runtime monitor can be observed detecting an invariant breach
> end-to-end. It is **never deployed to production**; isolating the flag here
> means the reviewed `Vault` carries no privileged path at all. See
> [SECURITY.md](../SECURITY.md).

| Member | Description |
|--------|-------------|
| `BASE_MAINNET` | Constant `8453` — the chain id on which `attack()` is permanently disabled. |
| `attacker` | Immutable address permitted to call `attack()`. |
| `constructor(address _debtAsset, address _collateralAsset, address _oracle, uint256 _aprBps, uint256 _liquidationBonus, address _attacker)` | As `Vault`, plus the demo `attacker` address. |
| `attack()` | Sets `totalSupplyAssets = totalSupplyAssets * 1_000 + 1_000e18`, inflating the lender-side claim far beyond the assets backing it — a direct **INV-01** (solvency) violation. Reverts `NotAttacker` unless called by `attacker`; reverts `MainnetDisabled` when `block.chainid == BASE_MAINNET`. |

`attack()` is the **only** difference from `Vault`. It is replayed as staged demo
scenario **STAGED-01**, where the expected outcome is **DETECTED** — a staged
breach used to show the runtime monitor catching an insolvency the contract code
itself permitted. It demonstrates the detection plumbing; it is not a novel
exploit.

**Errors** (additional to those inherited from `Vault`):

| Error | Thrown when |
|-------|-------------|
| `NotAttacker` | `attack()` is called by any address other than `attacker`. |
| `MainnetDisabled` | `attack()` is called on Base mainnet (`block.chainid == 8453`). |

---

## MockERC20

`src/MockERC20.sol` · inherits OpenZeppelin
[`ERC20`](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20#ERC20).

A plain 18-decimal test token, name `Mock USD`, symbol `mUSD`. The deploy
script creates **two** instances — one as the debt asset, one as the collateral
asset — unless existing addresses are supplied.

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
> ([`DeployVault.s.sol`](#deployment-script)) creates fresh instances
> automatically; on a real network, pass `DEBT_ASSET` and `COLLATERAL_ASSET`
> to reuse existing assets instead.

---

## Attackable family

`src/attackable/` — demo-only contracts used exclusively by `test/exploit/` to
replay historical exploit classes against vulnerable surfaces and prove the
canonical `Vault` is immune.

Each contract is a minimal subclass (or standalone stub) with a single
deliberate defect; the exploit-replay test runs the attack on the broken
surface (expected: succeeds), then repeats it on the canonical `Vault`
(expected: reverts or has no effect). Mapping to the exploit catalogue in
[assurance.md](assurance.md#exploit-resistance) is shown below.

| Contract | Defect | EXP |
|----------|--------|-----|
| `AttackableInflatableVault` | Derives `totalSupplyAssets` from `debtAsset.balanceOf`, making it vulnerable to donation/inflation. | EXP-01, EXP-10 |
| `AttackableEulerStyleVault` | Adds a `donateToReserves` path that burns collateral without re-running the cap check, replicating the Euler 2023 bug (~$197M). | EXP-02 |
| `AttackableOracleVault` + `BalanceDerivedOracle` | Pairs a standard `Vault` with a `BalanceDerivedOracle` that prices collateral off `asset.balanceOf(holder)` — the Cream 2021 mechanism (~$130M); donating to `holder` inflates the price. | EXP-03 |
| `AttackableNoCapVault` | Drops the `CollateralCapExceeded` check from `borrow`, allowing uncollateralised loans that drain free liquidity. | EXP-04 |
| `AttackableOverSeizeVault` | Doubles the seizure formula in `liquidate` so every liquidation extracts twice the permitted bonus. | EXP-05, EXP-07 |
| `AttackableTransferFromToken` | Carries the bZx Sep 2020 `transferFrom(self, self, amount)` defect — same-source-and-destination transfers credit without debiting, minting arbitrary balance. | EXP-06 |
| `AttackableCeilDebtVault` | Overrides `userDebt` to ceil-divide instead of floor-divide, so the sum of per-borrower debts can exceed `totalBorrowed` (INV-10 violation). | EXP-08 |
| `AttackableStaleOracleVault` | Overrides `_freshPrice` to drop the `MAX_STALENESS` check, replicating the Beanstalk-style stale-price class. | EXP-09 |
| `MockDonationInflatableAsset` | Stock OZ ERC-20 used as the collateral token in EXP-03; its balance at a fixed holder drives the `BalanceDerivedOracle`. | EXP-03 |

> **Never deploy any `src/attackable/` contract beyond a test or demo
> environment.** Each carries a deliberate vulnerability. The canonical
> `Vault` has none of these defects — that is precisely what the exploit
> replay suite asserts.

---

## Deployment script

`script/DeployVault.s.sol` — a Foundry script (`forge script`).

`run()`:

1. Reads `ATTACKER_ADDRESS` from the environment (required).
2. Reads optional overrides: `DEBT_ASSET`, `COLLATERAL_ASSET`, `ORACLE_ADDRESS`,
   `INITIAL_PRICE_WAD` (default `2_000e18`), `APR_BPS` (default `10_00`),
   `LIQ_BONUS_BPS` (default `5_00`).
3. For each optional asset or oracle that was **not** supplied, deploys a fresh
   `MockERC20` (debt asset and/or collateral asset) or a fresh
   `MockOracle(initialPrice)` and logs the deployed address.
4. Deploys `AttackableVault(debt, collateral, oracle, aprBps, liquidationBonus, attacker)` —
   the demo deployment — and logs the vault, assets, oracle, APR, bonus and
   attacker. A production deployment would deploy `src/Vault.sol` directly,
   which carries no `attack()` backdoor.

Full broadcast instructions — keystore setup, RPC, `--verify` — are in
[setup.md](setup.md#4-deploy-to-base-sepolia).

---

## Related documents

- [invariants.md](invariants.md) — the 12 invariants the contract must hold.
- [guardian-bot.md](guardian-bot.md) — how the off-chain bot reads this contract.
- [invariants.md#testing-strategy](invariants.md#testing-strategy) — how the harness and exploit replays exercise it.
- [assurance.md](assurance.md#exploit-resistance) — the full exploit-replay catalogue with EXP→invariant mapping.
- [SECURITY.md](../SECURITY.md) — trust boundaries and the `attack()` demo flag.
