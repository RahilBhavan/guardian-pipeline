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
