import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { deliverMorpho, type detectMorpho } from '../src/morpho.js';

const url = process.env.TEST_DATABASE_URL;
type Report = Awaited<ReturnType<typeof detectMorpho>>;
const market = '0x00000000000000000000000000000000000000000000000000000000000000aa';
function report(violations: Report['results']['violations']): Report {
  return { protocol: 'morpho-blue', market, morpho: '0x0000000000000000000000000000000000000001', block: 7n,
    blockHash: '0x01', timestamp: 1000n, detectionLatencyMs: 12.4,
    results: { checks: violations, violations, liquidatable: [], debtWithoutCollateral: 0, sampledPositions: 1,
      populatedPositions: 1, coverage: 'complete', unavailable: [] } };
}
const breach = { id: 'MORPHO-SUPPLY-CONSERVATION', passed: false, actual: 1n, bound: 2n };

test('Morpho delivery commits alerts and the checked block together, or neither', { skip: !url, timeout: 30000 }, async () => {
  // TEST_DATABASE_URL must be a disposable DB with migrations 0001–0004.
  const pool = new Pool({ connectionString: url });
  const rows = async () => [
    (await pool.query('SELECT invariant_id, actual_value FROM public.alerts WHERE vault=$1', [market])).rows,
    (await pool.query('SELECT block_number, all_passed, latency_ms FROM public.blocks_checked WHERE vault=$1', [market])).rows,
  ];
  try {
    await pool.query(`CREATE FUNCTION fail_morpho_test() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'injected delivery failure'; END $$;
      CREATE TRIGGER fail_morpho_test BEFORE INSERT ON public.blocks_checked
      FOR EACH ROW WHEN (NEW.vault = '${market}') EXECUTE FUNCTION fail_morpho_test();`);
    // The checked-block insert fails AFTER the alert insert: the alert must roll back.
    await assert.rejects(deliverMorpho(pool, report([breach])), /injected delivery failure/);
    assert.deepEqual(await rows(), [[], []]);
    await pool.query('DROP TRIGGER fail_morpho_test ON public.blocks_checked; DROP FUNCTION fail_morpho_test();');
    assert.deepEqual(await deliverMorpho(pool, report([breach])), { alerts: 1, blocks: 1 });
    assert.deepEqual(await rows(), [[{ invariant_id: 'MORPHO-SUPPLY-CONSERVATION', actual_value: '1' }],
      [{ block_number: '7', all_passed: false, latency_ms: 12 }]]);
    // Idempotent replay of the same block writes nothing new.
    assert.deepEqual(await deliverMorpho(pool, report([breach])), { alerts: 0, blocks: 0 });
  } finally {
    await pool.query('DROP TRIGGER IF EXISTS fail_morpho_test ON public.blocks_checked; DROP FUNCTION IF EXISTS fail_morpho_test();');
    await pool.query('DELETE FROM public.alerts WHERE vault=$1', [market]);
    await pool.query('DELETE FROM public.blocks_checked WHERE vault=$1', [market]);
    await pool.end();
  }
});
