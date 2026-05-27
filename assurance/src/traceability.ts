/**
 * traceability.ts — review-finding -> invariant traceability resolver.
 *
 * Resolves every security-review finding against the assurance layers — the
 * formalising invariant, the Foundry harness test, the runtime monitor check,
 * and the exploit replay — and classifies how thoroughly it is covered. This
 * is the mechanism that turns a static, point-in-time review into a finding
 * bound to properties re-verified on every push: instead of "fixed once", each
 * finding maps to a check that re-runs in CI for the life of the repo.
 */
import type { Finding, FindingsDoc, Severity } from './findings.js';
import { SEVERITY_RANK } from './findings.js';

/**
 * How thoroughly a finding is covered. "Runtime monitor" means the property is
 * implemented as a check in guardian/src/evaluator.ts — the deployable monitor
 * — not that a monitor is currently running against a live deployment.
 */
export type CoverageTier =
  | 'fully-assured' // proven by the harness AND covered by the runtime monitor
  | 'monitored-only' // covered by the runtime monitor, not proven by the harness
  | 'harness-only' // proven by the harness, not covered by the runtime monitor
  | 'gap' // security-relevant, but no assurance layer covers it
  | 'not-applicable'; // not a security property (e.g. a gas finding)

/** Per-layer reference counts for one finding. */
export interface LayerCounts {
  invariants: number;
  harnessTests: number;
  liveMonitors: number;
  exploitReplays: number;
}

/** A finding resolved against the continuous-assurance layers. */
export interface ResolvedFinding {
  id: string;
  title: string;
  severity: Severity;
  status: string;
  category: string;
  securityRelevant: boolean;
  tier: CoverageTier;
  /** Coverage weight: 1.0 fully-assured, 0.5 partial, 0 gap/not-applicable. */
  weight: number;
  layers: LayerCounts;
  invariants: string[];
  harnessTests: string[];
  liveMonitors: string[];
  exploitReplays: string[];
  /** Dangling references — IDs that do not resolve to a known artifact. */
  issues: string[];
}

/** Aggregate traceability statistics. */
export interface TraceabilitySummary {
  totalFindings: number;
  securityRelevant: number;
  fullyAssured: number;
  monitoredOnly: number;
  harnessOnly: number;
  gaps: number;
  /** Weighted coverage over security-relevant findings, as a percentage. */
  coveragePct: number;
}

/** The full output of resolving a findings document. */
export interface TraceabilityResult {
  findings: ResolvedFinding[];
  summary: TraceabilitySummary;
  /** Every dangling reference found across all findings. */
  danglingReferences: string[];
}

/** The known-artifact sets a finding's references are validated against. */
export interface KnownArtifacts {
  invariantIds: ReadonlySet<string>;
  harnessTests: ReadonlySet<string>;
  exploitIds: ReadonlySet<string>;
}

/** Classify a finding's coverage tier from its layer counts. */
function classify(securityRelevant: boolean, layers: LayerCounts): { tier: CoverageTier; weight: number } {
  if (!securityRelevant) return { tier: 'not-applicable', weight: 0 };

  const hasHarness = layers.harnessTests > 0;
  const hasMonitor = layers.liveMonitors > 0;

  if (hasHarness && hasMonitor) return { tier: 'fully-assured', weight: 1 };
  if (hasMonitor) return { tier: 'monitored-only', weight: 0.5 };
  if (hasHarness) return { tier: 'harness-only', weight: 0.5 };
  return { tier: 'gap', weight: 0 };
}

/** Resolve one finding, collecting dangling references along the way. */
function resolveFinding(f: Finding, known: KnownArtifacts): ResolvedFinding {
  const ca = f.continuousAssurance;
  const issues: string[] = [];

  for (const id of ca.invariants) {
    if (!known.invariantIds.has(id)) issues.push(`unknown invariant "${id}"`);
  }
  for (const t of ca.harnessTests) {
    if (!known.harnessTests.has(t)) issues.push(`unknown harness test "${t}"`);
  }
  for (const id of ca.liveMonitors) {
    if (!known.invariantIds.has(id)) issues.push(`unknown runtime monitor "${id}"`);
  }
  for (const id of ca.exploitReplays) {
    if (!known.exploitIds.has(id)) issues.push(`unknown exploit replay "${id}"`);
  }

  const layers: LayerCounts = {
    invariants: ca.invariants.length,
    harnessTests: ca.harnessTests.length,
    liveMonitors: ca.liveMonitors.length,
    exploitReplays: ca.exploitReplays.length,
  };

  const { tier, weight } = classify(f.securityRelevant, layers);

  return {
    id: f.id,
    title: f.title,
    severity: f.severity,
    status: f.status,
    category: f.category,
    securityRelevant: f.securityRelevant,
    tier,
    weight,
    layers,
    invariants: ca.invariants,
    harnessTests: ca.harnessTests,
    liveMonitors: ca.liveMonitors,
    exploitReplays: ca.exploitReplays,
    issues,
  };
}

/**
 * Resolve a full findings document into a traceability matrix.
 *
 * @param doc   The loaded security-review registry.
 * @param known The known invariant/harness/exploit identifiers references are
 *              validated against.
 */
export function resolveTraceability(doc: FindingsDoc, known: KnownArtifacts): TraceabilityResult {
  const resolved = doc.findings.map((f) => resolveFinding(f, known));

  // Sort most-severe first for stable, readable output.
  resolved.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  const securityRelevant = resolved.filter((r) => r.securityRelevant);
  const fullyAssured = securityRelevant.filter((r) => r.tier === 'fully-assured').length;
  const monitoredOnly = securityRelevant.filter((r) => r.tier === 'monitored-only').length;
  const harnessOnly = securityRelevant.filter((r) => r.tier === 'harness-only').length;
  const gaps = securityRelevant.filter((r) => r.tier === 'gap').length;

  const weightSum = securityRelevant.reduce((acc, r) => acc + r.weight, 0);
  const coveragePct = securityRelevant.length === 0 ? 0 : (weightSum / securityRelevant.length) * 100;

  const danglingReferences = resolved.flatMap((r) => r.issues.map((i) => `${r.id}: ${i}`));

  return {
    findings: resolved,
    summary: {
      totalFindings: resolved.length,
      securityRelevant: securityRelevant.length,
      fullyAssured,
      monitoredOnly,
      harnessOnly,
      gaps,
      coveragePct,
    },
    danglingReferences,
  };
}

// --------------------------------------------------------------------------- //
//   Rendering — keep the README sentence, the TRACEABILITY_SUMMARY.md
//   artifact, and the CI gate all reading from one shared formatter so a
//   change in tier semantics propagates everywhere at once.
// --------------------------------------------------------------------------- //

/**
 * Markers that bracket the README's generated traceability sentence. They
 * MUST stay exact across updates — the README-vs-resolver CI gate keys on
 * them. Plain HTML comments so they survive Markdown rendering invisibly.
 */
export const README_TRACEABILITY_BEGIN = '<!-- TRACEABILITY_BEGIN -->';
export const README_TRACEABILITY_END = '<!-- TRACEABILITY_END -->';

/**
 * One-line summary of the resolver's tier counts. Both the README block and
 * `TRACEABILITY_SUMMARY.md` embed exactly this string, so byte-for-byte
 * comparison is enough for the CI gate.
 */
export function renderTraceabilitySentence(summary: TraceabilitySummary): string {
  return (
    `**Finding traceability:** ${summary.fullyAssured}/${summary.securityRelevant} ` +
    `security-relevant findings fully assured · ${summary.monitoredOnly} monitored-only · ` +
    `${summary.harnessOnly} harness-only · ${summary.gaps} gap · ` +
    `${summary.coveragePct.toFixed(1)}% weighted coverage.`
  );
}

/** Symbol used in the per-finding table for each coverage tier. */
const TIER_MARK: Record<CoverageTier, string> = {
  'fully-assured': '✓',
  'monitored-only': '◐',
  'harness-only': '◑',
  gap: '✗',
  'not-applicable': '·',
};

/**
 * Render the per-finding traceability matrix as a standalone Markdown
 * document. Emitted as `assurance/data/TRACEABILITY_SUMMARY.md` so CI and
 * humans get the same shape; the sentence at the bottom is the same one
 * pinned into the README block.
 */
export function renderTraceabilitySummaryMarkdown(
  result: TraceabilityResult,
  gitShaShort: string | null,
): string {
  const L: string[] = [];
  L.push('# Finding traceability summary');
  L.push('');
  L.push(
    `> Generated by the assurance CLI from \`security-review/findings.json\`` +
      `${gitShaShort ? ` at commit \`${gitShaShort}\`` : ''}. Do not edit by hand.`,
  );
  L.push('');
  L.push('| ID | Severity | Tier | Inv | Harness | Live | Replay | Title |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const f of result.findings) {
    L.push(
      `| ${TIER_MARK[f.tier]} ${f.id} | ${f.severity} | ${f.tier} | ` +
        `${f.layers.invariants} | ${f.layers.harnessTests} | ${f.layers.liveMonitors} | ` +
        `${f.layers.exploitReplays} | ${f.title.replace(/\|/g, '\\|')} |`,
    );
  }
  L.push('');
  L.push(renderTraceabilitySentence(result.summary));
  L.push('');
  if (result.danglingReferences.length > 0) {
    L.push('## Dangling references');
    L.push('');
    for (const d of result.danglingReferences) L.push(`- ${d}`);
    L.push('');
  }
  return L.join('\n');
}

/** Result of attempting to apply the generated sentence to a README string. */
export interface ReadmePatchResult {
  /** README content after the patch (unchanged if the block already matched). */
  content: string;
  /** True when the existing block already contained the expected sentence. */
  matched: boolean;
  /** Why a mismatch occurred — e.g. "markers missing", "sentence drifted". */
  reason?: string;
}

/**
 * Replace the contents of the README's traceability block with `sentence`.
 * The block is detected by the {@link README_TRACEABILITY_BEGIN} /
 * {@link README_TRACEABILITY_END} markers; missing markers are reported,
 * not silently inserted, so a stray rebase that drops them fails the gate.
 */
export function applyTraceabilityBlockToReadme(
  readme: string,
  sentence: string,
): ReadmePatchResult {
  const beginIdx = readme.indexOf(README_TRACEABILITY_BEGIN);
  const endIdx = readme.indexOf(README_TRACEABILITY_END);
  if (beginIdx < 0 || endIdx < 0 || endIdx < beginIdx) {
    return {
      content: readme,
      matched: false,
      reason: `README is missing the ${README_TRACEABILITY_BEGIN}/${README_TRACEABILITY_END} markers`,
    };
  }

  // Canonical block body: marker, blank line, sentence, blank line, marker.
  const expected =
    `${README_TRACEABILITY_BEGIN}\n\n${sentence}\n\n${README_TRACEABILITY_END}`;
  const actual = readme.slice(beginIdx, endIdx + README_TRACEABILITY_END.length);

  if (actual === expected) {
    return { content: readme, matched: true };
  }

  const next = readme.slice(0, beginIdx) + expected + readme.slice(endIdx + README_TRACEABILITY_END.length);
  return {
    content: next,
    matched: false,
    reason: `README sentence drifted from resolver output`,
  };
}
