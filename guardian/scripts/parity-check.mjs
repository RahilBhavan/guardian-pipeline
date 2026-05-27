#!/usr/bin/env node
/**
 * parity-check.mjs — CI gate for "every harness invariant has an
 * off-chain mirror." Run via `npm run parity` (or in CI directly).
 *
 * Inputs:
 *   - test/invariant/InvariantVault.t.sol      (source of truth: harness)
 *   - guardian/src/evaluator.ts                 (off-chain mirror)
 *
 * Checks:
 *   1. The set of INV-XX ids extracted from harness `@notice` headers
 *      equals the set extracted from evaluator result objects.
 *   2. For each INV-XX id seen, evaluator.ts exports a corresponding
 *      `invXX` function. A missing export means a fuzz-proven property
 *      has no live monitor — fail the build.
 *
 * Exit 0 on parity, exit 1 with a diff on failure.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

const harnessPath = resolve(repoRoot, 'test/invariant/InvariantVault.t.sol');
const evaluatorPath = resolve(repoRoot, 'guardian/src/evaluator.ts');

const harnessSrc = readFileSync(harnessPath, 'utf8');
const evaluatorSrc = readFileSync(evaluatorPath, 'utf8');

// In the harness every invariant_* function is preceded by an `@notice INV-XX`
// docstring line. Match those so we don't have to maintain a hand-written
// pairing table — the harness's own comments are the source of truth.
const harnessIds = new Set(
  Array.from(harnessSrc.matchAll(/\/\/\/\s*@notice\s+(INV-\d{2})\b/g)).map((m) => m[1]),
);
// In evaluator.ts every inv result emits `id: 'INV-XX'`. Same trick: lift
// the IDs out of the result objects themselves.
const evaluatorIds = new Set(
  Array.from(evaluatorSrc.matchAll(/id:\s*'(INV-\d{2})'/g)).map((m) => m[1]),
);
// And every snapshot/delta/event check is exported as `export function invXX`.
const exportedFns = new Set(
  Array.from(evaluatorSrc.matchAll(/export\s+function\s+(inv\d{2})\b/g)).map((m) => m[1]),
);

const missingFromEvaluator = [...harnessIds].filter((id) => !evaluatorIds.has(id)).sort();
const missingFromHarness = [...evaluatorIds].filter((id) => !harnessIds.has(id)).sort();
const expectedExports = new Set([...harnessIds].map((id) => `inv${id.slice(-2)}`));
const missingExports = [...expectedExports].filter((name) => !exportedFns.has(name)).sort();

let ok = true;
if (missingFromEvaluator.length) {
  console.error('FAIL: harness invariants missing in guardian/src/evaluator.ts:');
  for (const id of missingFromEvaluator) console.error(`  - ${id}`);
  ok = false;
}
if (missingFromHarness.length) {
  console.error('FAIL: evaluator invariants missing in test/invariant/InvariantVault.t.sol:');
  for (const id of missingFromHarness) console.error(`  - ${id}`);
  ok = false;
}
if (missingExports.length) {
  console.error('FAIL: evaluator.ts must export the following functions:');
  for (const name of missingExports) console.error(`  - ${name}`);
  ok = false;
}

if (!ok) {
  console.error('\nPARITY CHECK FAILED — fuzz-proven property without a live monitor.');
  process.exit(1);
}

const sorted = [...harnessIds].sort();
console.log(`PARITY OK — ${sorted.length}-of-${sorted.length} mirror: ${sorted.join(', ')}`);
