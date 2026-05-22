/**
 * TraceabilityMatrix — the review-finding -> continuous-assurance map.
 *
 * Shows every finding from the security review (security-review/findings.json)
 * bound to the invariants, harness tests, runtime-monitor checks and exploit
 * replays that keep it verified — turning a point-in-time review into a finding
 * re-checked on every commit.
 */
import type { CoverageTier, ResolvedFinding } from '../assurance';

const SEVERITY_CLASS: Record<string, string> = {
  Critical: 'sev-critical',
  High: 'sev-high',
  Medium: 'sev-medium',
  Low: 'sev-low',
  Informational: 'sev-info',
  Gas: 'sev-gas',
};

const TIER_META: Record<CoverageTier, { label: string; cls: string }> = {
  'fully-assured': { label: 'Fully assured', cls: 'tier-full' },
  'monitored-only': { label: 'Monitored only', cls: 'tier-partial' },
  'harness-only': { label: 'Harness only', cls: 'tier-partial' },
  gap: { label: 'Gap', cls: 'tier-gap' },
  'not-applicable': { label: 'N/A', cls: 'tier-na' },
};

/** A small count chip for one assurance layer. */
function LayerChip({ label, count }: { label: string; count: number }) {
  return (
    <span className={`layer-chip ${count > 0 ? 'layer-on' : 'layer-off'}`} title={`${count} ${label}`}>
      {label} {count}
    </span>
  );
}

function FindingRow({ finding }: { finding: ResolvedFinding }) {
  const tier = TIER_META[finding.tier];
  return (
    <div className="trace-row">
      <div className="trace-main">
        <span className={`sev-tag ${SEVERITY_CLASS[finding.severity] ?? 'sev-info'}`}>
          {finding.severity}
        </span>
        <span className="trace-id">{finding.id}</span>
        <span className="trace-title">{finding.title}</span>
      </div>
      <div className="trace-side">
        <div className="layer-chips">
          <LayerChip label="inv" count={finding.layers.invariants} />
          <LayerChip label="harness" count={finding.layers.harnessTests} />
          <LayerChip label="live" count={finding.layers.liveMonitors} />
          <LayerChip label="replay" count={finding.layers.exploitReplays} />
        </div>
        <span className={`tier-tag ${tier.cls}`}>{tier.label}</span>
      </div>
    </div>
  );
}

export function TraceabilityMatrix({
  traceability,
}: {
  traceability: AssuranceReportTraceability;
}) {
  const { summary, findings, danglingReferences } = traceability;

  return (
    <section className="panel">
      <div className="panel-title">Finding Traceability · review findings → continuous checks</div>

      <div className="trace-summary">
        <div className="trace-stat">
          <span className="trace-stat-num">{summary.coveragePct.toFixed(0)}%</span>
          <span className="trace-stat-label">weighted coverage</span>
        </div>
        <div className="trace-stat">
          <span className="trace-stat-num">
            {summary.fullyAssured}/{summary.securityRelevant}
          </span>
          <span className="trace-stat-label">fully assured</span>
        </div>
        <div className="trace-stat">
          <span className="trace-stat-num" style={{ color: summary.gaps > 0 ? 'var(--red)' : 'var(--green)' }}>
            {summary.gaps}
          </span>
          <span className="trace-stat-label">coverage gaps</span>
        </div>
      </div>

      <div className="trace-list scrollbar">
        {findings.map((f) => (
          <FindingRow key={f.id} finding={f} />
        ))}
      </div>

      {danglingReferences.length > 0 && (
        <div className="trace-warn">
          ⚠ {danglingReferences.length} dangling reference(s) — a finding points at an artifact that
          no longer exists.
        </div>
      )}
    </section>
  );
}

/** Local alias for the traceability slice of the report. */
type AssuranceReportTraceability = {
  summary: {
    totalFindings: number;
    securityRelevant: number;
    fullyAssured: number;
    monitoredOnly: number;
    harnessOnly: number;
    gaps: number;
    coveragePct: number;
  };
  findings: ResolvedFinding[];
  danglingReferences: string[];
};
