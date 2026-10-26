# Morpho sampled runtime detection

The selected mainnet target is Morpho Blue's cbBTC/USDC market on Base, core
`0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb`, market
`0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836`.
The reproducible block is **53,120,000**. This is a dedicated Morpho detector,
separate from the twelve Guardian Vault predicates and their Foundry mirror.

```sh
cd guardian && npm ci
# One detector pass, JSON on stdout; exit 2 for a failed accounting check:
BASE_MAINNET_RPC=https://mainnet.base.org npm run morpho
# Five measurements per size, rewrites the committed raw report:
BASE_MAINNET_RPC=https://mainnet.base.org npm run benchmark:morpho-detection
# Opt-in live RPC test, including ephemeral accrual and batch consistency:
BASE_MAINNET_RPC=https://mainnet.base.org node --test --import tsx test/morpho.test.ts
```

Measured 2026-10-26 through the public Base RPC; [raw samples](morpho-detection-benchmark.json):

| Sampled positions | Populated at pinned block | p50 | p95 |
| --- | --- | --- | --- |
| 100 | 100 | 214 ms | 301 ms |
| 1,000 | 999 | 819 ms | 923 ms |

Each sample uses the same `detectMorpho` function as the CLI. Timing includes
pinned block/market reads, serial batches of 100 positions, simulated accrual,
oracle reads, evaluation, risk payload construction and JSON serialization.
Every batch explicitly encodes one `aggregate3` call, so `accrueInterest` and
subsequent reads share ephemeral EVM state. No transaction is sent. Totals and
price must agree between batches; a changed pinned block hash aborts the sample.
The output reports accounting violations separately from liquidatable positions.

Checks: borrow assets do not exceed supply assets; sampled supply and borrow
shares each do not exceed their market totals; simulated accrual reaches the
block timestamp; and fees stay within the protocol maximum. Health observations
use debt rounded up and collateral valuation/LLTV rounded down, following
[Morpho's health calculation](https://github.com/morpho-org/morpho-blue/blob/main/src/Morpho.sol)
and [virtual share math](https://github.com/morpho-org/morpho-blue/blob/main/src/libraries/SharesMathLib.sol).
An unhealthy position is a liquidation opportunity, not a protocol invariant breach.

The 1,000-address fixture and hash are shared with the earlier
[read-load benchmark](morpho-benchmark.md). This fixture samples borrowers, not
all holders. Discovery, database/network delivery, continuous scheduling,
historical loss deltas, all-market token custody and oracle freshness are outside
this measurement. Unsupported checks appear in the JSON as unavailable, never
as passing. Full-holder conservation cannot be inferred from subset bounds.
Five samples give a descriptive p95 (the maximum here), not an SLA; RPC caching,
provider limits and location affect latency. The earlier read-load run used a
different request shape and time, so these figures do not establish a speedup.

This completes a reproducible sampled Morpho detection measurement. It does not
establish the original twelve-predicate Guardian Vault mainnet benchmark or live
hosted monitoring acceptance. Those remain separately tracked in issue #47.
