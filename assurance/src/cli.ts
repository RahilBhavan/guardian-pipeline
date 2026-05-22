#!/usr/bin/env -S npx tsx
/**
 * cli.ts — the `assurance` command.
 *
 *   assurance report   gather all evidence, compute the score, write artifacts
 *   assurance trace    print the finding traceability matrix only
 *   assurance check    same as report, but exit non-zero if the CI gate fails
 *
 * Flags:
 *   --min-score <n>    CI gate threshold (default 80)
 *   --coverage <path>  pre-generated `forge coverage --report summary` file
 *   --run-forge        run `forge coverage` if no coverage file is present
 *   --md               also print the Markdown report
 *
 * Outputs (under the repo root):
 *   assurance/data/assurance-report.json   full machine-readable report
 *   assurance/data/assurance-report.md     Markdown report
 *   assurance/data/history.jsonl           appended score history
 *   dashboard/src/data/assurance-report.json   bundled for the dashboard
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INVARIANT_IDS, HARNESS_TESTS } from './invariants.js';
import { loadFindings } from './findings.js';
import { loadExploits, summariseExploits } from './exploits.js';
import { resolveTraceability } from './traceability.js';
import { computeScore, scoreExploit, scoreStatic, scoreTraceability } from './score.js';
import { gatherStatic, gitSha } from './sources.js';
import {
  appendHistory,
  buildReport,
  loadHistory,
  renderConsole,
  renderMarkdown,
  type HistoryEntry,
} from './report.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface CliOptions {
  command: 'report' | 'trace' | 'check';
  minScore: number;
  coverageFile: string;
  runForge: boolean;
  markdown: boolean;
}

/** Parse argv into structured options. */
function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    command: 'report',
    minScore: 80,
    coverageFile: join(REPO_ROOT, 'assurance', 'data', 'coverage-summary.txt'),
    runForge: false,
    markdown: false,
  };

  const positional = argv.find((a) => !a.startsWith('-'));
  if (positional === 'trace' || positional === 'check' || positional === 'report') {
    opts.command = positional;
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--min-score') opts.minScore = Number(argv[++i]);
    else if (arg === '--coverage') opts.coverageFile = argv[++i];
    else if (arg === '--run-forge') opts.runForge = true;
    else if (arg === '--md') opts.markdown = true;
  }

  return opts;
}

/** Resolve the review registry and exploit catalogue into a traceability matrix. */
function resolveAll(opts: CliOptions) {
  const findingsDoc = loadFindings(join(REPO_ROOT, 'security-review', 'findings.json'));
  const exploitDoc = loadExploits(join(REPO_ROOT, 'assurance', 'data', 'exploit-replays.json'));
  const exploitSummary = summariseExploits(exploitDoc.scenarios);

  const traceability = resolveTraceability(findingsDoc, {
    invariantIds: INVARIANT_IDS,
    harnessTests: HARNESS_TESTS,
    exploitIds: new Set(exploitDoc.scenarios.map((s) => s.id)),
  });

  return { exploitDoc, exploitSummary, traceability };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const { exploitDoc, exploitSummary, traceability } = resolveAll(opts);

  // `trace` is the lightweight path — traceability matrix only, no score.
  if (opts.command === 'trace') {
    for (const f of traceability.findings) {
      const mark = f.tier === 'gap' ? '✗' : f.tier === 'not-applicable' ? '·' : '✓';
      console.log(
        `${mark} ${f.id.padEnd(8)} ${f.severity.padEnd(14)} ${f.tier.padEnd(16)} ` +
          `inv:${f.layers.invariants} harness:${f.layers.harnessTests} ` +
          `live:${f.layers.liveMonitors} replay:${f.layers.exploitReplays}  ${f.title}`,
      );
    }
    console.log(
      `\n${traceability.summary.fullyAssured}/${traceability.summary.securityRelevant} ` +
        `security-relevant findings fully assured · ${traceability.summary.coveragePct.toFixed(1)}% coverage`,
    );
    if (traceability.danglingReferences.length > 0) {
      console.log('\nDangling references:');
      for (const d of traceability.danglingReferences) console.log(`  ${d}`);
      process.exitCode = 1;
    }
    return;
  }

  // Gather the remaining evidence for the composite score.
  const staticInput = gatherStatic({
    repoRoot: REPO_ROOT,
    coverageFile: opts.coverageFile,
    runForge: opts.runForge,
  });
  const components = [
    scoreStatic(staticInput),
    scoreExploit({
      available: true,
      total: exploitSummary.total,
      prevented: exploitSummary.prevented,
      detected: exploitSummary.detected,
      missed: exploitSummary.missed,
    }),
    scoreTraceability({
      available: true,
      coveragePct: traceability.summary.coveragePct,
      gaps: traceability.summary.gaps,
    }),
  ];
  const score = computeScore(components);

  const sha = gitSha(REPO_ROOT);
  const historyPath = join(REPO_ROOT, 'assurance', 'data', 'history.jsonl');
  const priorHistory = loadHistory(historyPath);

  const report = buildReport({
    gitSha: sha,
    score,
    traceability,
    exploits: { summary: exploitSummary, scenarios: exploitDoc.scenarios },
    history: priorHistory,
    minScore: opts.minScore,
  });

  // Persist this run to the history log, then fold it into the report so the
  // dashboard's trend includes the latest point.
  const entry: HistoryEntry = {
    at: report.generatedAt,
    gitSha: sha,
    overall: score.overall,
    grade: score.grade,
  };
  appendHistory(historyPath, entry);
  report.history = [...priorHistory, entry].slice(-30);

  // Write artifacts: the canonical report, a Markdown copy, and a bundled copy
  // for the dashboard build.
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const reportJsonPath = join(REPO_ROOT, 'assurance', 'data', 'assurance-report.json');
  const reportMdPath = join(REPO_ROOT, 'assurance', 'data', 'assurance-report.md');
  const dashboardPath = join(REPO_ROOT, 'dashboard', 'src', 'data', 'assurance-report.json');

  writeFileSync(reportJsonPath, json);
  writeFileSync(reportMdPath, renderMarkdown(report));
  mkdirSync(dirname(dashboardPath), { recursive: true });
  writeFileSync(dashboardPath, json);

  console.log(renderConsole(report));
  if (opts.markdown) console.log(renderMarkdown(report));
  console.log(`  Artifacts: ${reportJsonPath}`);
  console.log(`             ${reportMdPath}`);
  console.log(`             ${dashboardPath}`);
  console.log('');

  // `check` enforces the gate; `report` is informational and always exits 0.
  if (opts.command === 'check' && !report.gate.passed) {
    console.error('Assurance gate FAILED.');
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(`assurance: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
