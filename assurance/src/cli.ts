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
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INVARIANT_IDS, HARNESS_TESTS } from './invariants.js';
import { loadFindings } from './findings.js';
import { loadExploits, summariseExploits, type ExploitDoc, type ExploitSummary } from './exploits.js';
import {
  resolveTraceability,
  renderTraceabilitySentence,
  renderTraceabilitySummaryMarkdown,
  applyTraceabilityBlockToReadme,
} from './traceability.js';
import {
  ASSURANCE_EXPLOIT_CATALOGUE_BEGIN,
  ASSURANCE_EXPLOIT_CATALOGUE_END,
  ASSURANCE_EXPLOIT_SUMMARY_BEGIN,
  ASSURANCE_EXPLOIT_SUMMARY_END,
  README_EXPLOIT_SUMMARY_BEGIN,
  README_EXPLOIT_SUMMARY_END,
  applyMarkerBlock,
  renderExploitCatalogueTable,
  renderExploitSummarySentence,
} from './exploit-docs.js';
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
  runsArtifactFile: string;
  runForge: boolean;
  markdown: boolean;
  /** Write the traceability sentence into README.md between the markers. */
  updateReadme: boolean;
  /** Verify the README sentence matches the resolver; exit 1 on drift. */
  checkReadme: boolean;
  /** Write the exploit summary + assurance.md catalogue blocks; exit 1 if any drift. */
  updateExploitDocs: boolean;
  /** Verify the exploit summary + assurance.md catalogue blocks match the catalogue. */
  checkExploitDocs: boolean;
}

/** Parse argv into structured options. */
function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    command: 'report',
    minScore: 80,
    coverageFile: join(REPO_ROOT, 'assurance', 'data', 'coverage-summary.txt'),
    runsArtifactFile: join(REPO_ROOT, 'assurance', 'data', 'runs.json'),
    runForge: false,
    markdown: false,
    updateReadme: false,
    checkReadme: false,
    updateExploitDocs: false,
    checkExploitDocs: false,
  };

  const positional = argv.find((a) => !a.startsWith('-'));
  if (positional === 'trace' || positional === 'check' || positional === 'report') {
    opts.command = positional;
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--min-score') opts.minScore = Number(argv[++i]);
    else if (arg === '--coverage') opts.coverageFile = argv[++i];
    else if (arg === '--runs-artifact') opts.runsArtifactFile = argv[++i];
    else if (arg === '--run-forge') opts.runForge = true;
    else if (arg === '--md') opts.markdown = true;
    else if (arg === '--update-readme') opts.updateReadme = true;
    else if (arg === '--check-readme') opts.checkReadme = true;
    else if (arg === '--update-exploit-docs') opts.updateExploitDocs = true;
    else if (arg === '--check-exploit-docs') opts.checkExploitDocs = true;
  }

  return opts;
}

/** Write the per-finding traceability summary alongside the other artifacts. */
function writeTraceabilitySummary(
  repoRoot: string,
  traceability: ReturnType<typeof resolveTraceability>,
  gitShaShort: string | null,
): string {
  const path = join(repoRoot, 'assurance', 'data', 'TRACEABILITY_SUMMARY.md');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderTraceabilitySummaryMarkdown(traceability, gitShaShort));
  return path;
}

/**
 * Ensure the README's traceability block (between the two markers) matches
 * the resolver's current output. With `update=true` the block is rewritten
 * in place; with `update=false` the function returns whether the block is
 * already correct, so the CI gate can flip the build red on drift without
 * silently editing the working tree.
 */
function syncReadmeTraceabilityBlock(
  repoRoot: string,
  traceability: ReturnType<typeof resolveTraceability>,
  update: boolean,
): { matched: boolean; readmePath: string; reason?: string } {
  const readmePath = join(repoRoot, 'README.md');
  if (!existsSync(readmePath)) {
    return { matched: false, readmePath, reason: 'README.md not found at repo root' };
  }
  const before = readFileSync(readmePath, 'utf8');
  const expectedSentence = renderTraceabilitySentence(traceability.summary);
  const result = applyTraceabilityBlockToReadme(before, expectedSentence);
  if (update && before !== result.content) {
    writeFileSync(readmePath, result.content);
  }
  return { matched: result.matched, readmePath, reason: result.reason };
}

/**
 * Sync (or check) the three generator-driven blocks the docs:build pipeline owns:
 *   - README.md  EXPLOIT_SUMMARY (one-line scoreboard)
 *   - docs/assurance.md EXPLOIT_SUMMARY (one-line scoreboard, same body)
 *   - docs/assurance.md EXPLOIT_CATALOGUE (per-scenario table)
 *
 * With `update=true` the blocks are rewritten in place; with `update=false`
 * the function returns the first drift it finds so the CI gate can flip red
 * without silently touching the working tree.
 */
function syncExploitDocBlocks(
  repoRoot: string,
  exploitDoc: ExploitDoc,
  exploitSummary: ExploitSummary,
  update: boolean,
): { matched: boolean; path: string; reason?: string }[] {
  const sentence = renderExploitSummarySentence(exploitSummary);
  const table = renderExploitCatalogueTable(exploitDoc.scenarios);
  const targets = [
    {
      path: join(repoRoot, 'README.md'),
      body: sentence,
      begin: README_EXPLOIT_SUMMARY_BEGIN,
      end: README_EXPLOIT_SUMMARY_END,
    },
    {
      path: join(repoRoot, 'docs', 'assurance.md'),
      body: sentence,
      begin: ASSURANCE_EXPLOIT_SUMMARY_BEGIN,
      end: ASSURANCE_EXPLOIT_SUMMARY_END,
    },
    {
      path: join(repoRoot, 'docs', 'assurance.md'),
      body: table,
      begin: ASSURANCE_EXPLOIT_CATALOGUE_BEGIN,
      end: ASSURANCE_EXPLOIT_CATALOGUE_END,
    },
  ];
  const results: { matched: boolean; path: string; reason?: string }[] = [];
  for (const t of targets) {
    if (!existsSync(t.path)) {
      results.push({ matched: false, path: t.path, reason: `${t.path} not found` });
      continue;
    }
    const before = readFileSync(t.path, 'utf8');
    const r = applyMarkerBlock(before, t.body, t.begin, t.end);
    if (update && before !== r.content) writeFileSync(t.path, r.content);
    results.push({ matched: r.matched, path: t.path, reason: r.reason });
  }
  return results;
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
    console.log('');
    console.log(renderTraceabilitySentence(traceability.summary));

    // Always emit the per-finding summary file so the artifact is present
    // for the CI README-vs-resolver gate even on the `trace` shortcut.
    const sha = gitSha(REPO_ROOT);
    const summaryPath = writeTraceabilitySummary(REPO_ROOT, traceability, sha);
    console.log(`  Artifact: ${summaryPath}`);

    if (opts.updateReadme) {
      const sync = syncReadmeTraceabilityBlock(REPO_ROOT, traceability, true);
      console.log(
        sync.matched
          ? `  README block already in sync: ${sync.readmePath}`
          : `  README block updated: ${sync.readmePath}`,
      );
    }

    if (opts.checkReadme) {
      const sync = syncReadmeTraceabilityBlock(REPO_ROOT, traceability, false);
      if (!sync.matched) {
        console.error(
          `\nREADME traceability sentence is out of date with the resolver.\n` +
            `  Expected: ${renderTraceabilitySentence(traceability.summary)}\n` +
            (sync.reason ? `  Reason:   ${sync.reason}\n` : '') +
            `  Run \`npm run trace -- --update-readme\` to regenerate.\n`,
        );
        process.exitCode = 1;
      } else {
        console.log(`  README block matches resolver output: ${sync.readmePath}`);
      }
    }

    if (opts.updateExploitDocs) {
      const results = syncExploitDocBlocks(REPO_ROOT, exploitDoc, exploitSummary, true);
      for (const r of results) {
        console.log(
          r.matched
            ? `  Exploit block already in sync: ${r.path}`
            : `  Exploit block updated: ${r.path}`,
        );
      }
    }

    if (opts.checkExploitDocs) {
      const results = syncExploitDocBlocks(REPO_ROOT, exploitDoc, exploitSummary, false);
      let drifted = false;
      for (const r of results) {
        if (!r.matched) {
          drifted = true;
          console.error(
            `\nExploit-replay generated block is out of date.\n` +
              `  File:   ${r.path}\n` +
              (r.reason ? `  Reason: ${r.reason}\n` : '') +
              `  Run \`npm run trace -- --update-exploit-docs\` to regenerate.`,
          );
        } else {
          console.log(`  Exploit block matches catalogue: ${r.path}`);
        }
      }
      if (drifted) process.exitCode = 1;
    }

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
    runsArtifactFile: opts.runsArtifactFile,
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

  // Per-finding traceability summary — same artifact the trace shortcut
  // emits, kept in lock-step so CI can run either path.
  const traceabilityPath = writeTraceabilitySummary(REPO_ROOT, traceability, sha);

  console.log(renderConsole(report));
  if (opts.markdown) console.log(renderMarkdown(report));
  console.log(`  Artifacts: ${reportJsonPath}`);
  console.log(`             ${reportMdPath}`);
  console.log(`             ${dashboardPath}`);
  console.log(`             ${traceabilityPath}`);
  console.log('');

  if (opts.updateReadme) {
    const sync = syncReadmeTraceabilityBlock(REPO_ROOT, traceability, true);
    console.log(
      sync.matched
        ? `  README block already in sync: ${sync.readmePath}`
        : `  README block updated: ${sync.readmePath}`,
    );
  }

  if (opts.updateExploitDocs) {
    const results = syncExploitDocBlocks(REPO_ROOT, exploitDoc, exploitSummary, true);
    for (const r of results) {
      console.log(
        r.matched
          ? `  Exploit block already in sync: ${r.path}`
          : `  Exploit block updated: ${r.path}`,
      );
    }
  }

  // `check` enforces the gate; `report` is informational and always exits 0.
  // The README-traceability check is folded into `check` so the assurance CI
  // job fails the build if the README sentence has drifted from the resolver.
  if (opts.command === 'check') {
    const sync = syncReadmeTraceabilityBlock(REPO_ROOT, traceability, false);
    if (!sync.matched) {
      console.error(
        `README traceability sentence is out of date with the resolver.\n` +
          `  Expected: ${renderTraceabilitySentence(traceability.summary)}\n` +
          (sync.reason ? `  Reason:   ${sync.reason}\n` : '') +
          `  Run \`npm run trace -- --update-readme\` to regenerate.`,
      );
      process.exitCode = 1;
    }

    // Same gate for the exploit catalogue / summary blocks: drift means the
    // docs claim a count or table that exploit-replays.json no longer backs.
    const exploitResults = syncExploitDocBlocks(REPO_ROOT, exploitDoc, exploitSummary, false);
    for (const r of exploitResults) {
      if (!r.matched) {
        console.error(
          `Exploit-replay generated block is out of date.\n` +
            `  File:   ${r.path}\n` +
            (r.reason ? `  Reason: ${r.reason}\n` : '') +
            `  Run \`npm run trace -- --update-exploit-docs\` to regenerate.`,
        );
        process.exitCode = 1;
      }
    }

    if (!report.gate.passed) {
      console.error('Assurance gate FAILED.');
      process.exitCode = 1;
    }
  }
}

main().catch((err: unknown) => {
  console.error(`assurance: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
