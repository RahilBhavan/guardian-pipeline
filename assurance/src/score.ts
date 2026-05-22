/**
 * score.ts — the composite Assurance Score.
 *
 * A single 0-100 number (plus letter grade) summarising the pre-deployment
 * evidence the repository can produce on its own, across three components:
 *
 *   Static Verification   0.45   src/Vault.sol coverage + fuzz-campaign size
 *   Exploit Resistance    0.35   exploit-replay catch rate
 *   Finding Traceability  0.20   review findings bound to a re-runnable check
 *
 * On the weights: they are a deliberate editorial choice, not an empirically
 * derived constant. Static Verification is the broadest evidence — coverage
 * and the fuzz campaign exercise the whole contract — so it carries the most
 * weight; Exploit Resistance tests specific named attack classes; Finding
 * Traceability measures process completeness. The weights are fixed here, in
 * the open, so the score is reproducible and the bias is explicit rather than
 * hidden.
 *
 * Scope note: an earlier design added a fourth "Continuous Monitoring"
 * component scored from a live Guardian deployment. That component was removed
 * — this project ships the runtime monitor as a runnable reference
 * implementation, not a hosted service, so there is no live deployment to
 * score and the Assurance Score is a pre-deployment metric only.
 *
 * Every function here is pure and unit-tested; sources.ts gathers the inputs.
 */

/** One component of the composite score. */
export interface ScoreComponent {
  key: string;
  label: string;
  /** 0-100. Meaningful only when `available` is true. */
  score: number;
  /** False when the underlying data source could not be reached. */
  available: boolean;
  /** Weight in the composite, before re-normalisation for unavailable inputs. */
  weight: number;
  /** One-line human summary of how the score was reached. */
  detail: string;
  /** Raw metrics behind the score, for the dashboard and report. */
  metrics: Record<string, number | string | boolean>;
}

/** The fully-computed composite score. */
export interface AssuranceScore {
  /** 0-100 weighted composite over available components. */
  overall: number;
  grade: string;
  components: ScoreComponent[];
  /** Sum of weights of the components that were available. */
  effectiveWeight: number;
}

/** Inputs for the Static Verification component. */
export interface StaticInput {
  available: boolean;
  /** src/Vault.sol line coverage, as a percentage. */
  vaultLineCoverage: number;
  /** src/Vault.sol branch coverage, as a percentage. */
  vaultBranchCoverage: number;
  /** Foundry invariant `runs` from the CI profile. */
  invariantRuns: number;
  /** Foundry invariant `depth` from the CI profile. */
  invariantDepth: number;
}

/** Inputs for the Exploit Resistance component. */
export interface ExploitInput {
  available: boolean;
  total: number;
  prevented: number;
  detected: number;
  missed: number;
}

/** Inputs for the Finding Traceability component. */
export interface TraceInput {
  available: boolean;
  /** Weighted coverage over security-relevant findings, as a percentage. */
  coveragePct: number;
  /** Count of security-relevant findings with no continuous coverage. */
  gaps: number;
}

/** Component weights — must sum to 1. See the file header for the rationale. */
export const WEIGHTS = {
  staticVerification: 0.45,
  exploitResistance: 0.35,
  findingTraceability: 0.2,
} as const;

/** Clamp `n` into the [lo, hi] range. */
function clamp(n: number, lo = 0, hi = 100): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Round to one decimal place. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Map a fuzz-campaign size (runs x depth) to a 0-100 intensity score on a log
 * scale: a campaign at or below MIN scores 0, one at or above TARGET scores 100.
 */
export function fuzzIntensity(runsDepthProduct: number): number {
  const MIN = 10_000; // a token campaign
  const TARGET = 2_000_000; // the `deep` profile: 10,000 runs x 200 depth
  if (runsDepthProduct <= MIN) return 0;
  if (runsDepthProduct >= TARGET) return 100;
  return (
    (100 * (Math.log10(runsDepthProduct) - Math.log10(MIN))) /
    (Math.log10(TARGET) - Math.log10(MIN))
  );
}

/** Map a 0-100 overall score to a letter grade. */
export function gradeFor(overall: number): string {
  if (overall >= 97) return 'A+';
  if (overall >= 93) return 'A';
  if (overall >= 90) return 'A-';
  if (overall >= 87) return 'B+';
  if (overall >= 83) return 'B';
  if (overall >= 80) return 'B-';
  if (overall >= 77) return 'C+';
  if (overall >= 73) return 'C';
  if (overall >= 70) return 'C-';
  if (overall >= 60) return 'D';
  return 'F';
}

/** Static Verification — coverage of src/Vault.sol plus fuzz-campaign intensity. */
export function scoreStatic(input: StaticInput): ScoreComponent {
  const coverageScore = 0.6 * input.vaultLineCoverage + 0.4 * input.vaultBranchCoverage;
  const product = input.invariantRuns * input.invariantDepth;
  const intensity = fuzzIntensity(product);
  const score = clamp(0.7 * coverageScore + 0.3 * intensity);

  return {
    key: 'staticVerification',
    label: 'Static Verification',
    score: round1(score),
    available: input.available,
    weight: WEIGHTS.staticVerification,
    detail: input.available
      ? `Vault.sol ${round1(input.vaultLineCoverage)}% line / ${round1(input.vaultBranchCoverage)}% branch; ` +
        `fuzz campaign ${input.invariantRuns}x${input.invariantDepth} (intensity ${Math.round(intensity)}/100)`
      : 'forge coverage unavailable — component excluded from the composite',
    metrics: {
      lineCoverage: round1(input.vaultLineCoverage),
      branchCoverage: round1(input.vaultBranchCoverage),
      invariantRuns: input.invariantRuns,
      invariantDepth: input.invariantDepth,
      fuzzIntensity: Math.round(intensity),
    },
  };
}

/**
 * Exploit Resistance — share of replayed exploit classes the protocol resists
 * (PREVENTED or DETECTED). Any MISSED scenario is a real gap and caps the
 * component at 50.
 */
export function scoreExploit(input: ExploitInput): ScoreComponent {
  const resisted = input.prevented + input.detected;
  let score = input.total === 0 ? 0 : (resisted / input.total) * 100;
  if (input.missed > 0) score = Math.min(score, 50);
  score = clamp(score);

  return {
    key: 'exploitResistance',
    label: 'Exploit Resistance',
    score: round1(score),
    available: input.available && input.total > 0,
    weight: WEIGHTS.exploitResistance,
    detail:
      input.available && input.total > 0
        ? `${resisted}/${input.total} exploit classes resisted ` +
          `(${input.prevented} prevented, ${input.detected} detected, ${input.missed} missed)`
        : 'exploit-replay catalogue unavailable — component excluded from the composite',
    metrics: {
      total: input.total,
      prevented: input.prevented,
      detected: input.detected,
      missed: input.missed,
    },
  };
}

/**
 * Finding Traceability — weighted coverage of security-relevant review
 * findings. Any uncovered security-relevant finding caps the component at 60.
 */
export function scoreTraceability(input: TraceInput): ScoreComponent {
  let score = clamp(input.coveragePct);
  if (input.gaps > 0) score = Math.min(score, 60);

  return {
    key: 'findingTraceability',
    label: 'Finding Traceability',
    score: round1(score),
    available: input.available,
    weight: WEIGHTS.findingTraceability,
    detail: input.available
      ? `${round1(input.coveragePct)}% weighted coverage of security-relevant findings` +
        (input.gaps > 0 ? `; ${input.gaps} uncovered finding(s)` : '')
      : 'finding registry unavailable — component excluded from the composite',
    metrics: {
      coveragePct: round1(input.coveragePct),
      gaps: input.gaps,
    },
  };
}

/**
 * Combine components into the composite score. All three components are
 * normally available; if a data source genuinely cannot be reached (e.g. no
 * coverage file) that component is dropped and the remaining weights are
 * re-normalised, so the score reflects only the evidence actually gathered.
 * `effectiveWeight` reports how much of the intended 1.0 was in play.
 */
export function computeScore(components: ScoreComponent[]): AssuranceScore {
  const available = components.filter((c) => c.available);
  const effectiveWeight = available.reduce((acc, c) => acc + c.weight, 0);

  const overall =
    effectiveWeight === 0
      ? 0
      : Math.round(available.reduce((acc, c) => acc + c.score * c.weight, 0) / effectiveWeight);

  return {
    overall,
    grade: gradeFor(overall),
    components,
    effectiveWeight: round1(effectiveWeight),
  };
}
