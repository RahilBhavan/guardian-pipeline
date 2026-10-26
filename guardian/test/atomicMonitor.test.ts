import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { Pool } from 'pg';
import { vaultLockKey, checkNextBlock } from '../src/atomicMonitor.js';
import { rowToVaultState } from '../src/stateHistory.js';

const url = process.env.TEST_DATABASE_URL;
function spawnWorker(crash: string): ChildProcess {
  return fork(new URL('./helpers/haWorker.ts', import.meta.url), [], {
    execArgv: ['--import', 'tsx'], env: { ...process.env, CRASH_BLOCK: crash }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
}
function message(child: ChildProcess, matches: (value: unknown) => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('Worker message timeout')); }, 15000);
    const listener = (value: unknown) => { if (matches(value)) { cleanup(); resolve(); } };
    const exit = () => { cleanup(); reject(new Error('Worker exited before message')); };
    function cleanup() { clearTimeout(timer); child.off('message', listener); child.off('exit', exit); }
    child.on('message', listener); child.on('exit', exit);
  });
}

test('advisory key canonicalizes address case', () => {
  assert.equal(vaultLockKey('0xAB'), vaultLockKey('0xab'));
  assert.notEqual(vaultLockKey('0xab'), vaultLockKey('0xac'));
});

test('SIGKILL leader during block 3: standby replays every block, no duplicate writes', { skip: !url, timeout: 30000 }, async () => {
  // TEST_DATABASE_URL must be a disposable DB with migrations 0001–0004.
  const pool = new Pool({ connectionString: url });
  const leader = spawnWorker('3');
  let standby: ChildProcess | undefined;
  try {
    await message(leader, (v) => typeof v === 'object' && v !== null && 'locked' in v);
    standby = spawnWorker('');
    await message(standby, (v) => typeof v === 'object' && v !== null && 'result' in v && v.result === 'standby');
    const done = once(standby, 'exit');
    const dead = once(leader, 'exit');
    leader.kill('SIGKILL');
    await dead;
    const [code] = await done;
    assert.equal(code, 0);
    const { rows } = await pool.query('SELECT block_number FROM public.blocks_checked ORDER BY block_number');
    assert.deepEqual(rows.map((r) => r.block_number), ['1','2','3','4','5','6']);
    assert.equal((await pool.query('SELECT block_number FROM public.vault_state_previous')).rows[0].block_number, '6');
    assert.deepEqual((await pool.query('SELECT invariant_id FROM public.alerts ORDER BY invariant_id')).rows.map((r) => r.invariant_id), ['INV-01', 'INV-07']);
    // Fail AFTER alert/block inserts: the checkpoint error must roll them back.
    await pool.query(`CREATE FUNCTION fail_checkpoint_test() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'injected checkpoint failure'; END $$;
      CREATE TRIGGER fail_checkpoint_test BEFORE UPDATE ON public.vault_state_previous
      FOR EACH ROW EXECUTE FUNCTION fail_checkpoint_test();`);
    try {
      const old = (await pool.query<Parameters<typeof rowToVaultState>[0]>('SELECT * FROM public.vault_state_previous')).rows[0];
      assert.ok(old);
      const snapshot = rowToVaultState(old);
      await assert.rejects(checkNextBlock({ pool, vault: '0x00000000000000000000000000000000000000ab',
        deployBlock: 1n, head: 7n, fetch: async (block) => ({ ...snapshot, blockNumber: block, totalSupplyAssets: 1n }),
      }), /injected checkpoint failure/);
      assert.equal((await pool.query('SELECT count(*) FROM public.blocks_checked WHERE block_number=7')).rows[0].count, '0');
      assert.equal((await pool.query('SELECT count(*) FROM public.alerts WHERE block_number=7')).rows[0].count, '0');
      assert.equal((await pool.query('SELECT block_number FROM public.vault_state_previous')).rows[0].block_number, '6');
    } finally { await pool.query('DROP TRIGGER fail_checkpoint_test ON public.vault_state_previous; DROP FUNCTION fail_checkpoint_test();'); }
  } finally { leader.kill('SIGKILL'); standby?.kill('SIGKILL'); await pool.end(); }
});
