#!/usr/bin/env node
/**
 * forge-invariant-to-runs-json.mjs — emit the runs.json artifact consumed by
 * the assurance score (assurance/src/sources.ts).
 *
 * Usage:
 *   forge-invariant-to-runs-json.mjs <forge-json-path> <profile> <runs> <depth> <out-path>
 *
 * `<forge-json-path>` is the raw output of `forge test --json`. `<profile>`,
 * `<runs>`, and `<depth>` come from the CI workflow's FOUNDRY_PROFILE — they
 * are passed in explicitly so this script never reads foundry.toml at runtime.
 * That separation enforces the AMC contract: the score reflects the campaign
 * the workflow actually ran, not whatever the local toml currently says.
 *
 * `totalCalls` and `durationSeconds` are summed across every invariant test
 * found in the forge JSON document.
 */
import { readFileSync, writeFileSync } from 'node:fs';

function die(msg, code = 2) {
  process.stderr.write(`forge-invariant-to-runs-json: ${msg}\n`);
  process.exit(code);
}

const [, , forgeJsonPath, profile, runsArg, depthArg, outPath] = process.argv;
if (!forgeJsonPath || !profile || !runsArg || !depthArg || !outPath) {
  die('usage: forge-invariant-to-runs-json.mjs <forge-json> <profile> <runs> <depth> <out>');
}
const runs = Number(runsArg);
const depth = Number(depthArg);
if (!Number.isFinite(runs) || runs <= 0) die(`invalid runs: ${runsArg}`);
if (!Number.isFinite(depth) || depth <= 0) die(`invalid depth: ${depthArg}`);

let raw;
try {
  raw = JSON.parse(readFileSync(forgeJsonPath, 'utf8'));
} catch (err) {
  die(`cannot read forge JSON at ${forgeJsonPath}: ${err.message}`);
}

let totalCalls = 0;
let durationSeconds = 0;

// `forge test --json` keys each test suite by "<path>:<ContractName>". The
// value carries a `duration` ({secs, nanos}) and a `test_results` map; each
// invariant test has a `kind.Invariant.{runs,calls,reverts}` block.
for (const [, suite] of Object.entries(raw ?? {})) {
  if (!suite || typeof suite !== 'object') continue;
  const dur = suite.duration;
  if (dur && typeof dur.secs === 'number') {
    durationSeconds += dur.secs + (typeof dur.nanos === 'number' ? dur.nanos / 1e9 : 0);
  }
  const results = suite.test_results;
  if (!results || typeof results !== 'object') continue;
  for (const [, testResult] of Object.entries(results)) {
    const inv = testResult?.kind?.Invariant;
    if (!inv) continue;
    if (typeof inv.calls === 'number') totalCalls += inv.calls;
  }
}

const artifact = {
  runs,
  depth,
  profile,
  totalCalls,
  durationSeconds: Math.round(durationSeconds * 1000) / 1000,
};

writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
process.stdout.write(`wrote ${outPath}: ${JSON.stringify(artifact)}\n`);
