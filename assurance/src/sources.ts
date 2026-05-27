/**
 * sources.ts — gather the real inputs that feed the Assurance Score.
 *
 * Each gatherer degrades gracefully: if a data source cannot be reached it
 * returns `available: false` (drops the component) or, for the fuzz artifact,
 * `invariantArtifactPresent: false` (component is included but capped at 60).
 * The score therefore always reflects only evidence that was actually
 * collected — never inferred from local configuration files.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import type { StaticInput } from './score.js';

/** Run a command, returning its stdout, or `null` if it fails. */
function tryExec(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): string | null {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env ?? process.env,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/** The short git SHA of the working tree, or `null` outside a repo. */
export function gitSha(repoRoot: string): string | null {
  const out = tryExec('git', ['rev-parse', '--short', 'HEAD'], repoRoot);
  return out ? out.trim() : null;
}

/**
 * Parse a `forge coverage --report summary` table for the src/Vault.sol row.
 * The row's percentage columns are, in order: Lines, Statements, Branches, Funcs.
 */
export function parseCoverageSummary(summary: string): { line: number; branch: number } | null {
  const row = summary.split('\n').find((l) => l.includes('src/Vault.sol'));
  if (!row) return null;
  const pcts = [...row.matchAll(/(\d+(?:\.\d+)?)%/g)].map((m) => Number(m[1]));
  if (pcts.length < 3) return null;
  return { line: pcts[0], branch: pcts[2] };
}

/**
 * Schema of the runs.json artifact emitted by the invariant-fuzz CI job.
 *
 * `runs` and `depth` are the active Foundry profile values at the time the
 * heavy fuzz campaign ran in CI. `profile` is the FOUNDRY_PROFILE name the
 * workflow used. `totalCalls` and `durationSeconds` are summed across the
 * InvariantVault test suite, parsed from `forge test --json`.
 *
 * Why foundry.toml is no longer the source of truth: editing the local
 * foundry.toml does not change what CI actually ran, so AMC must reflect the
 * artifact from a real campaign rather than the developer's local config.
 */
export interface InvariantRunsArtifact {
  runs: number;
  depth: number;
  profile: string;
  totalCalls: number;
  durationSeconds: number;
}

/**
 * Parse the runs.json artifact written by the invariant-fuzz CI job. Returns
 * `null` on any malformed input — callers treat that exactly the same as a
 * missing file (Static Verification caps at 60).
 */
export function parseInvariantRunsArtifact(text: string): InvariantRunsArtifact | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const { runs, depth, profile, totalCalls, durationSeconds } = obj;
  if (
    typeof runs !== 'number' ||
    typeof depth !== 'number' ||
    typeof profile !== 'string' ||
    typeof totalCalls !== 'number' ||
    typeof durationSeconds !== 'number'
  ) {
    return null;
  }
  if (runs <= 0 || depth <= 0) return null;
  return { runs, depth, profile, totalCalls, durationSeconds };
}

/** Options controlling how Static Verification inputs are gathered. */
export interface StaticOptions {
  repoRoot: string;
  /** Path to a pre-generated `forge coverage --report summary` text file. */
  coverageFile: string;
  /** If true and no coverage file exists, run `forge coverage` directly. */
  runForge: boolean;
  /**
   * Path to the runs.json artifact emitted by the invariant-fuzz CI job. The
   * coverage job's capped fuzz (FOUNDRY_INVARIANT_RUNS=25 DEPTH=50) never
   * contributes to AMC — this artifact is the only source of fuzz inputs.
   */
  runsArtifactFile: string;
}

/**
 * Gather Static Verification inputs: src/Vault.sol coverage plus the fuzz
 * campaign that the invariant-fuzz CI job actually executed. Coverage is read
 * from `coverageFile` if present; otherwise, when `runForge` is set,
 * `forge coverage` is invoked with a capped fuzz budget (that budget is for
 * coverage instrumentation only and is NOT used as a fuzz input to AMC).
 */
export function gatherStatic(opts: StaticOptions): StaticInput {
  const artifact = existsSync(opts.runsArtifactFile)
    ? parseInvariantRunsArtifact(readFileSync(opts.runsArtifactFile, 'utf8'))
    : null;
  const invariantArtifactPresent = artifact !== null;
  const invariantRuns = artifact?.runs ?? 0;
  const invariantDepth = artifact?.depth ?? 0;

  let summary: string | null = null;
  if (existsSync(opts.coverageFile)) {
    summary = readFileSync(opts.coverageFile, 'utf8');
  } else if (opts.runForge) {
    summary = tryExec('forge', ['coverage', '--report', 'summary'], opts.repoRoot, {
      ...process.env,
      FOUNDRY_INVARIANT_RUNS: '25',
      FOUNDRY_INVARIANT_DEPTH: '50',
    });
  }

  const coverage = summary ? parseCoverageSummary(summary) : null;
  if (!coverage) {
    return {
      available: false,
      vaultLineCoverage: 0,
      vaultBranchCoverage: 0,
      invariantRuns,
      invariantDepth,
      invariantArtifactPresent,
    };
  }

  return {
    available: true,
    vaultLineCoverage: coverage.line,
    vaultBranchCoverage: coverage.branch,
    invariantRuns,
    invariantDepth,
    invariantArtifactPresent,
  };
}
