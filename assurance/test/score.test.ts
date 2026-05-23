/**
 * Unit tests for the Assurance Score engine (src/score.ts).
 * Run with: npm test  (node --import tsx --test)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeScore,
  fuzzIntensity,
  gradeFor,
  scoreExploit,
  scoreStatic,
  scoreTraceability,
  WEIGHTS,
} from '../src/score.js';

test('component weights sum to 1', () => {
  const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(Math.round(sum * 100) / 100, 1);
});

test('fuzzIntensity is 0 below the floor and 100 at/above the target', () => {
  assert.equal(fuzzIntensity(5_000), 0);
  assert.equal(fuzzIntensity(10_000), 0);
  assert.equal(fuzzIntensity(2_000_000), 100);
  assert.equal(fuzzIntensity(10_000_000), 100);
});

test('fuzzIntensity is monotonic and bounded in between', () => {
  const mid = fuzzIntensity(300_000); // the CI profile: 2000 x 150
  assert.ok(mid > 0 && mid < 100);
  assert.ok(fuzzIntensity(1_000_000) > mid);
});

test('gradeFor maps the boundary scores correctly', () => {
  assert.equal(gradeFor(100), 'A+');
  assert.equal(gradeFor(97), 'A+');
  assert.equal(gradeFor(93), 'A');
  assert.equal(gradeFor(90), 'A-');
  assert.equal(gradeFor(83), 'B');
  assert.equal(gradeFor(80), 'B-');
  assert.equal(gradeFor(70), 'C-');
  assert.equal(gradeFor(65), 'D');
  assert.equal(gradeFor(40), 'F');
});

test('scoreStatic rewards full coverage and a deep fuzz campaign', () => {
  const c = scoreStatic({
    available: true,
    vaultLineCoverage: 100,
    vaultBranchCoverage: 100,
    invariantRuns: 10_000,
    invariantDepth: 200,
  });
  assert.equal(c.available, true);
  assert.equal(c.score, 100); // 0.7*100 + 0.3*100
});

test('scoreStatic is unavailable when coverage was not gathered', () => {
  const c = scoreStatic({
    available: false,
    vaultLineCoverage: 0,
    vaultBranchCoverage: 0,
    invariantRuns: 2000,
    invariantDepth: 150,
  });
  assert.equal(c.available, false);
});

test('scoreExploit is 100 when every exploit class is resisted', () => {
  const c = scoreExploit({ available: true, total: 7, prevented: 6, detected: 1, missed: 0 });
  assert.equal(c.score, 100);
  assert.equal(c.available, true);
});

test('scoreExploit caps at 50 when any scenario is MISSED', () => {
  // 9 of 10 resisted would be 90%, but a single MISS caps the component.
  const c = scoreExploit({ available: true, total: 10, prevented: 8, detected: 1, missed: 1 });
  assert.ok(c.score <= 50);
});

test('scoreExploit is unavailable when the catalogue is empty', () => {
  const c = scoreExploit({ available: true, total: 0, prevented: 0, detected: 0, missed: 0 });
  assert.equal(c.available, false);
});

test('scoreTraceability caps at 60 when a security-relevant gap exists', () => {
  const withGap = scoreTraceability({ available: true, coveragePct: 95, gaps: 1 });
  assert.ok(withGap.score <= 60);

  const clean = scoreTraceability({ available: true, coveragePct: 95, gaps: 0 });
  assert.equal(clean.score, 95);
});

test('computeScore re-normalises weights when a component is unavailable', () => {
  const components = [
    scoreStatic({
      available: false,
      vaultLineCoverage: 0,
      vaultBranchCoverage: 0,
      invariantRuns: 2000,
      invariantDepth: 150,
    }),
    scoreExploit({ available: true, total: 4, prevented: 4, detected: 0, missed: 0 }),
    scoreTraceability({ available: true, coveragePct: 100, gaps: 0 }),
  ];
  const score = computeScore(components);
  // Both available components score 100, so the composite is 100 even though
  // Static Verification (weight 0.45) was dropped.
  assert.equal(score.overall, 100);
  assert.equal(score.grade, 'A+');
  // effectiveWeight = exploitResistance (0.35) + findingTraceability (0.20),
  // reported to one decimal place.
  assert.equal(score.effectiveWeight, 0.6);
});

test('computeScore is 0 when no component is available', () => {
  const components = [
    scoreExploit({ available: true, total: 0, prevented: 0, detected: 0, missed: 0 }),
  ];
  const score = computeScore(components);
  assert.equal(score.overall, 0);
  assert.equal(score.grade, 'F');
});
