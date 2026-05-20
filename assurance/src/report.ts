/**
 * report.ts — assemble and render the assurance report.
 *
 * `buildReport` combines the score, traceability matrix and exploit catalogue
 * into one document. It is serialised to JSON for the dashboard and CI, and
 * rendered to a terminal table and Markdown for humans.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import type { ScoreComponent } from './score.js';
import type { ResolvedFinding, TraceabilitySummary } from './traceability.js';
import type { ExploitScenario, ExploitSummary } from './exploits.js';

/** One historical score snapshot. */
export interface HistoryEntry {
  at: string;
  gitSha: string | null;
  overall: number;
  grade: string;
}

/** A research citation underpinning the assurance approach. */
export interface ResearchCitation {
  citation: string;
  claim: string;
}

/** The CI gate verdict. */
export interface GateVerdict {
  minScore: number;
  passed: boolean;
  reasons: string[];
}

/** The full assurance report. */
export interface AssuranceReport {
  generatedAt: string;
  gitSha: string | null;
  thesis: string;
  research: ResearchCitation[];
  score: {
    overall: number;
    grade: string;
    effectiveWeight: number;
    components: ScoreComponent[];
  };
  traceability: {
    summary: TraceabilitySummary;
    findings: ResolvedFinding[];
    danglingReferences: string[];
  };
  exploits: {
    summary: ExploitSummary;
    scenarios: ExploitScenario[];
  };
  history: HistoryEntry[];
  gate: GateVerdict;
}

const RESEARCH: ResearchCitation[] = [
  {
    citation: 'Bourveau et al. (2024), Decentralized Finance (DeFi) assurance: early evidence',
    claim:
      'Across 8,500+ audit reports, assurance value comes from continuous, multi-layered verification rather than any single technique.',
  },
  {
    citation: 'Landsman et al. (2025), Auditing Smart Contracts',
    claim:
      'Static, point-in-time audits show little empirical evidence of preventing runtime exploits.',
  },
];

const THESIS =
  'The Assurance Score quantifies what the cited papers argue for: continuous, ' +
  'multi-layered verification. Each component is one independent layer — static ' +
  'proof, exploit resistance, live monitoring, and audit traceability — and the ' +
  'composite is the empirical evidence a point-in-time audit cannot provide.';

/** Inputs to assemble a report from. */
export interface BuildReportInput {
  gitSha: string | null;
  score: { overall: number; grade: string; effectiveWeight: number; components: ScoreComponent[] };
  traceability: { summary: TraceabilitySummary; findings: ResolvedFinding[]; danglingReferences: string[] };
  exploits: { summary: ExploitSummary; scenarios: ExploitScenario[] };
  history: HistoryEntry[];
  minScore: number;
}

/** Evaluate the CI gate against the assembled evidence. */
function evaluateGate(input: BuildReportInput): GateVerdict {
  const reasons: string[] = [];

  if (input.score.overall < input.minScore) {
    reasons.push(`Assurance Score ${input.score.overall} is below the ${input.minScore} threshold`);
  }
  if (input.exploits.summary.missed > 0) {
    reasons.push(`${input.exploits.summary.missed} exploit scenario(s) were MISSED — an attack went undetected`);
  }
  if (input.exploits.summary.regressions > 0) {
    reasons.push(`${input.exploits.summary.regressions} exploit scenario(s) regressed from their expected outcome`);
  }
  if (input.traceability.summary.gaps > 0) {
    reasons.push(
      `${input.traceability.summary.gaps} security-relevant audit finding(s) have no continuous coverage`,
    );
  }
  if (input.traceability.danglingReferences.length > 0) {
    reasons.push(
      `${input.traceability.danglingReferences.length} audit finding reference(s) do not resolve to a known artifact`,
    );
  }

  return { minScore: input.minScore, passed: reasons.length === 0, reasons };
}

/** Assemble the full assurance report. */
export function buildReport(input: BuildReportInput): AssuranceReport {
  return {
    generatedAt: new Date().toISOString(),
    gitSha: input.gitSha,
    thesis: THESIS,
    research: RESEARCH,
    score: input.score,
    traceability: input.traceability,
    exploits: input.exploits,
    history: input.history,
    gate: evaluateGate(input),
  };
}

/** Read the score history (JSONL), newest entries last; tolerant of a missing file. */
export function loadHistory(path: string, limit = 30): HistoryEntry[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const entries: HistoryEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as HistoryEntry);
    } catch {
      // Skip a corrupt line rather than failing the whole run.
    }
  }
  return entries.slice(-limit);
}

/** Append one snapshot to the score history (JSONL). */
export function appendHistory(path: string, entry: HistoryEntry): void {
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

// --------------------------------------------------------------------------- //
//                                 Rendering                                  //
// --------------------------------------------------------------------------- //

/** A unicode progress bar for a 0-100 value. */
function bar(value: number, width = 24): string {
  const filled = Math.round((Math.min(100, Math.max(0, value)) / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

const TIER_LABEL: Record<string, string> = {
  'fully-assured': 'fully assured',
  'monitored-only': 'monitored only',
  'harness-only': 'harness only',
  gap: 'GAP',
  'not-applicable': 'n/a',
};

/** Render the report as a terminal-friendly string. */
export function renderConsole(report: AssuranceReport): string {
  const L: string[] = [];
  const { score, traceability, exploits, gate } = report;

  L.push('');
  L.push('  ┌─────────────────────────────────────────────────────────────┐');
  L.push('  │  GUARDIAN PIPELINE · ASSURANCE REPORT                         │');
  L.push('  └─────────────────────────────────────────────────────────────┘');
  L.push('');
  L.push(`  ASSURANCE SCORE   ${score.overall}/100   grade ${score.grade}`);
  L.push(`  ${bar(score.overall, 48)}`);
  L.push('');
  L.push('  Components');
  for (const c of score.components) {
    const val = c.available ? `${c.score.toString().padStart(5)} ` : '  n/a ';
    L.push(`    ${c.label.padEnd(22)} ${val} ${bar(c.available ? c.score : 0, 20)}`);
    L.push(`    ${' '.repeat(22)} ${c.detail}`);
  }
  L.push('');
  L.push(
    `  Audit traceability   ${traceability.summary.fullyAssured}/${traceability.summary.securityRelevant} fully assured` +
      `   ${traceability.summary.coveragePct.toFixed(1)}% coverage`,
  );
  for (const f of traceability.findings) {
    const mark = f.tier === 'gap' ? '✗' : f.tier === 'not-applicable' ? '·' : '✓';
    L.push(
      `    ${mark} ${f.id}  ${f.severity.padEnd(13)} ${TIER_LABEL[f.tier].padEnd(15)} ${f.title}`,
    );
  }
  L.push('');
  L.push(
    `  Exploit replays      ${exploits.summary.prevented} prevented · ` +
      `${exploits.summary.detected} detected · ${exploits.summary.missed} missed`,
  );
  for (const s of exploits.scenarios) {
    L.push(`    ${s.outcome === 'MISSED' ? '✗' : '✓'} ${s.id}  ${s.outcome.padEnd(10)} ${s.name}`);
  }
  L.push('');

  if (traceability.danglingReferences.length > 0) {
    L.push('  ⚠  Dangling references');
    for (const d of traceability.danglingReferences) L.push(`     ${d}`);
    L.push('');
  }

  L.push(`  GATE  (min score ${gate.minScore})   ${gate.passed ? 'PASS ✓' : 'FAIL ✗'}`);
  for (const r of gate.reasons) L.push(`        - ${r}`);
  L.push('');

  return L.join('\n');
}

/** Render the report as a Markdown document. */
export function renderMarkdown(report: AssuranceReport): string {
  const { score, traceability, exploits, gate } = report;
  const M: string[] = [];

  M.push('# Guardian Pipeline — Assurance Report');
  M.push('');
  M.push(`> **Assurance Score: ${score.overall}/100 — grade ${score.grade}**  `);
  M.push(`> Generated ${report.generatedAt}${report.gitSha ? ` · commit \`${report.gitSha}\`` : ''}`);
  M.push('');
  M.push(report.thesis);
  M.push('');

  M.push('## Score components');
  M.push('');
  M.push('| Component | Score | Weight | Detail |');
  M.push('|---|---|---|---|');
  for (const c of score.components) {
    M.push(
      `| ${c.label} | ${c.available ? c.score : 'n/a'} | ${(c.weight * 100).toFixed(0)}% | ${c.detail} |`,
    );
  }
  M.push('');

  M.push('## Audit traceability matrix');
  M.push('');
  M.push(
    `${traceability.summary.fullyAssured}/${traceability.summary.securityRelevant} security-relevant findings fully assured · ` +
      `${traceability.summary.coveragePct.toFixed(1)}% weighted coverage.`,
  );
  M.push('');
  M.push('| Finding | Severity | Coverage | Invariants | Harness | Live | Replays |');
  M.push('|---|---|---|---|---|---|---|');
  for (const f of traceability.findings) {
    M.push(
      `| ${f.id} ${f.title} | ${f.severity} | ${TIER_LABEL[f.tier]} | ` +
        `${f.invariants.join(', ') || '—'} | ${f.layers.harnessTests} | ` +
        `${f.liveMonitors.join(', ') || '—'} | ${f.exploitReplays.join(', ') || '—'} |`,
    );
  }
  M.push('');

  M.push('## Exploit-replay catalogue');
  M.push('');
  M.push(
    `${exploits.summary.prevented} prevented · ${exploits.summary.detected} detected · ` +
      `${exploits.summary.missed} missed — ${exploits.summary.resistancePct.toFixed(1)}% resistance.`,
  );
  M.push('');
  M.push('| Scenario | Exploit class | Outcome | Safety-net invariants |');
  M.push('|---|---|---|---|');
  for (const s of exploits.scenarios) {
    M.push(`| ${s.id} ${s.name} | ${s.exploitClass} | ${s.outcome} | ${s.targetInvariants.join(', ')} |`);
  }
  M.push('');

  M.push('## Research grounding');
  M.push('');
  for (const r of report.research) {
    M.push(`- **${r.citation}** — ${r.claim}`);
  }
  M.push('');

  M.push('## CI gate');
  M.push('');
  M.push(`**${gate.passed ? 'PASS' : 'FAIL'}** against a minimum score of ${gate.minScore}.`);
  if (gate.reasons.length > 0) {
    M.push('');
    for (const r of gate.reasons) M.push(`- ${r}`);
  }
  M.push('');

  return M.join('\n');
}
