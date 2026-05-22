# ERRORS.md — Guardian Pipeline

## TypeScript: Vite `tsconfig.node.json` project reference
Failed: A root `tsconfig.json` referencing a `tsconfig.node.json` that had
`"noEmit": true` — `tsc` fails with `TS6310: Referenced project may not
disable emit`.
Worked: Removed the project reference and `tsconfig.node.json` entirely; the
single `tsconfig.json` includes `src` only. Vite loads `vite.config.ts`
through its own esbuild pass, so it does not need to be in the `tsc` graph.
Note: For a plain Vite + React app, a single `tsconfig.json` is simpler and
avoids the composite-project emit constraint.

## TypeScript: viem `PublicClient` from a conditional chain
Failed: `createPublicClient({ chain: cond ? base : baseSepolia, ... })`
annotated as `const client: PublicClient` — `tsc` reports the inferred
chain-specific client is unrelated to `PublicClient` (incompatible `getBlock`
return types from the chain union).
Worked: Widen the chain first — `const chain: Chain = cond ? base :
baseSepolia;` — then build the client from `chain`. The client type is no
longer a chain-specific union and is assignable to `PublicClient`.
Note: When a viem client must satisfy a generic `PublicClient` annotation,
keep the `chain` typed as `Chain`, not as a concrete chain object.

## Foundry: `vm.prank` consumed by a nested read in the same statement
Failed: `vm.prank(actor); v.withdraw(v.userShares(actor));` — the prank applies
to the *next* external call, which is the argument `v.userShares(actor)`, not
`v.withdraw`. `withdraw` then ran as the test contract and reverted with
`InsufficientShares()`.
Worked: Hoist the nested read into a variable first —
`uint256 shares = v.userShares(actor); vm.prank(actor); v.withdraw(shares);`.
Note: `vm.prank` targets the single next *call*. Never put another external
call (even a `view`) between `vm.prank` and the call you meant to prank —
including as an argument expression.

## Solidity: `reference` is a reserved keyword
Failed: A struct field named `reference` — `solc` errors with
`Expected identifier but got reserved keyword 'reference'`.
Worked: Renamed the field (e.g. to `priorIncident`); kept the JSON output key
as the string literal `"reference"` since that is not a Solidity identifier.
Note: `reference` is reserved in Solidity; avoid it for identifiers.

## Solidity: floor-of-sum vs sum-of-floors eroded a solvency invariant
Failed: With debt held as `totalBorrowShares` and a `borrowIndex`, the
aggregate `totalBorrowed()` floors `totalBorrowShares * borrowIndex / 1e18`.
On a *full* repayment that burns a borrower's whole share balance, the floored
aggregate can drop by up to one wei *more* than the borrower's nominal
`userDebt()`. Charging only the nominal debt meant the vault collected one wei
less than debt actually fell — eroding the solvency margin. The invariant fuzz
harness caught it (`INV-01: …844869 < …844870`) within ~70 runs.
Worked: On a full close, charge the *realised* drop in `totalBorrowed()` —
snapshot it before burning the shares, subtract after. Cash then rises by
exactly what the floored aggregate falls by, so INV-01 holds with no drift.
Note: When an aggregate is a floored function of summed per-user shares,
`floor(A) - floor(A - b)` is not `floor(b)` — it can be `floor(b) + 1`. Never
assume per-user and aggregate rounding agree; measure the aggregate delta and
settle against that. This is exactly the class of bug an invariant harness
exists to find — let it.

## TypeScript: viem `multicall` loses its result tuple on a dynamic array
Failed: Building a `multicall` `contracts` array by spreading a dynamically
-sized array (`[...fixed, ...users.flatMap(...)]`) — viem can no longer infer a
typed result tuple, and with `noUncheckedIndexedAccess` every destructured
result is `bigint | undefined`.
Worked: Cast the result once (`as bigint[]`), assert the expected length, then
read cells through a small `(i) => results[i] as bigint` helper.
Note: viem's typed multicall tuple only survives a const-literal `contracts`
array. With a dynamic array, validate the length explicitly and cast — do not
fight the generics.
