# Invariant reference

The vault's safety is defined by 6 invariants. Each is asserted by an
`invariant_*` function in `test/invariant/InvariantVault.t.sol`, mirrored in
`guardian/src/evaluator.ts` (`inv01`…`inv06`), and re-checked by the
exploit-replay harness (`test/exploit/`).

**Notation:** `WAD = 1e18` (fixed-point unit); `BPS = 100_00` (basis-point
denominator); `collateralRatio = 80_00` (80%); `liquidationBonus = 5_00` (5%).
`cash` is the vault's own ERC-20 balance; `totalBorrowed = totalBorrowShares ×
borrowIndex / WAD`; `userDebt(u) = userBorrowShares[u] × borrowIndex / WAD`.

**Not every invariant is equally hard to satisfy** — and this document does not
pretend they are. Each invariant below carries a **class**:

- **Fuzz-tensioned** (INV-01, INV-06) — a wrong rounding direction or call
  ordering genuinely breaks it. These are the properties the fuzz campaign
  exists to attack, and INV-01 already caught a real bug (GUA-03).
- **Accounting identity** (INV-02, INV-03) — a share-sum equality that holds
  unless a code path desyncs the two sides of the ledger. The fuzzer's role is
  regression detection.
- **Structural** (INV-04, INV-05) — true by the construction of the contract.
  INV-04 has a non-trivial proof the campaign confirms empirically; INV-05 is a
  one-line tautology kept as a cheap regression check. The fuzzer cannot break
  a structural invariant without a source change.

---

## Testing strategy

Five complementary test tiers ship evidence for these invariants. The CI gate
on each is set so the green badge is a precise, falsifiable claim.

| Tier | Directory | Question it answers | CI gate |
|------|-----------|---------------------|---------|
| Unit | `test/unit/` | Does every individual path behave exactly as specified? | via `coverage` (≥ 85% lines on `Vault.sol`) |
| Parameterized fuzz | `test/fuzz/` | Do the invariants hold under *any* APR / liquidation-bonus parameter pair? | runs with `forge test` |
| Invariant fuzz (Foundry) | `test/invariant/` | Do the six properties survive *any* call sequence? | `invariant-fuzz` (zero `[FAIL]`) |
| Invariant fuzz (Echidna) | `test/echidna/` | Does an independent fuzz engine reach the same conclusion as Foundry? | `make echidna` (skipped locally if binary missing) |
| Exploit replay | `test/exploit/` | Does the vault resist known DeFi exploit classes? | `assurance` (no regression, no `MISSED`) |

The invariant suite drives five handlers (Deposit, Borrow, Warp, Liquidate,
Donation) so a campaign explores meaningful state transitions — including the
ERC-4626 share-inflation vector via direct donations — instead of burning runs
on amounts that trivially revert. The donation handler exists specifically to
prove the donation/inflation attack class is exercised, not just asserted.

Counterexamples shrink to a minimal failing call sequence under
`[FAIL] invariant_<name>()`. For how the tiers run as CI jobs, see
[the CI/CD section in the root README](../README.md#cicd-pipeline).

### Formal verification — a known gap

This repo does **not** ship a Certora or Halmos symbolic proof of the six
invariants. The campaign is empirical: a 2,000-run invariant fuzz on CI plus
256-run parameterized fuzz over the constructor space. A symbolic proof would
close the residual *is there any sequence we missed* question — fuzzing can
only show none of the runs it tried broke the property. The invariants are
deliberately shaped to be Certora/Halmos-compatible (each is an `assertGe` /
`assertEq` over public state with no external side effects), and
`lib/openzeppelin-contracts/lib/halmos-cheatcodes` is already in the
dependency tree. A future iteration can prove INV-01, INV-04, and INV-06
symbolically without a contract rewrite; until then this section documents
the gap honestly.

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
  development — a one-wei full-repay leak, now fixed (review finding GUA-03).
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

## INV-04 · Lender-value floor · *High* · *Structural*

```
totalSupplyAssets ≥ totalSupplyShares
```

The lender share price (`totalSupplyAssets × WAD / totalSupplyShares`) must
never fall below the 1:1 peg — lenders cannot lose nominal principal.

- **Class — structural.** It holds because every share/asset conversion floors
  in the protocol's favour: the first deposit mints shares 1:1, later deposits
  mint `≤ amount`, interest only raises assets, and withdrawal/liquidation
  remove assets and shares in a ratio that preserves the floor. It cannot be
  broken without changing a rounding direction in `deposit`, `withdraw` or
  `liquidate`. The campaign confirms the proof empirically — including with
  `DonationHandler` transferring tokens straight to the vault.
- **Caught by:** `invariant_lenderValueFloor()` · `inv04()` · replay EXP-02.

## INV-05 · Interest-index floor · *Medium* · *Structural*

```
borrowIndex ≥ 1e18
```

The debt-scaling index only ever accrues forward; it can never drop below its
`1e18` starting value. Interest is monotone.

- **Class — structural (true by construction).** `borrowIndex` is initialised
  to `1e18` and `accrue` only ever adds to it. It cannot fall without a source
  change to the accrual maths; the harness keeps it as a cheap regression check.
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
- [assurance.md](assurance.md) — how violations roll up into the Assurance Score.
