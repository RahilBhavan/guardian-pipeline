/**
 * TraceabilityMatrix — the review-finding -> continuous-assurance map.
 *
 * Shows every finding from the security review (security-review/findings.json)
 * bound to the invariants, harness tests, runtime-monitor checks and exploit
 * replays that keep it verified — turning a point-in-time review into a finding
 * re-checked on every commit.
 */
import type { CoverageTier, ResolvedFinding } from '../assurance';
import { Tip } from './InfoTip';
import { PanelHeader } from './PanelHeader';
import { copy, type CopyKey } from '../content';

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
  const c = copy(`chip:${label}` as CopyKey);
  return (
    <Tip plain={c.plain} technical={c.technical}>
      <span className={`layer-chip ${count > 0 ? 'layer-on' : 'layer-off'}`}>
        {label} {count}
      </span>
    </Tip>
  );
}

function FindingRow({ finding }: { finding: ResolvedFinding }) {
  const tier = TIER_META[finding.tier];
  return (
    <div className="trace-row">
      <div className="trace-main">
        <Tip
          plain={copy(`sev:${finding.severity}` as CopyKey).plain}
          technical={copy(`sev:${finding.severity}` as CopyKey).technical}
        >
          <span className={`sev-tag ${SEVERITY_CLASS[finding.severity] ?? 'sev-info'}`}>
            {finding.severity}
          </span>
        </Tip>
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
        <Tip
          plain={copy(`tier:${finding.tier}` as CopyKey).plain}
          technical={copy(`tier:${finding.tier}` as CopyKey).technical}
        >
          <span className={`tier-tag ${tier.cls}`}>{tier.label}</span>
        </Tip>
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
      <PanelHeader title="Finding Traceability" copyKey="panel:finding-traceability" />

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
