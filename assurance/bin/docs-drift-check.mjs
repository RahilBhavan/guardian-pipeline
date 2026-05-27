#!/usr/bin/env node
/**
 * docs-drift-check.mjs — grep every committed markdown file (outside
 * CHANGELOG / MEMORY / vendored trees) for substrings that the prose sweep
 * declared stale. Exits 1 with a per-hit report when any pattern matches,
 * 0 when the working tree is clean.
 *
 * Stale-substring catalogue:
 *   - "all 6 invariants" / "all six invariants"
 *     The off-chain mirror is now 12 invariants (commit 659cf73).
 *   - "9-of-12"
 *     No subset of "9 of 12" survived the D1 rewrite — every claim is now
 *     "all 12" or has a specific class breakdown.
 *   - "PREVENTED by absence"
 *     The exploit catalogue narrates real mechanisms now, not absent
 *     surfaces — this phrasing belonged to the pre-D3 catalogue.
 *   - The three ghost-catalogue entry names (Privileged solvency break /
 *     Reserve liquidity drain / Rounding-dust extraction) — fictional rows
 *     deleted in (d). The actual 10 mechanism replays from D3 are stronger.
 *   - "monitored-only" applied to any specific finding (matched by
 *     co-occurrence with `GUA-\d+` on the same line). The traceability
 *     resolver currently emits no monitored-only findings; any markdown
 *     pinning a finding to that tier has drifted from
 *     `security-review/findings.json`.
 *
 * Markdown files under MEMORY.md / CHANGELOG.md are exempt — they are
 * historical records and intentionally preserve the prior prose.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Directories that never contain authored prose. */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'lib', // forge-std + openzeppelin submodules
  'out',
  'cache',
  'broadcast',
  'coverage',
  'dist',
]);

/** Per-file exemptions — historical records that legitimately keep stale prose. */
const SKIP_FILES = new Set(['MEMORY.md', 'CHANGELOG.md']);

/**
 * Drift rules. `pattern` is a RegExp tested against each line; `name` is the
 * human-readable label printed on a hit; `hint` is the recommended fix.
 */
const RULES = [
  {
    name: 'all-6-invariants',
    pattern: /all\s+(?:6|six)\s+invariants/i,
    hint: 'D1 extended the mirror to 12 invariants — say "all 12 invariants".',
  },
  {
    name: '9-of-12',
    pattern: /9-of-12/i,
    hint: 'No "9 of 12" subset survived D1. Use "all 12" or a class breakdown.',
  },
  {
    name: 'prevented-by-absence',
    pattern: /PREVENTED\s+by\s+absence/i,
    hint: 'D3 catalogue narrates real mechanisms, not absent surfaces.',
  },
  {
    name: 'ghost-privileged-solvency-break',
    pattern: /Privileged\s+solvency\s+break/i,
    hint: 'Ghost-catalogue entry deleted in (d). Use the generated EXPLOIT_CATALOGUE block.',
  },
  {
    name: 'ghost-reserve-liquidity-drain',
    pattern: /Reserve\s+liquidity\s+drain/i,
    hint: 'Ghost-catalogue entry deleted in (d). Use the generated EXPLOIT_CATALOGUE block.',
  },
  {
    name: 'ghost-rounding-dust-extraction',
    pattern: /Rounding-dust\s+extraction/i,
    hint: 'Ghost-catalogue entry deleted in (d). Use the generated EXPLOIT_CATALOGUE block.',
  },
  {
    name: 'monitored-only-finding',
    // A finding pinned to monitored-only on the same line — distinct from
    // the bullet-list *definition* of "monitored-only" as a tier name.
    pattern: /GUA-\d+[^\n]*monitored-only|monitored-only[^\n]*GUA-\d+/i,
    hint: 'No finding is monitored-only in the current resolver output. Link to TRACEABILITY_SUMMARY.md.',
  },
];

/** Walk the repository, yielding every `.md` path not under a skipped dir. */
function* walkMarkdown(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile() && entry.endsWith('.md') && !SKIP_FILES.has(entry)) {
        yield full;
      }
    }
  }
}

const hits = [];
for (const file of walkMarkdown(REPO_ROOT)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const rule of RULES) {
      if (rule.pattern.test(line)) {
        hits.push({
          file: relative(REPO_ROOT, file),
          line: i + 1,
          rule: rule.name,
          text: line.trim(),
          hint: rule.hint,
        });
      }
    }
  }
}

if (hits.length === 0) {
  console.log('docs-drift-check: clean — 0 stale substrings across committed markdown.');
  process.exit(0);
}

console.error(`docs-drift-check: ${hits.length} stale substring${hits.length === 1 ? '' : 's'} found.\n`);
for (const h of hits) {
  console.error(`  ${h.file}:${h.line}  [${h.rule}]`);
  console.error(`    > ${h.text}`);
  console.error(`    hint: ${h.hint}\n`);
}
process.exit(1);
