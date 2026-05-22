# Invariant reference

The vault's safety is defined by 6 invariants. Each is asserted by an
`invariant_*` function in `test/invariant/InvariantVault.t.sol`, mirrored in
`guardian/src/evaluator.ts` (`inv01`…`inv06`), and re-checked by the
exploit-replay harness (`test/exploit/`).

**Notation:** `WAD = 1e18` (fixed-point unit); `BPS = 100_00` (basis-point
denominator); `collateralRatio = 80_00` (80%); `liquidationBonus = 5_00` (5%).
`cash` is the vault's own ERC-20 balance; `totalBorrowed = totalBorrowShares ×
borrowIndex / WAD`; `userDebt(u) = userBorrowShares[u] × borrowIndex / WAD`.
Interest accrual raises `borrowIndex` (borrower debt) and `totalSupplyAssets`
(lender claims) in lock-step, so every invariant below is genuinely *tensioned*
— a wrong rounding direction can break it, which is exactly what the fuzz
campaign exists to rule out.

---

## INV-01 · Protocol solvency · *Critical*

```
cash + totalBorrowed ≥ totalSupplyAssets
```

The assets the vault holds — idle cash plus debt owed to it — must always cover
the claims of its lenders. This is the master safety property.

- **Breaks when:** accrual credits lenders more than borrowers are charged, a
  repayment collects less than debt actually falls, or shares are minted with
  no backing assets. The fuzz harness found exactly the first class during
  development — a one-wei full-repay leak, now fixed (audit finding GUA-03).
- **Caught by:** `invariant_solvency()` · `inv01()` · replay EXP-01.

## INV-02 · Supply-share integrity · *Critical*

```
totalSupplyShares = Σ userSupplyShares[i]
```

The stored total of lender shares must equal the sum of every account's
balance — no share is minted or burned without updating both.

- **Breaks when:** a deposit, withdrawal or liquidation updates one side of the
  share accounting but not the other.
- **Caught by:** `invariant_supplyShareIntegrity()` · `inv02()`.

## INV-03 · Debt-share integrity · *High*

```
totalBorrowShares = Σ userBorrowShares[i]
```

The stored total of borrow shares must equal the sum of every borrower's
balance — the debt-side twin of INV-02.

- **Breaks when:** a borrow, repayment or liquidation mis-accounts borrow
  shares.
- **Caught by:** `invariant_debtShareIntegrity()` · `inv03()`.

## INV-04 · Lender-value floor · *High*

```
totalSupplyAssets ≥ totalSupplyShares
```

The lender share price (`totalSupplyAssets × WAD / totalSupplyShares`) must
never fall below the 1:1 peg — lenders cannot lose nominal principal.

- **Breaks when:** a withdrawal or liquidation removes assets faster than
  shares, or a deposit mints shares above value.
- **Caught by:** `invariant_lenderValueFloor()` · `inv04()` · replay EXP-02.

## INV-05 · Interest-index floor · *Medium*

```
borrowIndex ≥ 1e18
```

The debt-scaling index only ever accrues forward; it can never drop below its
`1e18` starting value. Interest is monotone.

- **Breaks when:** an accrual computes a negative or wrapped index delta.
- **Caught by:** `invariant_interestIndexFloor()` · `inv05()`.

## INV-06 · No uncollateralised debt · *High*

```
∀u: userSupplyShares[u] == 0  ⇒  userDebt(u) == 0
```

An account with zero collateral shares can never carry outstanding debt — the
protocol never accumulates structurally unrecoverable bad debt.

- **Breaks when:** a withdrawal removes all of a borrower's collateral while
  debt is open, or a liquidation seizes every share without clearing the debt.
  Both paths are guarded — `withdraw` re-checks the collateral cap and
  `liquidate` requires a full close before seizing all collateral.
- **Caught by:** `invariant_noUncollateralisedDebt()` · `inv06()` · replays
  EXP-03, EXP-06.

---

## Where each invariant is enforced

| ID | Foundry harness | Guardian bot | Exploit replay |
|----|-----------------|--------------|----------------|
| INV-01 | `invariant_solvency` | `inv01` (exact) | EXP-01 |
| INV-02 | `invariant_supplyShareIntegrity` | `inv02` (exact) | — |
| INV-03 | `invariant_debtShareIntegrity` | `inv03` (exact) | — |
| INV-04 | `invariant_lenderValueFloor` | `inv04` (exact) | EXP-02 |
| INV-05 | `invariant_interestIndexFloor` | `inv05` (exact) | — |
| INV-06 | `invariant_noUncollateralisedDebt` | `inv06` (exact) | EXP-03, EXP-06 |

Every off-chain check is **exact**, not a proxy. INV-02, INV-03 and INV-06 need
per-account state: the bot discovers every account from the vault's `Deposited`,
`Borrowed` and `Liquidated` events and reads each one's on-chain position, so
the off-chain sum is over the same user set the harness iterates. The property
proven pre-deployment is byte-for-byte the property monitored after it.

For how violations roll up into the Assurance Score, see
[assurance.md](assurance.md).

---

## Related documents

- [contracts.md](contracts.md) — the in-contract guards that protect each invariant.
- [guardian-bot.md](guardian-bot.md#evaluatorts) — how the bot evaluates them off-chain.
- [testing.md](testing.md) — how the harness and exploit replays exercise them.
- [assurance.md](assurance.md) — how violations roll up into the Assurance Score.
