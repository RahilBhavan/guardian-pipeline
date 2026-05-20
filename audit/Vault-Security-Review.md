# Vault Security Review

**Auditor:** Meridian Audit Collective *(illustrative)*
**Subject:** `src/Vault.sol` — over-collateralised single-asset lending vault
**Reviewed commit:** `vault-v1`
**Report date:** 2026-05-10
**Classification:** Public

> **About this document.** This is an *illustrative* audit report produced for the
> Guardian Pipeline. It is deliberately written in the format of a real
> point-in-time security review so the project can demonstrate the central idea
> of [`audit/findings.json`](./findings.json) and the assurance engine: a static
> audit is a snapshot, and the Guardian Pipeline converts each of its
> security-relevant findings into a property that is *continuously* verified —
> by the Foundry fuzz harness before deployment and by the live Guardian bot
> after it. See the [Continuous Assurance Addendum](#continuous-assurance-addendum).

---

## 1. Scope

| Item | Value |
|---|---|
| Files reviewed | `src/Vault.sol` (188 LoC) |
| Out of scope | `src/MockERC20.sol` (test-only token), deployment scripts, off-chain components |
| Solidity | `0.8.24` |
| Dependencies | OpenZeppelin `SafeERC20`, `IERC20` |

The Vault lets users deposit a single ERC-20, receive ERC-4626-style shares, and
borrow up to a fixed fraction (80%) of their share value. Share price is fixed
at `1e18`; there is no interest accrual, no oracle, and no liquidation engine.

## 2. Methodology

Manual line-by-line review; enumeration of the protocol's safety properties;
and adversarial scenario modelling across the access-control, reentrancy,
accounting, and economic-design surfaces. No automated fuzzing or formal
verification was performed as part of *this* review — that is precisely the
limitation the Guardian Pipeline is built to close.

## 3. Severity definitions

| Severity | Definition |
|---|---|
| **Critical** | Direct, unconditional loss of funds or protocol insolvency. |
| **High** | Loss of funds under realistic conditions, or a broken core guarantee. |
| **Medium** | Conditional loss, or a guarantee that holds only under an unstated assumption. |
| **Low** | Minor or latent issue with limited impact under current parameters. |
| **Informational** | No security impact; clarity, dead code, or documentation. |
| **Gas** | Gas optimisation only. |

## 4. Findings summary

| ID | Severity | Title | Status |
|---|---|---|---|
| [GUA-01](#gua-01--critical) | Critical | Privileged `attack()` can force protocol insolvency | Mitigated |
| [GUA-02](#gua-02--medium) | Medium | Reentrancy exposure on state-mutating functions | Resolved |
| [GUA-03](#gua-03--low) | Low | `sharePrice` / `collateralRatio` mutable storage with no setter | Acknowledged |
| [GUA-04](#gua-04--low) | Low | Zero-share deposit possible if `sharePrice` exceeds the amount | Acknowledged |
| [GUA-05](#gua-05--informational) | Informational | `InsufficientLiquidity` guards are provably unreachable | Acknowledged |
| [GUA-06](#gua-06--informational) | Informational | Direct donations desynchronise `tokenBalance` from accounting | Acknowledged |
| [GUA-07](#gua-07--gas) | Gas | `collateralRatio` could be `immutable` | Acknowledged |
| [GUA-08](#gua-08--medium) | Medium | No interest accrual — vault cannot build a bad-debt reserve | Acknowledged |

**Distribution:** 1 Critical · 2 Medium · 2 Low · 2 Informational · 1 Gas.

Each finding below carries a **Continuous Assurance** box: the invariants,
harness tests, live monitors and exploit replays that keep the finding verified
after this report's snapshot date. Those bindings are machine-readable in
[`findings.json`](./findings.json) and resolved by `assurance trace`.

---

## GUA-01 — Critical

### Privileged `attack()` can force protocol insolvency

`Vault.attack()` (lines 183–187), callable by the immutable `attacker` address,
sets `totalBorrowed = totalDeposited + 1` with no transfer or accounting basis.
While it executes, liabilities exceed assets — the vault is insolvent.

```solidity
function attack() external onlyAttacker {
    if (block.chainid == BASE_MAINNET) revert MainnetDisabled();
    totalBorrowed = totalDeposited + 1;
    emit InvariantViolated("INV-01: Solvency", totalBorrowed, totalDeposited);
}
```

**Impact.** Total, immediate insolvency. The function exists only to demonstrate
live detection and the EXP-01 exploit replay.

**Status — Mitigated.** A `block.chainid == BASE_MAINNET` backstop now reverts
the call on Base mainnet, so the backdoor cannot fire if this bytecode ever
reaches production. It remains fully callable on testnets and local chains.

**Recommendation.** The chainid backstop is defence-in-depth, not a fix —
remove `attack()` entirely before any production deployment.

> **Continuous Assurance** — invariants `INV-01`, `INV-07` · harness
> `invariant_solvency`, `invariant_nonNegativeNet` · live `INV-01`, `INV-07` ·
> replay `EXP-01`. A static review can flag `attack()` but cannot guarantee no
> equivalent privileged path is added later. The solvency invariants catch *any*
> state where borrows exceed deposits, within one block, regardless of cause.

## GUA-02 — Medium

### Reentrancy exposure on state-mutating functions

**As raised:** `deposit`, `withdraw`, `borrow` and `repay` performed ERC-20
transfers with no reentrancy protection. The vault was safe **only** because the
configured asset is a standard non-callback ERC-20; a token with transfer hooks
would expose the liquidity and collateral checks to a reentrant call sequence.

**Status — Resolved.** The contract now inherits OpenZeppelin's `ReentrancyGuard`
and all four mutating functions are marked `nonReentrant`, closing the
reentrancy surface for any asset.

**Recommendation.** Resolved — retain the `ReentrancyGuard`.

> **Continuous Assurance** — invariants `INV-02` · harness *(none)* · live
> `INV-02` · replay *(none)*. **Monitored-only by design:** the `ReentrancyGuard`
> now blocks this class structurally, but the fuzz harness uses a non-callback
> `MockERC20` and cannot reproduce a reentrant sequence, so it is *not* proven
> absent by the harness. It is monitored live — a reentrancy that drained the
> liquidity buffer breaks `INV-02` within one block. The traceability map
> surfaces this as **monitored-only**.

## GUA-03 — Low

### `sharePrice` / `collateralRatio` mutable storage with no setter

Both are declared mutable but never written after construction. A reader cannot
tell whether a future upgrade intends them to move, which obscures the security
model around the share-price floor.

**Recommendation.** Make the intent explicit (`immutable` / `constant`) or add
bounded, governed setters.

> **Continuous Assurance** — invariants `INV-03` · harness
> `invariant_sharePriceFloor` · live `INV-03`. If a setter is ever added and
> drives the price below the `1e18` peg, the harness fails pre-deploy and the
> live monitor alerts post-deploy.

## GUA-04 — Low

### Zero-share deposit possible if `sharePrice` exceeds the deposit amount

`deposit` computes `sharesMinted = amount * 1e18 / sharePrice` with no
`require(sharesMinted > 0)`. Unreachable at the current fixed `1e18` price, but
if `sharePrice` ever rises above `amount`, a depositor raises `totalDeposited`
while minting zero shares — gifting value to existing shareholders.

**Recommendation.** Add `require(sharesMinted > 0)` to `deposit`.

> **Continuous Assurance** — invariants `INV-04`, `INV-06` · harness
> `invariant_shareAccounting`, `invariant_noShareInflation` · live `INV-04`,
> `INV-06` · replay `EXP-02`. The ERC-4626 inflation class this belongs to is
> replayed by EXP-02 and bounded by the share-accounting invariants.

## GUA-05 — Informational

### `InsufficientLiquidity` guards are provably unreachable

With `collateralRatio` fixed at 80%, free liquidity always covers any single
user's withdrawable or borrowable value, so the `InsufficientLiquidity` reverts
in `withdraw`/`borrow` never trigger.

**Recommendation.** Keep the guards as defence-in-depth against a future
`collateralRatio` change. Document the unreachability proof.

> **Continuous Assurance** — invariants `INV-02` · harness
> `invariant_liquidityBuffer` · live `INV-02` · replay `EXP-04`. `INV-02` is the
> property these guards exist to uphold; EXP-04 confirms the buffer survives a
> maximal borrow.

## GUA-06 — Informational

### Direct donations desynchronise `tokenBalance` from accounting

Anyone can transfer the asset directly to the vault, raising its balance above
`totalDeposited - totalBorrowed`. Benign for solvency, but `tokenBalance` is not
a faithful proxy for accounting — a monitor equating the two would misreport.

**Recommendation.** Treat `tokenBalance >= free liquidity` as the correct
relation. The Guardian evaluator already uses `>=`.

> **Continuous Assurance** — invariants `INV-02` · harness
> `invariant_liquidityBuffer` · live `INV-02` · replay `EXP-04`. `INV-02` is
> intentionally a `>=` relation, so donations cannot break it.

## GUA-07 — Gas

### `collateralRatio` could be `immutable`

`collateralRatio` is read from storage on every `borrow`/`withdraw` but never
written after construction. Marking it `immutable` replaces the SLOAD with a
code constant.

**Recommendation.** Mark `collateralRatio` `immutable` if no setter is planned.

> **Continuous Assurance** — *none, by design.* This is a gas optimisation, not
> a security property. The traceability tool excludes non-security-relevant
> findings from the coverage denominator so the assurance metric is not inflated
> by unmonitorable items.

## GUA-08 — Medium

### No interest accrual — vault cannot build a bad-debt reserve

`borrow`/`repay` move principal only. `sharePrice` never rises, the protocol
accrues no reserve, and there is no buffer to absorb bad debt if a future change
(an oracle, liquidations) introduces undercollateralised positions.

**Recommendation.** If the vault moves toward production, add an interest model
and a reserve factor.

> **Continuous Assurance** — invariants `INV-01`, `INV-07` · harness
> `invariant_solvency`, `invariant_nonNegativeNet` · live `INV-01`, `INV-07` ·
> replay `EXP-03`. Without a reserve, solvency itself is the only tripwire;
> EXP-03 replays the bad-debt class and confirms the collateral cap holds it off.

---

## Continuous Assurance Addendum

A security audit is a **point-in-time snapshot**. Landsman et al. (2025),
*Auditing Smart Contracts*, find little empirical evidence that static
point-in-time audits prevent runtime exploits — the report above ages the moment
the code, parameters, or deployment context change. Bourveau et al. (2024),
*Decentralized Finance (DeFi) assurance: early evidence*, argue the same data
points toward **continuous, multi-layered assurance**.

The Guardian Pipeline operationalises that conclusion. Every **security-relevant**
finding in this report is bound, in [`findings.json`](./findings.json), to up to
four assurance layers:

| Layer | Mechanism | When |
|---|---|---|
| **Invariant** | A formal property `INV-01..08` | Definition |
| **Harness test** | `invariant_*` in the Foundry fuzz suite | Every push, pre-deploy |
| **Live monitor** | A check in `guardian/src/evaluator.ts` | Every block, post-deploy |
| **Exploit replay** | An `EXP-*` scenario in `test/exploit/` | Every push, pre-deploy |

A finding is **fully assured** when it is proven by the harness *and* watched by
a live monitor; **monitored-only** (e.g. GUA-02) when live monitoring is the only
continuous layer; and a **gap** when no continuous layer covers it. The
`assurance` engine resolves these bindings, scores them, and fails CI if a
security-relevant finding regresses to a gap. Run `assurance trace` to see the
live traceability matrix, or `assurance report` for the full assurance score.
