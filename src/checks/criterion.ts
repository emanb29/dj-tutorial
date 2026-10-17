// Turning a measured value and a threshold into a CriterionResult.
import type {
  CriterionId,
  CriterionResult,
  Evidence,
  Severity,
  Threshold,
  Unit,
} from "@shared/check-result.ts";

/** Float slack for threshold comparisons, so a value on a boundary counts as on it. */
const EPSILON = 1e-9;

export interface Judgement {
  readonly id: CriterionId;
  readonly severity: Severity;
  readonly unit: Unit;
  readonly threshold: Threshold;
  /** `null` when there was nothing to measure; the criterion is then not met. */
  readonly measured: number | null;
  /** Divides the margin when the threshold value is 0 (default 1). */
  readonly scale?: number;
  readonly evidence?: readonly Evidence[];
  readonly detail?: Readonly<Record<string, number>>;
}

/** Signed margin: `≥ 0` exactly when the threshold is met. */
export function margin(threshold: Threshold, measured: number, scale = 1): number {
  const { op, value } = threshold;
  if (typeof value !== "number") {
    const [low, high] = value;
    return Math.min(measured - low, high - measured) / ((high - low) / 2 || scale);
  }
  const divisor = Math.abs(value) > EPSILON ? Math.abs(value) : scale;
  switch (op) {
    case "<=":
    case "<":
      return (value - measured) / divisor;
    case ">=":
      return (measured - value) / divisor;
    case "==":
    case "in":
      return -Math.abs(measured - value) / divisor;
  }
}

function clean(value: number): number {
  return Math.abs(value) < EPSILON ? 0 : value;
}

export function judge(judgement: Judgement): CriterionResult {
  const { id, severity, unit, threshold, measured, scale, evidence = [], detail } = judgement;
  const common = { id, severity, unit, threshold, evidence, ...(detail === undefined ? {} : { detail }) };
  // Non-finite values mean nothing usable was measured (and would not survive JSON).
  if (measured === null || !Number.isFinite(measured)) return { ...common, status: "notMet", measured: null, margin: null };
  const signed = clean(margin(threshold, measured, scale));
  const met = threshold.op === "<" ? signed > 0 : signed >= 0;
  return { ...common, status: met ? "met" : "notMet", measured, margin: signed };
}

/** Several conditions in one criterion: met when all are, margin = the worst; reported as the first. */
export function judgeAll(first: Judgement, ...rest: readonly Judgement[]): CriterionResult {
  const results = [first, ...rest].map(judge);
  const head = judge(first);
  const margins = results.map((result) => result.margin);
  const known = margins.every((value) => value !== null);
  const worst = known ? Math.min(...margins) : null;
  return {
    ...head,
    status: results.every((result) => result.status === "met") ? "met" : "notMet",
    margin: worst,
  };
}

/**
 * Several criteria reported as one (e.g. `crossfader.xf-blend` = sync-blend's rules): met when all
 * are, margin = the worst, measured and threshold of the first one not met (else the first).
 */
export function allOf(id: CriterionId, results: readonly [CriterionResult, ...CriterionResult[]]): CriterionResult {
  const head = results.find((result) => result.status !== "met") ?? results[0];
  const margins = results.map((result) => result.margin);
  const known = margins.every((value) => value !== null);
  return {
    ...head,
    id,
    status: results.every((result) => result.status === "met") ? "met" : "notMet",
    margin: known ? Math.min(...margins) : null,
    evidence: results.flatMap((result) => result.evidence),
  };
}

export function notApplicable(id: CriterionId, severity: Severity, unit: Unit, threshold: Threshold | null): CriterionResult {
  return { id, severity, status: "notApplicable", measured: null, unit, threshold, margin: null, evidence: [] };
}
