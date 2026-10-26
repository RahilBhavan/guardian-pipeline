# Invariant kit

The kit holds the lending-vault invariants that do not depend on how one vault is built. It has three parts:

- `ILendingVaultAdapter.sol`: the values the invariants read, such as total assets, lender claims, shares, debt, per-account collateral and debt, share price, realised losses, the collateral price, the liquidation threshold and the liquidation bonus.
- `LendingInvariants.sol`: the invariants as predicates that return `true` when the property holds. They cover solvency and its margin, share-price monotonicity outside realised losses, the share-price floor, no debt without collateral, share and debt conservation, per-position debt under accrual and liquidation sanity.
- `adapters/GuardianVaultAdapter.sol`: the adapter for this repository's `Vault`.

`test/invariant/InvariantVault.t.sol` evaluates INV-01 to INV-04, INV-06 to INV-10, the share-price monotonicity check and the GUA-01 solvency floor through `GuardianVaultAdapter`. INV-05 (borrow index), INV-11 (oracle freshness), INV-12 (accrue idempotence) and the GUA-01 reentry counter depend on this `Vault`'s internals, so they stay in the harness. `LendingInvariantsTest` runs the INV-07 to INV-10 mutant scenarios through the adapter and requires each kit predicate to hold on the real `Vault` and fail on the mutant.

## Point the kit at another vault

1. Write an adapter that implements `ILendingVaultAdapter` for one market. Return amounts in loan-asset units. Scale `sharePrice` and `collateralPrice` to 1e18 and the threshold and bonus to basis points (10,000 = 100%).
2. Write handlers that drive the vault's own actions, such as supply, withdraw, borrow, repay, liquidate, oracle moves and time warps. Handlers stay vault-specific. Only the reads go through the adapter.
3. In an invariant test, deploy or fork the vault, wrap it in the adapter and assert the predicates. Store the prior observation for the stateful checks (`solvencyMarginNonDecreasing`, `sharePriceMonotone`, `debtMonotoneUnderAccrual`). Pass the full actor set to the conservation checks: they assume the harness controls every holder.
4. Choose a share-price floor that matches the vault. `1e18` is correct only for a vault that starts at one share per asset unit.

### Example mapping: Revert Lend `V4Vault`

`V4Vault` is an ERC-4626 vault. Lenders hold vault shares, and borrowers borrow against Uniswap v4 LP position NFTs. Debt is tracked per token id.

- `totalAssets`, `totalSupplyShares`, `supplySharesOf`, `sharePrice`: the ERC-4626 `totalAssets()`, `totalSupply()`, `balanceOf(account)` and `convertToAssets(1e18 shares)`, rescaled to 1e18 when the share decimals differ.
- `totalSupplyAssets`: the lender claim, `convertToAssets(totalSupply())`.
- `totalDebt`, `totalDebtShares`: the vault's debt total and debt-share total, converted with its debt exchange rate.
- `debtSharesOf`, `debtOf`, `collateralOf`, `collateralValueOf`: the sum over the token ids the account owns in the vault. Collateral is the LP position's full value from the vault's oracle, so `collateralOf` can be that value and `collateralPrice` can be 1e18. Use the full value, not a value that already applies the collateral factor.
- `liquidationThresholdBps`: the collateral factor configured for the position's tokens, converted to basis points.
- `liquidationBonusBps`: the maximum liquidation penalty. Revert's penalty varies with how far under water the position is, so the maximum is the bound `liquidationWithinBonus` must check.
- `realizedLosses`: the cumulative loss written off against lenders after reserves are used, measured as the drop in the lend exchange rate from liquidation shortfalls. Without it, a legitimate loss would trip `sharePriceMonotone`.

### Example mapping: Morpho Blue on a Base fork

Morpho Blue holds many isolated markets in one contract. An adapter wraps one market id. The test reads state with `market(id)`, `position(id, account)` and the market's oracle, after `accrueInterest` brings it up to date.

- `totalSupplyAssets`, `totalSupplyShares`, `totalDebt`, `totalDebtShares`: `totalSupplyAssets`, `totalSupplyShares`, `totalBorrowAssets` and `totalBorrowShares` from `market(id)`.
- `totalAssets`: the market's idle liquidity plus `totalBorrowAssets`. Morpho Blue keeps every market's tokens in one contract, so idle liquidity is `totalSupplyAssets - totalBorrowAssets`. Solvency is then an accounting identity for one market. Check the token balance against all markets that use the same loan token to test the shared pool.
- `supplySharesOf`, `debtSharesOf`, `collateralOf`: `supplyShares`, `borrowShares` and `collateral` from `position(id, account)`.
- `debtOf`: borrow shares converted to assets. Morpho's health check rounds up (`toAssetsUp`). With rounding up, per-account debt can sum to more than `totalBorrowAssets`, so `debtRoundingFavoursProtocol` needs the rounded-down conversion or must be left out.
- `collateralPrice`: the oracle `price()`, which is scaled by 1e36 and adjusted for token decimals. Rescale it to 1e18. `collateralValueOf` is `collateral * price / 1e36`.
- `liquidationThresholdBps`: the market's `lltv` (1e18 = 100%) converted to basis points. `liquidationBonusBps` comes from the liquidation incentive factor, which Morpho derives from `lltv`.
- `sharePrice`: Morpho uses virtual shares (1e6 per asset unit), so the starting price is about 1e12 at 1e18 scale, not 1e18. Use that starting price as the floor.
- `realizedLosses`: the cumulative `badDebtAssets` from `Liquidate` events. Morpho socialises bad debt to suppliers, so `sharePriceMonotone` must exempt it.
- The fork needs a Base RPC URL. Pin the block number so the run is reproducible.

`MorphoBlueAdapter.sol` now implements the Morpho mapping. `MorphoBlueFork.t.sol`
uses canonical Base Morpho at block **53,120,000**, creates an isolated two-actor
market through the real protocol and AdaptiveCurveIRM, drives supply/collateral/
borrow/repay/accrual, checks the kit, and rejects an injected debt mutant. It also
reads and accrues the existing cbBTC/USDC market. Run:

```sh
BASE_MAINNET_RPC=https://mainnet.base.org make morpho-fork
```

Without `BASE_MAINNET_RPC` the fork suite is explicitly **skipped**, not reported
as live proof. The ordinary CI kit job runs the local Guardian mutant tests;
reproduce the fork separately with an archive-capable RPC.

Important limits:

- Market solvency is an accounting identity, not a check of Morpho's shared token
  custody. The fork only claims complete share conservation for its isolated
  market, whose entire actor set it owns.
- `debtOf` uses Morpho's virtual assets/shares and rounds down for the kit's debt
  sum bound. Morpho's own health check rounds up. The generic `liquidatable`
  predicate is not an exact replacement for Morpho health at rounding boundaries.
- `realizedLosses()` deliberately **reverts**: a read-only adapter cannot derive
  cumulative `Liquidate.badDebtAssets` from current storage. For share-price
  monotonicity across bad debt, index those events and construct the kit's
  `SharePriceObservation` with the real cumulative loss. Do not call
  `observeSharePrice` on this adapter or assume zero losses.
- Oracle conversion preserves raw token-unit accounting; collateral valuation
  uses `mulDiv(collateral, price, 1e36)` before any 1e18 price truncation.
- Bonus bps rounds up to avoid understating a fractional incentive. Validate
  liquidation event rounding separately before using it as an exact bound.

The Revert V4Vault adapter remains an optional extension; only its mapping is
provided. Sources: [Morpho interface](https://github.com/morpho-org/morpho-blue/blob/main/src/interfaces/IMorpho.sol),
[share math](https://github.com/morpho-org/morpho-blue/blob/main/src/libraries/SharesMathLib.sol),
[liquidation constants](https://github.com/morpho-org/morpho-blue/blob/main/src/libraries/ConstantsLib.sol),
and [deployments](https://docs.morpho.org/developers/contracts/addresses/).
