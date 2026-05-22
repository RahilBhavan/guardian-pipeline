# Vault Security Review

**Auditor:** Meridian Audit Collective *(illustrative)*
**Subject:** `src/Vault.sol` — interest-bearing, over-collateralised lending vault
**Reviewed commit:** `vault-v2`
**Report date:** 2026-05-21
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
| Files reviewed | `src/Vault.sol`, `src/AttackableVault.sol` |
| Out of scope | `src/MockERC20.sol` (test-only token), deployment scripts, off-chain components |
| Solidity | `0.8.24` |
| Dependencies | OpenZeppelin `SafeERC20`, `IERC20`, `ReentrancyGuard` |

The Vault lets lenders deposit a single ERC-20 and receive shares whose value
rises as borrowers pay interest; borrowers post those shares as collateral and
may borrow up to 80% of their value. Debt scales through a `borrowIndex`;
under-water positions are cleared via `liquidate` for a 5% bonus. The accounting
follows the Morpho-style dual-tracked model — the lender side stores
`totalSupplyAssets` directly, the borrow side scales an index — so interest
moves both sides by the same realised amount.

## 2. Methodology

Manual line-by-line review; enumeration of the protocol's safety properties;
rounding-direction analysis of every share/asset conversion; and adversarial
scenario modelling across the access-control, reentrancy, accounting,
liquidation, and economic-design surfaces. No automated fuzzing or formal
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
| [GUA-01](#gua-01--critical) | Critical | Demo insolvency backdoor isolated to a separate contract | Resolved |
| [GUA-02](#gua-02--medium) | Medium | Reentrancy exposure on state-mutating functions | Resolved |
| [GUA-03](#gua-03--high) | High | Full-close repayment could erode the solvency margin by one wei | Resolved |
| [GUA-04](#gua-04--medium) | Medium | Liquidation seizing all collateral must clear the full debt | Resolved |
| [GUA-05](#gua-05--low) | Low | Sustained interest can make a lender redemption exceed idle cash | Acknowledged |
| [GUA-06](#gua-06--informational) | Informational | Share price is immune to direct token donations | Acknowledged |
| [GUA-07](#gua-07--informational) | Informational | A full-close repayment may charge up to one wei above `userDebt()` | Acknowledged |
| [GUA-08](#gua-08--low) | Low | Deeply under-water positions can leave residual bad debt | Acknowledged |

**Distribution:** 1 Critical · 1 High · 2 Medium · 2 Low · 2 Informational.

Each finding below carries a **Continuous Assurance** box: the invariants,
harness tests, live monitors and exploit replays that keep the finding verified
after this report's snapshot date. Those bindings are machine-readable in
[`findings.json`](./findings.json) and resolved by `assurance trace`.

---

## GUA-01 — Critical

### Demo insolvency backdoor isolated to a separate contract

An earlier revision shipped a privileged `attack()` function inside
`src/Vault.sol` that forced the vault insolvent for the live-detection demo.
Auditing a contract that contains its own backdoor is unsound.

**Impact.** Total, immediate insolvency while the function executes.

**Status — Resolved.** `attack()` has been removed from `Vault` entirely and now
lives only in `src/AttackableVault.sol`, a demo-only subclass that is never
deployed to production. The audited `Vault` carries no privileged accounting
path of any kind. `AttackableVault.attack()` additionally reverts on Base
mainnet (`block.chainid == 8453`) as defence-in-depth.

**Recommendation.** Keep the demo breach confined to `AttackableVault` and
deploy only `src/Vault.sol` to production.

> **Continuous Assurance** — invariants `INV-01` · harness `invariant_solvency` ·
> live `INV-01` · replay `EXP-01`. `INV-01` is fuzz-proven against `Vault`
> pre-deploy and monitored every block post-deploy; `EXP-01` replays the
> `AttackableVault` breach to prove the live layer catches an insolvency
> regardless of its cause.

## GUA-02 — Medium

### Reentrancy exposure on state-mutating functions

`deposit`, `withdraw`, `borrow`, `repay` and `liquidate` move ERC-20 value. A
token with transfer hooks (ERC-777-style) would otherwise expose the liquidity
and collateral checks to a reentrant call sequence.

**Status — Resolved.** The contract inherits OpenZeppelin's `ReentrancyGuard`
and all five mutating functions are marked `nonReentrant`.

**Recommendation.** Resolved — retain the `ReentrancyGuard`.

> **Continuous Assurance** — invariants `INV-01` · harness *(none)* · live
> `INV-01` · replay *(none)*. **Monitored-only by design:** the
> `ReentrancyGuard` blocks this class structurally, but the fuzz harness uses a
> non-callback `MockERC20` and cannot reproduce a reentrant sequence, so it is
> *not* proven absent by the harness. It is monitored live — a reentrancy that
> drained value breaks `INV-01` within one block. The traceability map surfaces
> this as **monitored-only**.

## GUA-03 — High

### Full-close repayment could erode the solvency margin by one wei

An earlier revision of `_burnDebt` charged a full repayment the borrower's
nominal `userDebt()`. Because `totalBorrowed()` floors `totalBorrowShares *
borrowIndex`, removing a borrower's shares can drop the floored aggregate by one
wei *more* than the nominal debt — so the vault collected one wei less than debt
actually fell, eroding the solvency margin.

**Impact.** A slow, per-full-repayment leak of the INV-01 solvency buffer.

**Status — Resolved.** The invariant fuzz harness found this within a few
hundred runs — a shrunk deposit/borrow/repay sequence. A full close now charges
the *realised* drop in `totalBorrowed()`, so cash rises by exactly what debt
falls by. The invariant campaign runs with zero solvency violations across
300,000+ calls.

**Recommendation.** Resolved — the realised-drop accounting keeps `INV-01`
exact.

> **Continuous Assurance** — invariants `INV-01` · harness `invariant_solvency` ·
> live `INV-01` · replay *(none)*. This finding was surfaced by the harness
> itself — the pre-deployment layer working as designed. `INV-01` is now both
> fuzz-proven and monitored live so any reintroduction is caught on both sides
> of deployment.

## GUA-04 — Medium

### Liquidation seizing all collateral must clear the full debt

`liquidate` seizes collateral worth the repaid amount plus the liquidation
bonus. Without a guard, a partial repayment could seize a borrower's entire
share balance while leaving debt outstanding — an account with zero collateral
but non-zero debt, i.e. unrecoverable bad debt.

**Status — Resolved.** When the seizure would consume all of the borrower's
shares, `liquidate` reverts with `MustClearDebt` unless the liquidator is
closing the full position.

**Recommendation.** Resolved — the `MustClearDebt` guard makes `INV-06` (no
uncollateralised debt) hold by construction.

> **Continuous Assurance** — invariants `INV-06` · harness
> `invariant_noUncollateralisedDebt` · live `INV-06` · replay `EXP-06`. The
> harness fuzzes liquidation alongside interest accrual; `EXP-06` replays the
> interest-driven liquidation path end to end.

## GUA-05 — Low

### Sustained interest can make a lender redemption exceed idle cash

`withdraw` pays out `shares * totalSupplyAssets / totalSupplyShares` and reverts
with `InsufficientLiquidity` if idle cash cannot cover it. Once interest has
lifted a lender's claim above the un-borrowed cash, a full redemption reverts
until borrowers repay. This is correct behaviour for a lending vault, but a
caller may be surprised; the revert is graceful and corrupts no state.

**Recommendation.** Acknowledged — document that lender redemptions are bounded
by available liquidity, as in any lending market. No code change required.

> **Continuous Assurance** — invariants `INV-01` · harness `invariant_solvency` ·
> live `INV-01` · replay `EXP-04`. The liquidity revert protects `INV-01`: the
> vault never pays out assets it does not hold. `EXP-04` confirms the buffer
> survives a maximal borrow.

## GUA-06 — Informational

### Share price is immune to direct token donations

Anyone can transfer the asset directly to the vault, raising
`token.balanceOf(vault)`. Because `sharePrice` is derived from the stored
`totalSupplyAssets` — not the token balance — a donation cannot move the
shares-to-assets ratio. This structurally prevents the ERC-4626 first-depositor
inflation attack; the donated funds simply enlarge the solvency margin.

**Recommendation.** Acknowledged — no change required. Monitors must treat
`cash >= claims` as a `>=` relation, not equality.

> **Continuous Assurance** — invariants `INV-01`, `INV-04` · harness
> `invariant_solvency`, `invariant_lenderValueFloor` · live `INV-01`, `INV-04` ·
> replay `EXP-02`. `INV-04` and `INV-01` bound the lender side; `EXP-02` replays
> the donation/inflation class and confirms the victim is not diluted.

## GUA-07 — Informational

### A full-close repayment may charge up to one wei above `userDebt()`

Closing a position charges the realised drop in floored `totalBorrowed()`, which
equals `userDebt()` or, by one wei of index rounding, one wei more. A caller
repaying exactly `userDebt()` may therefore transfer one extra wei. This is the
deliberate fix for [GUA-03](#gua-03--high) — charging the realised cost is what
keeps solvency exact.

**Recommendation.** Acknowledged — document that callers should approve a small
surplus when closing a position, as is standard for index-based debt. The
one-wei direction always favours the protocol.

> **Continuous Assurance** — invariants `INV-01` · harness `invariant_solvency` ·
> live `INV-01` · replay *(none)*. The one-wei overshoot exists precisely to
> keep `INV-01` exact; the harness proves the rounding direction never erodes
> the solvency margin across the full invariant campaign.

## GUA-08 — Low

### Deeply under-water positions can leave residual bad debt

If interest pushes a borrower's debt above the *full* value of their collateral,
no rational liquidator will repay it — closing the position would cost more than
the collateral seized. The position then retains both shares and debt
indefinitely. The 80% collateral cap and 5% liquidation bonus incentivise
liquidation well before this point, but an idle, deeply under-water position is
not structurally prevented.

**Recommendation.** Acknowledged — for a production deployment, add a reserve
factor and a bad-debt socialisation path. The debt remains counted in
`totalBorrowed`, so `INV-01` stays well-defined; the residual risk is economic,
not an accounting break.

> **Continuous Assurance** — invariants `INV-01` · harness `invariant_solvency` ·
> live `INV-01` · replay `EXP-06`. Residual bad debt does not break `INV-01` —
> the debt is still counted as an asset — but the live monitor tracks the
> solvency margin so erosion is visible. `EXP-06` exercises the interest-driven
> liquidation path that keeps healthy positions cleared.

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
| **Invariant** | A formal property `INV-01..06` | Definition |
| **Harness test** | `invariant_*` in the Foundry fuzz suite | Every push, pre-deploy |
| **Live monitor** | A check in `guardian/src/evaluator.ts` | Every block, post-deploy |
| **Exploit replay** | An `EXP-*` scenario in `test/exploit/` | Every push, pre-deploy |

A finding is **fully assured** when it is proven by the harness *and* watched by
a live monitor; **monitored-only** (e.g. GUA-02) when live monitoring is the only
continuous layer; and a **gap** when no continuous layer covers it. The
`assurance` engine resolves these bindings, scores them, and fails CI if a
security-relevant finding regresses to a gap. Run `assurance trace` to see the
live traceability matrix, or `assurance report` for the full assurance score.
