/**
 * findings.ts — load and type the static audit registry (audit/findings.json).
 *
 * The registry is the machine-readable form of a point-in-time security audit.
 * Each finding carries a `continuousAssurance` block binding it to the
 * invariants, harness tests, live monitors and exploit replays that keep it
 * verified after the audit's snapshot date.
 */
import { readFileSync } from 'node:fs';

/** Audit severity levels, most to least severe. */
export type Severity = 'Critical' | 'High' | 'Medium' | 'Low' | 'Informational' | 'Gas';

/** The four continuous-assurance layers a finding can be bound to. */
export interface ContinuousAssurance {
  /** Invariant IDs (INV-01..08) that formalise this finding's property. */
  invariants: string[];
  /** Foundry `invariant_*` function names proving the property pre-deploy. */
  harnessTests: string[];
  /** Invariant IDs the live Guardian bot monitors post-deploy. */
  liveMonitors: string[];
  /** Exploit-replay scenario IDs (EXP-*) exercising this finding's class. */
  exploitReplays: string[];
  /** Why these bindings keep the finding covered. */
  rationale: string;
}

/** One audit finding. */
export interface Finding {
  id: string;
  title: string;
  severity: Severity;
  status: string;
  category: string;
  location: string;
  /** False for findings (e.g. gas) with no security property to monitor. */
  securityRelevant: boolean;
  description: string;
  recommendation: string;
  continuousAssurance: ContinuousAssurance;
}

/** Report-level metadata. */
export interface AuditReportMeta {
  title: string;
  subject: string;
  auditor: string;
  reportDate: string;
  reviewedCommit: string;
  methodology: string;
  note: string;
}

/** The full audit registry document. */
export interface FindingsDoc {
  report: AuditReportMeta;
  severityScale: Severity[];
  statusScale: string[];
  findings: Finding[];
}

/** Severity ordering for sorting (0 = most severe). */
export const SEVERITY_RANK: Record<Severity, number> = {
  Critical: 0,
  High: 1,
  Medium: 2,
  Low: 3,
  Informational: 4,
  Gas: 5,
};

/**
 * Load and minimally validate the audit registry from disk.
 * @throws if the file is missing, malformed, or structurally invalid.
 */
export function loadFindings(path: string): FindingsDoc {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`Audit registry not found: ${path}`);
  }

  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Audit registry is not valid JSON (${path}): ${(err as Error).message}`);
  }

  if (typeof doc !== 'object' || doc === null || !Array.isArray((doc as FindingsDoc).findings)) {
    throw new Error(`Audit registry has no "findings" array: ${path}`);
  }

  const findings = (doc as FindingsDoc).findings;
  for (const f of findings) {
    if (!f.id || !f.severity || !f.continuousAssurance) {
      throw new Error(`Audit finding is missing id/severity/continuousAssurance: ${JSON.stringify(f).slice(0, 80)}`);
    }
  }

  return doc as FindingsDoc;
}
