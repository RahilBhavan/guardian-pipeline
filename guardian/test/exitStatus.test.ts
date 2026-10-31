import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRun, EXIT_CODES } from '../src/exitStatus.js';

test('at head with no violation is ok and exits 0', () => {
  assert.equal(classifyRun(100n, 100n, []), 'ok');
  assert.equal(EXIT_CODES.ok, 0);
});

test('a violation at the last checked block is reported distinctly from infra failure', () => {
  assert.equal(classifyRun(100n, 100n, ['INV-11']), 'violation');
  assert.equal(classifyRun(100n, 40n, ['INV-01']), 'violation');
  assert.equal(new Set(Object.values(EXIT_CODES)).size, 4);
  assert.equal(EXIT_CODES.infra, 1);
});

test('no violation but short of head is behind, never ok', () => {
  assert.equal(classifyRun(100n, 99n, []), 'behind');
  assert.equal(classifyRun(100n, undefined, []), 'behind');
});
