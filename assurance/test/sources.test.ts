/**
 * Unit tests for the artifact-driven input gatherers (src/sources.ts).
 *
 * Covers the three guarantees from the AMC-from-runs.json migration:
 *
 *   (a) The artifact reader parses a well-formed runs.json and rejects every
 *       malformed shape that would otherwise silently corrupt the score.
 *   (b) A missing runs.json is treated as "no campaign evidence" — Static
 *       Verification stays in the composite but caps at 60 (same shape as
 *       scoreTraceability's uncovered-finding cap).
 *   (c) The composite reacts only to runs.json. Mutating foundry.toml has
 *       zero effect on AMC; swapping in a runs.json from a different
 *       FOUNDRY_PROFILE produces a measurable delta.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  gatherStatic,
  parseCoverageSummary,
  parseInvariantRunsArtifact,
} from '../src/sources.js';
import { scoreStatic } from '../src/score.js';

/** A coverage-summary blob that yields 100% line / 100% branch on Vault.sol. */
const FULL_COVERAGE_SUMMARY = [
  '| File          | % Lines     | % Statements | % Branches  | % Funcs |',
  '|---------------|-------------|--------------|-------------|---------|',
  '| src/Vault.sol | 100.00% (50/50) | 100.00% (60/60) | 100.00% (10/10) | 100.00% (8/8) |',
  '',
].join('\n');

/** Build a self-cleaning temp workspace with the given files. */
function mkWorkspace(files: Record<string, string>): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'assurance-sources-'));
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// --- (a) artifact-reader path -----------------------------------------------

test('parseCoverageSummary preserves existing behaviour', () => {
  const parsed = parseCoverageSummary(FULL_COVERAGE_SUMMARY);
  assert.deepEqual(parsed, { line: 100, branch: 100 });
});

test('parseInvariantRunsArtifact accepts a well-formed CI artifact', () => {
  const text = JSON.stringify({
    runs: 2000,
    depth: 150,
    profile: 'ci',
    totalCalls: 300_000,
    durationSeconds: 42,
  });
  assert.deepEqual(parseInvariantRunsArtifact(text), {
    runs: 2000,
    depth: 150,
    profile: 'ci',
    totalCalls: 300_000,
    durationSeconds: 42,
  });
});

test('parseInvariantRunsArtifact returns null on malformed JSON', () => {
  assert.equal(parseInvariantRunsArtifact('not json at all'), null);
  assert.equal(parseInvariantRunsArtifact('{'), null);
});

test('parseInvariantRunsArtifact returns null when required fields are missing', () => {
  // Missing depth and durationSeconds — would silently default to 0 elsewhere.
  const text = JSON.stringify({ runs: 2000, profile: 'ci', totalCalls: 1 });
  assert.equal(parseInvariantRunsArtifact(text), null);
});

test('parseInvariantRunsArtifact returns null when a field has the wrong type', () => {
  // `runs` as a string is the canonical CI mistake — reject rather than coerce.
  const text = JSON.stringify({
    runs: '2000',
    depth: 150,
    profile: 'ci',
    totalCalls: 300_000,
    durationSeconds: 42,
  });
  assert.equal(parseInvariantRunsArtifact(text), null);
});

test('parseInvariantRunsArtifact rejects nonsensical zero or negative values', () => {
  // A `runs: 0` artifact would multiply to a zero-product fuzz campaign and
  // score 0 intensity — that's worse than "missing", so reject up front.
  const text = JSON.stringify({
    runs: 0,
    depth: 150,
    profile: 'ci',
    totalCalls: 0,
    durationSeconds: 1,
  });
  assert.equal(parseInvariantRunsArtifact(text), null);
});

// --- (b) missing-runs.json failure mode -------------------------------------

test('gatherStatic flags invariantArtifactPresent: false when runs.json is absent', () => {
  const ws = mkWorkspace({
    'coverage-summary.txt': FULL_COVERAGE_SUMMARY,
  });
  try {
    const input = gatherStatic({
      repoRoot: ws.dir,
      coverageFile: join(ws.dir, 'coverage-summary.txt'),
      runsArtifactFile: join(ws.dir, 'runs.json'), // does not exist
      runForge: false,
    });
    assert.equal(input.invariantArtifactPresent, false);
    assert.equal(input.invariantRuns, 0);
    assert.equal(input.invariantDepth, 0);
    // The score component caps at 60, mirroring traceability's gap cap.
    const c = scoreStatic(input);
    assert.ok(c.score <= 60, `expected <= 60, got ${c.score}`);
  } finally {
    ws.cleanup();
  }
});

test('gatherStatic loads runs and depth from runs.json when present', () => {
  const ws = mkWorkspace({
    'coverage-summary.txt': FULL_COVERAGE_SUMMARY,
    'runs.json': JSON.stringify({
      runs: 2000,
      depth: 150,
      profile: 'ci',
      totalCalls: 300_000,
      durationSeconds: 42,
    }),
  });
  try {
    const input = gatherStatic({
      repoRoot: ws.dir,
      coverageFile: join(ws.dir, 'coverage-summary.txt'),
      runsArtifactFile: join(ws.dir, 'runs.json'),
      runForge: false,
    });
    assert.equal(input.invariantArtifactPresent, true);
    assert.equal(input.invariantRuns, 2000);
    assert.equal(input.invariantDepth, 150);
  } finally {
    ws.cleanup();
  }
});

// --- Acceptance: foundry.toml has no effect on AMC --------------------------

test('mutating foundry.toml does not change gatherStatic output', () => {
  const ci = JSON.stringify({
    runs: 2000,
    depth: 150,
    profile: 'ci',
    totalCalls: 300_000,
    durationSeconds: 42,
  });
  const tomlBefore = '[profile.ci.invariant]\nruns = 2000\ndepth = 150\n';
  const tomlAfter = '[profile.ci.invariant]\nruns = 99999\ndepth = 9999\n';

  const ws = mkWorkspace({
    'foundry.toml': tomlBefore,
    'coverage-summary.txt': FULL_COVERAGE_SUMMARY,
    'runs.json': ci,
  });
  try {
    const before = gatherStatic({
      repoRoot: ws.dir,
      coverageFile: join(ws.dir, 'coverage-summary.txt'),
      runsArtifactFile: join(ws.dir, 'runs.json'),
      runForge: false,
    });
    // Mutate ONLY foundry.toml. runs.json (the real artifact) is unchanged.
    writeFileSync(join(ws.dir, 'foundry.toml'), tomlAfter);
    const after = gatherStatic({
      repoRoot: ws.dir,
      coverageFile: join(ws.dir, 'coverage-summary.txt'),
      runsArtifactFile: join(ws.dir, 'runs.json'),
      runForge: false,
    });
    assert.deepEqual(after, before, 'foundry.toml must not be consulted');
    // And the score component is byte-identical too.
    assert.equal(scoreStatic(after).score, scoreStatic(before).score);
  } finally {
    ws.cleanup();
  }
});

// --- Acceptance: changing CI's FOUNDRY_PROFILE moves AMC --------------------

test('swapping runs.json for a deeper profile produces a measurable AMC delta', () => {
  const ciArtifact = JSON.stringify({
    runs: 2000,
    depth: 150,
    profile: 'ci',
    totalCalls: 300_000,
    durationSeconds: 42,
  });
  const deepArtifact = JSON.stringify({
    runs: 10_000,
    depth: 200,
    profile: 'deep',
    totalCalls: 2_000_000,
    durationSeconds: 320,
  });

  const ws = mkWorkspace({
    'coverage-summary.txt': FULL_COVERAGE_SUMMARY,
    'runs.json': ciArtifact,
  });
  try {
    const ciInput = gatherStatic({
      repoRoot: ws.dir,
      coverageFile: join(ws.dir, 'coverage-summary.txt'),
      runsArtifactFile: join(ws.dir, 'runs.json'),
      runForge: false,
    });
    writeFileSync(join(ws.dir, 'runs.json'), deepArtifact);
    const deepInput = gatherStatic({
      repoRoot: ws.dir,
      coverageFile: join(ws.dir, 'coverage-summary.txt'),
      runsArtifactFile: join(ws.dir, 'runs.json'),
      runForge: false,
    });

    const ciScore = scoreStatic(ciInput).score;
    const deepScore = scoreStatic(deepInput).score;

    // The deep profile hits the fuzzIntensity ceiling (runs*depth >= 2M);
    // the CI profile is mid-curve. The delta must be strictly positive.
    assert.ok(deepScore > ciScore, `expected deep (${deepScore}) > ci (${ciScore})`);
    assert.equal(deepScore, 100);
  } finally {
    ws.cleanup();
  }
});
