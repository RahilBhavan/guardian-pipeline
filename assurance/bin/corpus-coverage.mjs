#!/usr/bin/env node
/**
 * corpus-coverage — zero-dependency Node executable that parses the
 * per-selector "Metrics" table emitted by `forge test -vvv` for invariant
 * suites and fails when any handler selector fired fewer than --min-calls
 * times.
 *
 * Usage:
 *   node assurance/bin/corpus-coverage.mjs <results-file> [--min-calls N] [--json]
 *
 * Exit codes:
 *   0  every selector cleared the floor
 *   1  one or more selectors below the floor (starved)
 *   2  no metrics table found in the input (parsing failure or bad args)
 *
 * Why this exists: the invariant campaign is only as strong as the
 * action space it actually exercises. A handler edit that silently
 * makes a selector inert — bound() rejecting every call, a missing
 * `excludeArtifact`, an early `return` triggered by a flipped guard —
 * leaves a hole the fuzzer can never enter, and the suite still passes.
 * This check turns "no selector got starved" into a hard CI gate.
 *
 * Input format (forge 1.7.x, -vvv):
 *
 *   |-------------------+--------------------+-------+---------+----------|
 *   | Contract          | Selector           | Calls | Reverts | Discards |
 *   +=====================================================================+
 *   | BorrowHandler     | borrow             | 7234  | 0       | 0        |
 *   ...
 *
 * Forge emits one metrics table per invariant function. Because all
 * invariants in a suite share the same fuzz sequence, those tables are
 * byte-identical; we dedupe by (contract, selector) keeping the max
 * observed call count (defensive against any future per-invariant
 * divergence).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

// Run CLI only when invoked directly. The unit test imports parseMetrics as
// a module, which would otherwise trigger the top-level CLI path (exit 2 on
// missing argv) before any test ran.
const invokedAsMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedAsMain) main();

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      "usage: corpus-coverage.mjs <results-file> [--min-calls N] [--json]\n",
    );
    process.exit(args.length === 0 ? 2 : 0);
  }

  const path = args[0];
  let minCalls = 100;
  let jsonOut = false;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--min-calls") {
      minCalls = Number(args[++i]);
      if (!Number.isFinite(minCalls) || minCalls < 0) {
        process.stderr.write(`error: --min-calls expects a non-negative integer\n`);
        process.exit(2);
      }
    } else if (a === "--json") {
      jsonOut = true;
    } else {
      process.stderr.write(`error: unknown argument: ${a}\n`);
      process.exit(2);
    }
  }

  const raw = readFileSync(path, "utf8");
  const counts = parseMetrics(raw);

  if (counts.length === 0) {
    process.stderr.write(
      `error: no invariant metrics table found in ${path}. ` +
        `Ensure 'forge test' ran with -vvv and that the suite contains invariant_* tests.\n`,
    );
    process.exit(2);
  }

  counts.sort((a, b) => a.calls - b.calls);
  const starved = counts.filter((c) => c.calls < minCalls);

  if (jsonOut) {
    process.stdout.write(
      JSON.stringify(
        {
          minCalls,
          selectors: counts,
          starved,
          ok: starved.length === 0,
        },
        null,
        2,
      ) + "\n",
    );
  } else if (starved.length === 0) {
    process.stdout.write(
      `Corpus coverage OK: ${counts.length} selectors fired >= ${minCalls} times\n`,
    );
    process.stdout.write(
      `  lowest:  ${formatRow(counts[0])}\n  highest: ${formatRow(counts[counts.length - 1])}\n`,
    );
  } else {
    process.stdout.write(
      `Corpus coverage FAILED: ${starved.length} selector(s) below ${minCalls} calls\n`,
    );
    for (const row of counts) {
      const mark = row.calls < minCalls ? "x" : "+";
      process.stdout.write(`  ${mark} ${formatRow(row)}\n`);
    }
  }

  process.exit(starved.length === 0 ? 0 : 1);
}

function formatRow(r) {
  return `${r.contract}.${r.selector}: ${r.calls} calls`;
}

/**
 * Parse every "Metrics" row out of raw forge output. Returns an array of
 * {contract, selector, calls}, deduped by (contract, selector) with the
 * max observed call count kept. Caller is responsible for sorting.
 */
export function parseMetrics(text) {
  const map = new Map();
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    // Data rows start with `|`, contain exactly 7 cells when split on `|`
    // (one empty cell at each end), and have a numeric Calls column.
    // Header rows ("Contract") and box-drawing separator rows fall through
    // the Number.isFinite check below.
    if (!line.startsWith("|")) continue;
    const cells = line.split("|");
    if (cells.length !== 7) continue;

    const contract = cells[1].trim();
    const selector = cells[2].trim();
    const callsStr = cells[3].trim();
    if (!contract || !selector) continue;
    if (contract === "Contract") continue;
    const calls = Number(callsStr);
    if (!Number.isFinite(calls)) continue;

    const key = `${contract} ${selector}`;
    const prev = map.get(key);
    if (prev === undefined || calls > prev.calls) {
      map.set(key, { contract, selector, calls });
    }
  }
  return Array.from(map.values());
}
