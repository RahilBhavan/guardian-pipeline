/**
 * AssuranceScore — the composite Assurance Score and its four component layers.
 *
 * The headline metric of the project: a single 0-100 number quantifying
 * continuous, multi-layered assurance (Bourveau et al. 2024).
 */
import type { AssuranceReport, ScoreComponent } from '../assurance';

/**
 * Score visuals use the single lavender brand accent while the gate passes,
 * and switch to alert red when it fails — Linear's "one chromatic accent"
 * rule, with red reserved as the dashboard's necessary semantic.
 */
function scoreColor(passed: boolean): string {
  return passed ? 'var(--primary)' : 'var(--red)';
}

/** A horizontal score bar for a 0-100 value. */
function ScoreBar({ value, color }: { value: number; color: string }) {
  return (
    <div className="score-bar-track">
      <div className="score-bar-fill" style={{ width: `${Math.min(100, value)}%`, background: color }} />
    </div>
  );
}

/** One component row: label, weight, score, bar, one-line detail. */
function ComponentRow({ component }: { component: ScoreComponent }) {
  const color = component.available ? 'var(--primary)' : 'var(--text-faint)';
  return (
    <div className="score-comp">
      <div className="score-comp-head">
        <span className="score-comp-label">{component.label}</span>
        <span className="score-comp-weight">{Math.round(component.weight * 100)}% weight</span>
        <span className="score-comp-value" style={{ color }}>
          {component.available ? component.score.toFixed(1) : 'n/a'}
        </span>
      </div>
      <ScoreBar value={component.available ? component.score : 0} color={color} />
      <div className="score-comp-detail">{component.detail}</div>
    </div>
  );
}

export function AssuranceScore({ report }: { report: AssuranceReport }) {
  const { score } = report;
  const color = scoreColor(report.gate.passed);
  const generated = new Date(report.generatedAt);

  return (
    <section className="panel assurance-panel">
      <div className="panel-title">Assurance Score · continuous multi-layered verification</div>

      <div className="assurance-hero">
        <div className="score-readout">
          <span className="score-num" style={{ color }}>
            {score.overall}
          </span>
          <span className="score-denom">/100</span>
          <span className="score-grade" style={{ borderColor: color, color }}>
            {score.grade}
          </span>
        </div>
        <div className="score-meta">
          <div>
            Composite of {score.components.filter((c) => c.available).length} of{' '}
            {score.components.length} layers
          </div>
          <div className="score-meta-dim">
            Generated {generated.toISOString().slice(0, 16).replace('T', ' ')} UTC
            {report.gitSha ? ` · ${report.gitSha}` : ''}
          </div>
        </div>
      </div>

      <div className="score-comps">
        {score.components.map((c) => (
          <ComponentRow key={c.key} component={c} />
        ))}
      </div>

      <div className={`gate-strip ${report.gate.passed ? 'gate-pass' : 'gate-fail'}`}>
        <span className="gate-mark">{report.gate.passed ? '✓' : '✗'}</span>
        <span>
          CI gate {report.gate.passed ? 'PASSED' : 'FAILED'} · minimum score {report.gate.minScore}
        </span>
      </div>
    </section>
  );
}
