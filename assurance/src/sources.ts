/**
 * sources.ts — gather the real inputs that feed the Assurance Score.
 *
 * Each gatherer degrades gracefully: if a data source cannot be reached it
 * returns `available: false` and the score engine drops that component rather
 * than guessing. The score therefore always reflects only evidence that was
 * actually collected.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/** Parse the CI invariant profile's runs/depth from foundry.toml. */
export function parseFoundryFuzzProfile(toml: string): { runs: number; depth: number } {
  // Default to the [profile.ci.invariant] values shipped with the repo.
  const fallback = { runs: 2000, depth: 150 };
  const section = toml.match(/\[profile\.ci\.invariant\]([\s\S]*?)(?=\n\[|$)/);
  if (!section) return fallback;
  const body = section[1];
  const runs = body.match(/runs\s*=\s*(\d+)/);
  const depth = body.match(/depth\s*=\s*(\d+)/);
  return {
    runs: runs ? Number(runs[1]) : fallback.runs,
    depth: depth ? Number(depth[1]) : fallback.depth,
  };
}

/** Options controlling how Static Verification inputs are gathered. */
export interface StaticOptions {
  repoRoot: string;
  /** Path to a pre-generated `forge coverage --report summary` text file. */
  coverageFile: string;
  /** If true and no coverage file exists, run `forge coverage` directly. */
  runForge: boolean;
}

/**
 * Gather Static Verification inputs: src/Vault.sol coverage plus the CI fuzz
 * profile. Coverage is read from `coverageFile` if present; otherwise, when
 * `runForge` is set, `forge coverage` is invoked with a capped fuzz budget.
 */
export function gatherStatic(opts: StaticOptions): StaticInput {
  const tomlPath = join(opts.repoRoot, 'foundry.toml');
  const fuzz = existsSync(tomlPath)
    ? parseFoundryFuzzProfile(readFileSync(tomlPath, 'utf8'))
    : { runs: 2000, depth: 150 };

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
      invariantRuns: fuzz.runs,
      invariantDepth: fuzz.depth,
    };
  }

  return {
    available: true,
    vaultLineCoverage: coverage.line,
    vaultBranchCoverage: coverage.branch,
    invariantRuns: fuzz.runs,
    invariantDepth: fuzz.depth,
  };
}
