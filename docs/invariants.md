# Invariant reference

The vault's safety is defined by 8 invariants. Each is asserted by a
`public view` function in `test/invariant/InvariantVault.t.sol`, mirrored in
`guardian/src/evaluator.ts` (`inv01`…`inv08`), and re-checked by the
exploit-replay harness (`test/exploit/`).

**Notation:** `WAD = 1e18` (fixed-point unit); `BPS = 100_00` (basis-point
denominator); `collateralRatio = 80_00` (80%); `sharePrice` is pegged 1:1 at
`1e18` and never changes.

---

## INV-01 · Solvency · *Critical*

```
totalBorrowed ≤ totalDeposited
```

Outstanding borrows must never exceed deposits — the vault can never be
insolvent.

- **Breaks when:** a privileged or buggy path inflates debt past deposits. The
  demo `attack()` sets `totalBorrowed = totalDeposited + 1` to trigger exactly
  this.
- **Caught by:** `invariant_solvency()` · `inv01()` · replay EXP-01.

## INV-02 · Liquidity buffer · *Critical*

```
tokenBalance(vault) ≥ totalDeposited − totalBorrowed
```

The vault's own ERC-20 balance must always cover its free (non-borrowed)
liquidity.

- **Breaks when:** borrows or withdrawals drain reserves below the free amount.
- **Note:** when the vault is insolvent, `totalDeposited − totalBorrowed`
  underflows and reverts in Solidity; `evaluator.ts` replicates that revert
  semantics so the off-chain check matches the on-chain one exactly.
- **Caught by:** `invariant_liquidityBuffer()` · `inv02()` · replay EXP-04.

## INV-03 · Share price floor · *High*

```
sharePrice ≥ 1e18
```

The share price must never fall below the 1:1 peg — no share devaluation.

- **Breaks when:** a mutating path lowers `sharePrice` below `WAD`.
- **Caught by:** `invariant_sharePriceFloor()` · `inv03()`.

## INV-04 · Share accounting · *High*

```
totalShares = Σ userShares[i]
```

Total share supply must equal the sum of every user's holdings.

- **Bot proxy:** without a per-user event index, `evaluator.ts` checks the
  aggregate mint identity `totalShares = totalDeposited × 1e18 / sharePrice`.
  The Foundry harness does the true per-user sum via
  `DepositHandler.sumUserShares()`.
- **Caught by:** `invariant_shareAccounting()` · `inv04()` · replay EXP-02.

## INV-05 · Collateral cap · *High*

```
∀u: userBorrowed[u] ≤ userShares[u] × sharePrice / 1e18 × collateralRatio / 10000
```

No user may borrow beyond 80% of their collateral value.

- **Bot proxy:** the bot checks the aggregate equivalent
  (`totalBorrowed ≤ totalShares × sharePrice / 1e18 × collateralRatio / 10000`);
  the harness checks every actor.
- **Caught by:** `invariant_collateralCap()` · `inv05()` · replays EXP-03,
  EXP-05.

## INV-06 · No share inflation · *Medium*

```
sharePrice × totalShares / 1e18 ≤ totalDeposited     (or totalShares == 0)
```

The asset value implied by all shares must not exceed actual deposits.

- **Breaks when:** shares are minted without backing deposits.
- **Caught by:** `invariant_noShareInflation()` · `inv06()` · replay EXP-07.

## INV-07 · Non-negative net · *Medium*

```
totalDeposited ≥ totalBorrowed
```

The protocol's net position must never go negative. Equivalent to INV-01 in
practice; tracked separately so a violation reports both IDs.

- **Caught by:** `invariant_nonNegativeNet()` · `inv07()` · replay EXP-01.

## INV-08 · Zero-state consistency · *Low*

```
totalShares == 0  ⇔  totalDeposited == 0
```

Shares and deposits must reach zero together — the vault must never hold one
without the other.

- **Caught by:** `invariant_zeroStateConsistency()` · `inv08()`.

---

## Where each invariant is enforced

| ID | Foundry harness | Guardian bot | Exploit replay |
|----|-----------------|--------------|----------------|
| INV-01 | `invariant_solvency` | `inv01` (exact) | EXP-01 |
| INV-02 | `invariant_liquidityBuffer` | `inv02` (exact) | EXP-04 |
| INV-03 | `invariant_sharePriceFloor` | `inv03` (exact) | — |
| INV-04 | `invariant_shareAccounting` | `inv04` (aggregate proxy) | EXP-02 |
| INV-05 | `invariant_collateralCap` | `inv05` (aggregate proxy) | EXP-03, EXP-05 |
| INV-06 | `invariant_noShareInflation` | `inv06` (exact) | EXP-07 |
| INV-07 | `invariant_nonNegativeNet` | `inv07` (exact) | EXP-01 |
| INV-08 | `invariant_zeroStateConsistency` | `inv08` (exact) | — |

The two aggregate proxies (INV-04, INV-05) are the only place the off-chain
check is weaker than the harness — a known MVP limitation. A per-user event
index would close it; see the `TODO` notes in `evaluator.ts`.

For how violations roll up into the Assurance Score, see
[assurance.md](assurance.md).

---

## Related documents

- [contracts.md](contracts.md) — the in-contract guards that protect each invariant.
- [guardian-bot.md](guardian-bot.md#evaluatorts) — how the bot evaluates them off-chain.
- [testing.md](testing.md) — how the harness and exploit replays exercise them.
- [assurance.md](assurance.md) — how violations roll up into the Assurance Score.
