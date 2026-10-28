# Morpho full-holder detection benchmark

On 2026-10-28, one detection pass over **every one of the 77,611 holders** of
Morpho Blue's cbBTC/USDC market on Base took **11,744 ms p50 / 13,876 ms p95**
end to end, from the first RPC read to the PostgreSQL commit. That is 25 samples
with 0 errors, a range of 10,788–14,148 ms, and the same pinned block in every
sample. At that block, 45,924 of the holders had a non-empty position.

- Chain 8453, pinned block **53,120,000**, public RPC `mainnet.base.org`.
- Morpho `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb`.
- Market `0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836`.
- [Raw samples and summary](morpho-full-benchmark.json); [holder fixture](../demo/morpho-holders.json).

| Stage | p50 | p95 | Range |
| --- | --- | --- | --- |
| End to end | 11,744 ms | 13,876 ms | 10,788–14,148 ms |
| Fetch, accrual and evaluation | 11,735 ms | 13,869 ms | 10,780–14,142 ms |
| PostgreSQL delivery (one transaction) | 7 ms | 9 ms | 6–14 ms |

## Reproduce

```sh
# Disposable local PostgreSQL with the unchanged live migrations. Never a hosted project.
docker run -d --name morpho-bench-pg -e POSTGRES_HOST_AUTH_METHOD=trust \
  -p 127.0.0.1:55432:5432 postgres:17-alpine
until pg_isready -h 127.0.0.1 -p 55432; do sleep 1; done
export PGHOST=127.0.0.1 PGPORT=55432 PGUSER=postgres
psql -v ON_ERROR_STOP=1 -c 'CREATE PUBLICATION supabase_realtime;'
for m in supabase/migrations/*.sql; do psql -v ON_ERROR_STOP=1 -f "$m"; done

cd guardian && npm ci
# 25 samples; rewrites docs/morpho-full-benchmark.json with your observations:
MORPHO_BENCH_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/postgres \
  BASE_MAINNET_RPC=https://mainnet.base.org npm run benchmark:morpho-full
# Optional, about 1.5 hours: regenerate the holder fixture from logs.
npm run discover:morpho-holders
```

The benchmark refuses a non-local database because it deletes and rewrites this
market's rows. `MORPHO_BENCH_SAMPLES` and `MORPHO_BATCH_SIZE` override the
defaults (25 and 4,000). Your latency will differ with location and RPC load.

## What one sample does

Each sample calls `detectMorpho(allHolders, 'complete')` and then `deliverMorpho`,
which is the code in `guardian/src/morpho.ts`:

1. Read the pinned block, the market parameters and the block again at the end.
   If the hash changes, the sample aborts.
2. Make 20 serial `eth_call` requests, each one atomic `aggregate3` of 4,000
   positions. Each call first simulates `accrueInterest`, then reads the market
   totals, the oracle price and the positions. No transaction is sent. Totals
   and price must agree across all batches.
3. Evaluate: liquidity, accrual and fee checks, plus **exact share conservation**.
   The sum of all 77,611 `supplyShares` must equal `totalSupplyShares`, and the
   sum of all `borrowShares` must equal `totalBorrowShares`. Health-risk
   observations are computed separately; they are not alerts.
4. Deliver in one PostgreSQL transaction: one `alerts` row per failed check,
   then the `blocks_checked` row. This is the same write shape as
   `atomicMonitor.ts`. If any insert fails, all of them roll back.

Before each sample, the benchmark deletes this block's rows (untimed). After each
sample, it reads the row back (untimed). Every sample wrote exactly one
`blocks_checked` row with zero violations and zero alerts.

## Holder discovery

`scripts/discover-morpho-holders.ts` scans every `Supply`, `Borrow`,
`SupplyCollateral`, `Withdraw`, `Repay`, `WithdrawCollateral` and `Liquidate`
event for this market from its creation block, **19,326,981**, through block
53,120,000. The script first checks the creation block on chain: the market does
not exist one block earlier. Each event names the position owner (`onBehalf`,
or `borrower` for a liquidation). The holder set is the union of those owners
plus the fee recipient at the pinned block, which is the zero address here.
Fee shares are minted without a `Supply` event.

- 7,540,357 events; per-event counts are in the fixture.
- Every owner in a reducing event also appears in an opening event. The
  script stops if one does not, because that would mean missed logs.
- `holdersSha256` `ca43039f…0751eb` (SHA-256 of the sorted list joined by
  newlines). The `committed holder fixture` unit test checks the hash, sort
  order, uniqueness, market and end block.
- Logs come from Tenderly's keyless public gateway in 1,000-block windows.
  `mainnet.base.org` answered `eth_getLogs` with "request limit reached", and
  publicnode refuses historical logs without a token. The scan sent 40,354
  requests, retries included. It ran for about 80 minutes in two processes,
  resumed from a checkpoint after a rate-limit lockout of about 8 minutes.
  Another endpoint can be used with `BASE_LOGS_RPC`.

Exact conservation on the live snapshot is the end-to-end completeness proof.
A single missing supplier or borrower, or one wrong share, breaks the equality.
Before timing, the benchmark checks this on real data with two mutants.
Dropping the largest supplier fails `MORPHO-SUPPLY-CONSERVATION`. Adding one
borrow share to one borrower fails `MORPHO-BORROW-CONSERVATION`. The unit test
checks the same two mutants offline.

## Measurement checks

- **Limiter:** RPC round trips. One 4,000-position call waited 0.34–1.15 s for
  response headers (a 2.0 MB request plus server execution) and then downloaded
  1.8 MB in under 10 ms. Local ABI decoding took 35–57 ms per call, about 7% of
  a sample. PostgreSQL delivery is under 0.1%.
- **Tuning:** batch size was swept on 27,436 real holders at this block, with
  interleaved runs. 500 positions per call took 9.4–13.7 s, 1,000 took 6.7–9.0 s,
  2,000 took 5.9–6.4 s, 4,000 took 4.3–5.1 s, and 8,000–14,000 took 3.5–4.3 s,
  within noise of 4,000. Batches run serially. Parallel batches were not
  measured and could lower latency if the RPC allows them.
- **Errors:** 0 of 25 samples failed. A failed sample is recorded, not dropped.
- **Did the work happen:** every sample read 77,611 positions at the same block
  hash, passed exact conservation and committed one row that was read back.
- **Environment:** the client machine was busy, with a 1-minute load average of
  83.9–86.5 on 32 cores (recorded per sample). The work is network-bound, so this
  should matter less than RPC location and load. That was not tested.

## Limits

- 25 samples on one machine, one day and one public RPC. The p95 is the
  24th-ranked sample and describes this run. It is not an SLA.
- One historical block, measured repeatedly. RPC-side caching of that block may
  make these numbers lower than live-head latency.
- Discovery is a cached precompute and is not in the timed path. A live monitor
  would add new owners from each new block's logs. That incremental cost was not
  measured.
- Collateral has no market total, so conservation covers supply and borrow
  shares only. Token custody across all Morpho markets, historical loss deltas
  and oracle freshness stay unavailable, as in the
  [sampled benchmark](morpho-detection-benchmark.md).
- This is a dedicated Morpho detector. It is not the twelve Guardian Vault
  predicates, and it is not hosted continuous monitoring.
