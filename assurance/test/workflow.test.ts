/**
 * workflow.test.ts — static asserts on .github/workflows/invariant-ci.yml.
 *
 * The Assurance Score's Static Verification component reads the runs.json
 * artifact written by the invariant-fuzz job. If that wiring breaks — the
 * artifact stops being uploaded, or the assurance job stops needing/downloading
 * it — AMC silently falls back to a 60 cap on every run. These checks make
 * such regressions fail at test time instead.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'invariant-ci.yml');
const WORKFLOW = readFileSync(WORKFLOW_PATH, 'utf8');

/** Extract a single top-level job block (jobs are indented by 2 spaces). */
function extractJob(name: string): string {
  const re = new RegExp(`^ {2}${name}:[\\s\\S]*?(?=^ {2}\\w[\\w-]*:|\\Z)`, 'm');
  const m = WORKFLOW.match(re);
  assert.ok(m, `${name} job block not found in invariant-ci.yml`);
  return m[0];
}

test('invariant-fuzz job emits a runs.json artifact', () => {
  const block = extractJob('invariant-fuzz');
  assert.match(
    block,
    /forge-invariant-to-runs-json\.mjs/,
    'invariant-fuzz must run the parser that produces runs.json',
  );
  assert.match(
    block,
    /name:\s*invariant-runs-json/,
    'invariant-fuzz must upload the artifact under the agreed name',
  );
  assert.match(
    block,
    /assurance\/data\/runs\.json/,
    'invariant-fuzz must write runs.json into assurance/data',
  );
});

test('assurance job depends on invariant-fuzz', () => {
  const block = extractJob('assurance');
  assert.match(
    block,
    /needs:\s*\[[^\]]*invariant-fuzz[^\]]*\]/,
    'assurance.needs must include invariant-fuzz',
  );
});

test('assurance job downloads the invariant-runs-json artifact', () => {
  const block = extractJob('assurance');
  assert.match(
    block,
    /actions\/download-artifact/,
    'assurance must download the runs.json artifact',
  );
  assert.match(
    block,
    /name:\s*invariant-runs-json/,
    'assurance must reference the invariant-runs-json artifact name',
  );
  assert.match(
    block,
    /path:\s*assurance\/data/,
    'artifact must land in assurance/data so gatherStatic finds it',
  );
});

test('the coverage job does not feed AMC fuzz inputs', () => {
  // The coverage job caps fuzz at 25/50 for instrumentation speed. That cap
  // must never be the source of truth for AMC — only the invariant-fuzz job's
  // runs.json is. Smoke check: the coverage job must NOT emit runs.json.
  // YAML comments are allowed to mention runs.json (they document this very
  // rule) — only non-comment lines count as behaviour.
  const block = extractJob('coverage');
  const behaviour = block
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  assert.doesNotMatch(
    behaviour,
    /runs\.json/,
    'coverage job must not emit runs.json — only invariant-fuzz produces the AMC artifact',
  );
});
