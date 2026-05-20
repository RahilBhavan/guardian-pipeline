/**
 * traceability.ts — Feature 1: audit-finding -> invariant traceability resolver.
 *
 * Resolves every audit finding against the four continuous-assurance layers and
 * classifies how thoroughly it is covered. This is the mechanism that turns a
 * static, point-in-time audit (Landsman et al. 2025) into the continuous,
 * multi-layered assurance Bourveau et al. (2024) argue for: a finding is no
 * longer just "fixed once" — it is bound to properties re-verified every push
 * and every block.
 */
import type { Finding, FindingsDoc, Severity } from './findings.js';
import { SEVERITY_RANK } from './findings.js';

/** How thoroughly a finding is covered by continuous assurance. */
export type CoverageTier =
  | 'fully-assured' // proven by the harness AND watched by a live monitor
  | 'monitored-only' // watched live, but not proven by the fuzz harness
  | 'harness-only' // proven pre-deploy, but not monitored live
  | 'gap' // security-relevant, but no continuous layer covers it
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
  const hasLive = layers.liveMonitors > 0;

  if (hasHarness && hasLive) return { tier: 'fully-assured', weight: 1 };
  if (hasLive) return { tier: 'monitored-only', weight: 0.5 };
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
    if (!known.invariantIds.has(id)) issues.push(`unknown live monitor "${id}"`);
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
 * @param doc   The loaded audit registry.
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
