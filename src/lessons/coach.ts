// What leaves the browser for the Coach (coach-design §5), and the plain-word lines on the result
// card ("3 of 32 beats missed; you need 29"). Pure.
import { COACH_CRITERIA_MAX, COACH_METRICS_MAX, type CheckLineRequest, type CoachCheckSummary, type CoachCriterion } from "@shared/coach-contract.ts";
import { criterionPlainName } from "@shared/coach-deterministic.ts";
import type { CheckResult, CriterionResult, Threshold, Unit } from "@shared/check-result.ts";
import type { Threshold as CoachThreshold, Unit as CoachUnit } from "@shared/check-types.ts";

/** A fader position is a 0–1 ratio to the Coach, whose contract has no "position" unit. */
function coachUnit(unit: Unit): CoachUnit {
  return unit === "position" ? "ratio" : unit;
}

function coachThreshold(threshold: Threshold | null): CoachThreshold | null {
  if (threshold === null) return null;
  const { value } = threshold;
  return { op: threshold.op === "<" ? "<=" : threshold.op, value: typeof value === "number" ? value : [value[0], value[1]], unit: coachUnit(threshold.unit) };
}

/** The reduced result for the Coach: measured criteria only, in the contract's units. */
export function toCoachSummary(result: CheckResult): CoachCheckSummary {
  const criteria = result.criteria.flatMap((criterion): CoachCriterion[] =>
    criterion.status === "notApplicable" || criterion.measured === null
      ? []
      : [
          {
            id: criterion.id,
            severity: criterion.severity,
            status: criterion.status,
            measured: criterion.measured,
            unit: coachUnit(criterion.unit),
            threshold: coachThreshold(criterion.threshold),
            margin: criterion.margin,
          },
        ],
  );
  return {
    lessonId: result.lessonId,
    mode: result.mode,
    variant: result.variant,
    outcome: result.outcome.kind === "passed" ? "passed" : "failed",
    criteria: criteria.slice(0, COACH_CRITERIA_MAX),
    metrics: Object.fromEntries(Object.entries(result.metrics).slice(0, COACH_METRICS_MAX)),
  };
}

export interface LineContext {
  readonly requestId: string;
  readonly lessonTitle: string;
  readonly attemptToday: number;
  readonly recentLines: readonly string[];
}

export function checkLineRequest(result: CheckResult, context: LineContext): CheckLineRequest {
  return {
    requestId: context.requestId,
    result: toCoachSummary(result),
    context: {
      lessonTitle: context.lessonTitle,
      focusHistory: [],
      bestMarginBefore: null,
      retentionChange: null,
      attemptToday: Math.max(1, context.attemptToday),
      missionTags: [],
      recentLines: context.recentLines.slice(-5),
    },
  };
}

const thresholdValue = (criterion: CriterionResult): number =>
  typeof criterion.threshold?.value === "number" ? criterion.threshold.value : 0;

function taps(label: string, criterion: CriterionResult, need: number): string {
  const matched = criterion.detail?.["matched"] ?? 0;
  const targets = criterion.detail?.["targets"] ?? 0;
  const extras = criterion.detail?.["extras"] ?? 0;
  const wrong = criterion.detail?.["wrongBeat"] ?? 0;
  const extra = extras > 0 ? `, ${String(extras)} extra` : "";
  const wrongText = wrong > 0 ? `, ${String(wrong)} on the wrong beat` : "";
  return `${label}: ${String(matched)} of ${String(targets)} on time (need ${String(need)})${extra}${wrongText}`;
}

/** One plain line per criterion for the result card: what was measured against what was needed. */
export function describeCriterion(criterion: CriterionResult): string {
  const measured = criterion.measured;
  switch (criterion.id) {
    case "deck-basics.fade-in":
      return measured === null ? "Fade in: never heard" : `Fade in: heard after ${measured.toFixed(1)} bars (need 4 or less)`;
    case "deck-basics.fade-out":
      return `Fade out: fader ended at ${String(Math.round((measured ?? 0) * 100))}% (needs 0%)`;
    case "deck-basics.no-clip-local":
      return measured === null ? "Master level: no sound measured" : `Master peak: ${measured.toFixed(1)} dBFS (stay under −0.1)`;
    case "beats-and-bars.beat-taps":
      return taps("Beats", criterion, Math.ceil(thresholdValue(criterion) * (criterion.detail?.["targets"] ?? 0) - 1e-9));
    case "beats-and-bars.downbeat-taps":
      return taps("Downbeats", criterion, thresholdValue(criterion));
    case "phrases.phrase-taps":
      return taps("Phrase starts", criterion, thresholdValue(criterion));
    case "phrases.name-sections": {
      const questions = criterion.detail?.["questions"] ?? 0;
      return `Sections named: ${String(questions - (measured ?? questions))} of ${String(questions)} right`;
    }
    default: {
      const name = criterionPlainName(criterion.id);
      const label = name.charAt(0).toUpperCase() + name.slice(1);
      return measured === null ? label : `${label}: ${String(Math.round(measured * 100) / 100)} ${criterion.unit}`;
    }
  }
}
