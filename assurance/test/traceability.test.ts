/**
 * Unit tests for the audit-finding traceability resolver (src/traceability.ts).
 * Run with: npm test  (node --import tsx --test)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { HARNESS_TESTS, INVARIANT_IDS } from '../src/invariants.js';
import { resolveTraceability, type KnownArtifacts } from '../src/traceability.js';
import type { ContinuousAssurance, Finding, FindingsDoc, Severity } from '../src/findings.js';

const KNOWN: KnownArtifacts = {
  invariantIds: INVARIANT_IDS,
  harnessTests: HARNESS_TESTS,
  exploitIds: new Set(['EXP-01', 'EXP-02']),
};

/** Build a synthetic finding with a partial continuous-assurance block. */
function finding(
  id: string,
  severity: Severity,
  securityRelevant: boolean,
  ca: Partial<ContinuousAssurance>,
): Finding {
  return {
    id,
    title: `Finding ${id}`,
    severity,
    status: 'Acknowledged',
    category: 'Test',
    location: 'src/Vault.sol:1',
    securityRelevant,
    description: '',
    recommendation: '',
    continuousAssurance: {
      invariants: ca.invariants ?? [],
      harnessTests: ca.harnessTests ?? [],
      liveMonitors: ca.liveMonitors ?? [],
      exploitReplays: ca.exploitReplays ?? [],
      rationale: ca.rationale ?? '',
    },
  };
}

/** Wrap findings in a minimal FindingsDoc. */
function doc(findings: Finding[]): FindingsDoc {
  return {
    report: {
      title: 't',
      subject: 's',
      reviewer: 'a',
      reportDate: 'd',
      reviewedCommit: 'c',
      methodology: 'm',
      note: 'n',
    },
    severityScale: [],
    statusScale: [],
    findings,
  };
}

test('a harness-proven, live-monitored finding is fully assured', () => {
  const r = resolveTraceability(
    doc([
      finding('F-1', 'Critical', true, {
        invariants: ['INV-01'],
        harnessTests: ['invariant_solvency'],
        liveMonitors: ['INV-01'],
      }),
    ]),
    KNOWN,
  );
  assert.equal(r.findings[0].tier, 'fully-assured');
  assert.equal(r.findings[0].weight, 1);
  assert.equal(r.summary.coveragePct, 100);
});

test('a live-only finding is monitored-only with half weight', () => {
  const r = resolveTraceability(
    doc([finding('F-2', 'Medium', true, { invariants: ['INV-02'], liveMonitors: ['INV-02'] })]),
    KNOWN,
  );
  assert.equal(r.findings[0].tier, 'monitored-only');
  assert.equal(r.findings[0].weight, 0.5);
  assert.equal(r.summary.coveragePct, 50);
});

test('a harness-only finding is half weight', () => {
  const r = resolveTraceability(
    doc([finding('F-3', 'Low', true, { invariants: ['INV-03'], harnessTests: ['invariant_sharePriceFloor'] })]),
    KNOWN,
  );
  assert.equal(r.findings[0].tier, 'harness-only');
  assert.equal(r.findings[0].weight, 0.5);
});

test('a security-relevant finding with no continuous coverage is a gap', () => {
  const r = resolveTraceability(doc([finding('F-4', 'High', true, {})]), KNOWN);
  assert.equal(r.findings[0].tier, 'gap');
  assert.equal(r.summary.gaps, 1);
  assert.equal(r.summary.coveragePct, 0);
});

test('a non-security-relevant finding is not-applicable and excluded from coverage', () => {
  const r = resolveTraceability(
    doc([
      finding('F-5', 'Gas', false, {}),
      finding('F-6', 'Critical', true, {
        invariants: ['INV-01'],
        harnessTests: ['invariant_solvency'],
        liveMonitors: ['INV-01'],
      }),
    ]),
    KNOWN,
  );
  const gas = r.findings.find((f) => f.id === 'F-5');
  assert.equal(gas?.tier, 'not-applicable');
  // Coverage denominator counts only the one security-relevant finding.
  assert.equal(r.summary.securityRelevant, 1);
  assert.equal(r.summary.coveragePct, 100);
});

test('dangling references are reported, not silently dropped', () => {
  const r = resolveTraceability(
    doc([
      finding('F-7', 'Medium', true, {
        invariants: ['INV-99'],
        harnessTests: ['invariant_doesNotExist'],
        liveMonitors: ['INV-01'],
        exploitReplays: ['EXP-404'],
      }),
    ]),
    KNOWN,
  );
  assert.equal(r.danglingReferences.length, 3);
  assert.ok(r.danglingReferences.some((d) => d.includes('INV-99')));
  assert.ok(r.danglingReferences.some((d) => d.includes('invariant_doesNotExist')));
  assert.ok(r.danglingReferences.some((d) => d.includes('EXP-404')));
});

test('findings are sorted most-severe first', () => {
  const r = resolveTraceability(
    doc([
      finding('LOW', 'Low', true, { liveMonitors: ['INV-01'] }),
      finding('CRIT', 'Critical', true, { liveMonitors: ['INV-01'] }),
      finding('MED', 'Medium', true, { liveMonitors: ['INV-01'] }),
    ]),
    KNOWN,
  );
  assert.deepEqual(
    r.findings.map((f) => f.id),
    ['CRIT', 'MED', 'LOW'],
  );
});

test('weighted coverage blends full and partial findings', () => {
  // One fully assured (1.0) + one monitored-only (0.5) over 2 findings -> 75%.
  const r = resolveTraceability(
    doc([
      finding('A', 'Critical', true, {
        harnessTests: ['invariant_solvency'],
        liveMonitors: ['INV-01'],
      }),
      finding('B', 'Medium', true, { liveMonitors: ['INV-02'] }),
    ]),
    KNOWN,
  );
  assert.equal(r.summary.coveragePct, 75);
});
