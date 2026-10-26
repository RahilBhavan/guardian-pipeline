import { Pool } from 'pg';
import { checkNextBlock } from '../../src/atomicMonitor.js';
import type { VaultState } from '../../src/types.js';
import { setTimeout as delay } from 'node:timers/promises';
const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
const vault = '0x00000000000000000000000000000000000000ab';
while (true) {
  const result = await checkNextBlock({ pool, vault, deployBlock: 1n, head: 6n,
    fetch: async (block) => {
      if (process.env.CRASH_BLOCK === block.toString()) {
        process.send?.({ locked: block.toString() });
        await new Promise(() => {}); // Parent SIGKILLs us while transaction owns lock.
      }
      return {
        blockNumber: block, blockTimestamp: 1000 + Number(block), cash: 0n,
        totalSupplyAssets: block === 4n ? 1n : 0n, totalSupplyShares: 0n, totalBorrowShares: 0n,
        totalBorrowed: 0n, borrowIndex: 1_000_000_000_000_000_000n,
        borrowRatePerSecond: 0n, collateralRatio: 8000n, lastAccrualTime: BigInt(1000 + Number(block)),
        liquidationBonus: 500n, maxStaleness: 3600n, oracleLastUpdatedAt: 1000n,
        users: [], liquidationEvents: [],
      } satisfies VaultState;
    },
  });
  process.send?.({ result });
  if (result === 'caught-up') break;
  await delay(10);
}
await pool.end();
process.disconnect?.();
