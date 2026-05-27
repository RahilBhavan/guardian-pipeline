import {strict as assert} from 'node:assert';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {test} from 'node:test';

// @ts-expect-error — sibling zero-dep .mjs, no .d.ts maintained.
import {parseMetrics} from '../bin/corpus-coverage.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');
const cli = join(here, '..', 'bin', 'corpus-coverage.mjs');

const healthy = readFileSync(join(fixtures, 'forge-invariant-healthy.txt'), 'utf8');

test('parseMetrics: extracts 11 selectors from a healthy run, deduped across invariant tables', () => {
  const rows = parseMetrics(healthy);
  assert.equal(rows.length, 11, 'expected 11 deduped (contract, selector) rows');

  const liquidate = rows.find(
    (r: {contract: string; selector: string; calls: number}) =>
      r.contract === 'LiquidateHandler' && r.selector === 'liquidate',
  );
  assert.ok(liquidate, 'LiquidateHandler.liquidate must be parsed');
  assert.equal(liquidate.calls, 4584);
});

test('parseMetrics: header and separator rows are ignored', () => {
  const rows = parseMetrics(healthy);
  for (const r of rows) {
    assert.notEqual(r.contract, 'Contract', 'header row leaked through parser');
    assert.ok(Number.isFinite(r.calls), `non-numeric calls for ${r.contract}.${r.selector}`);
  }
});

test('parseMetrics: returns [] when no metrics table is present', () => {
  const noTable = readFileSync(join(fixtures, 'forge-invariant-no-metrics.txt'), 'utf8');
  assert.equal(parseMetrics(noTable).length, 0);
});

test('CLI: healthy fixture exits 0 with --min-calls 100', () => {
  const r = spawnSync('node', [cli, join(fixtures, 'forge-invariant-healthy.txt'), '--min-calls', '100'], {encoding: 'utf8'});
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /Corpus coverage OK/);
});

test('CLI: starved fixture exits 1 with --min-calls 100 (gate trips on the inert selector)', () => {
  const r = spawnSync('node', [cli, join(fixtures, 'forge-invariant-starved.txt'), '--min-calls', '100'], {encoding: 'utf8'});
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /Corpus coverage FAILED/);
  assert.match(r.stdout, /LiquidateHandler\.liquidate: 0 calls/);
});

test('CLI: --json emits machine-readable summary with starved selector(s) flagged', () => {
  const r = spawnSync(
    'node',
    [cli, join(fixtures, 'forge-invariant-starved.txt'), '--min-calls', '100', '--json'],
    {encoding: 'utf8'},
  );
  assert.equal(r.status, 1);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.minCalls, 100);
  assert.equal(parsed.starved.length, 1);
  assert.equal(parsed.starved[0].contract, 'LiquidateHandler');
  assert.equal(parsed.starved[0].selector, 'liquidate');
  assert.equal(parsed.starved[0].calls, 0);
});

test('CLI: missing input path exits with usage code 2', () => {
  const r = spawnSync('node', [cli], {encoding: 'utf8'});
  assert.equal(r.status, 2);
});

test('CLI: input without any metrics table exits 2 (parser failure)', () => {
  const r = spawnSync(
    'node',
    [cli, join(fixtures, 'forge-invariant-no-metrics.txt'), '--min-calls', '100'],
    {encoding: 'utf8'},
  );
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no invariant metrics table found/);
});
