# Base mainnet position-read benchmark

On 2026-10-26, the public Base RPC read 1,000 Morpho cbBTC/USDC positions in
**2,968 ms p50 / 3,005 ms p95**. At 100 positions: **71 ms p50 / 1,284 ms p95**.
Each size has only five observations; nearest-rank p95 is the maximum, not a
stable tail estimate. The first size includes different cache/rate-limit effects.

This measures on-chain position reads and two subset predicates, **not full
Guardian detection latency**. Discovery, persistence, interest accrual, event
reconciliation and the twelve Guardian Vault predicates are excluded. Morpho has
a different ABI; this does not claim the Guardian fetcher supports Morpho.

- Chain 8453, pinned block **53,120,000**; public RPC `mainnet.base.org`.
- Morpho `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb`.
- cbBTC/USDC market `0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836`.
- The [Morpho API](https://api.morpho.org/graphql) returned 43,027 indexed borrower
  records when the fixture was captured. We read a fixed sample of 1,000 unique
  addresses; 999 had a nonempty position at the pinned historical block. The API
  count is an indexed current count, not a verified historical active count.
- Serial batches of 100 positions, all reads pinned to the same block, with
  `allowFailure: false`. We check that sampled debt shares do not exceed market
  shares and that sampled debt is backed by nonzero collateral. No full-market
  conservation claim is made.

Reproduce after `npm ci --prefix guardian`:

```sh
BASE_MAINNET_RPC=https://mainnet.base.org make benchmark-morpho
```

The committed [actor fixture](../demo/morpho-benchmark-actors.json) and its SHA-256
in [raw results](morpho-benchmark.json) keep the workload reproducible. The command
rewrites the results with your observations; network latency will differ. Refresh
actors only intentionally: `cd guardian && npx tsx scripts/benchmark-morpho.ts --refresh-actors`.
