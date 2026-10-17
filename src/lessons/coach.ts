// What leaves the browser for the Coach (coach-design §5), and the plain-word lines on the result
// card ("3 of 32 beats missed; you need 29"). Pure.
import type { RetentionChange } from "@checks";
import { LESSON_IDS, LESSONS as CATALOGUE, SKIP_GROUP_IDS, type LessonId, type SkipGroupId } from "@shared/catalogue.ts";
import {
  COACH_CRITERIA_MAX,
  COACH_METRICS_MAX,
  RECENT_LINES_MAX,
  type CheckLineRequest,
  type CoachCheckSummary,
  type CoachCriterion,
  type CoachSuccess,
  type CurriculumData,
  type CurriculumRequest,
} from "@shared/coach-contract.ts";
import { criterionPlainName, focusCriteria } from "@shared/coach-deterministic.ts";
import type { LearnerRecord } from "@shared/learner.ts";
import type { MissionTag } from "@shared/mission.ts";
import type { SkillProfile } from "@shared/skill-profile.ts";
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

/** What the line knows about the focus criterion beyond this result (coach-design §2.3 input). */
export interface LineFacts {
  /** The focus criterion's margins from earlier attempts, oldest first, at most 3. */
  readonly focusHistory: readonly number[];
  readonly bestMarginBefore: number | null;
  /** E.g. "retained, next in 7 days". */
  readonly retentionChange: string | null;
}

export const FOCUS_HISTORY_MAX = 3;
/** For a result with nothing to focus on, or a void attempt (which never gets a line). */
export const NO_LINE_FACTS: LineFacts = { focusHistory: [], bestMarginBefore: null, retentionChange: null };
const DAY_MS = 86_400_000;

function retentionWords(change: RetentionChange, gradedAt: string): string {
  if (change.nextDueAt === null) return change.to;
  // Both times come from the data (the result's end and the schedule), never the wall clock.
  const gapMs = Date.parse(change.nextDueAt) - Date.parse(gradedAt);
  if (!Number.isFinite(gapMs)) return change.to;
  const days = Math.max(0, Math.round(gapMs / DAY_MS));
  return `${change.to}, next in ${String(days)} ${days === 1 ? "day" : "days"}`;
}

/**
 * The focus criterion's margin history, best margin before this attempt and retention change. The
 * focus is the criterion the line talks about (`focusCriteria`), so these facts never describe another.
 */
export function lineFacts(
  result: CheckResult,
  sources: {
    readonly profileBefore: SkillProfile;
    readonly retentionChanges: readonly RetentionChange[];
    /** Margins per criterion from earlier attempts, oldest first. */
    readonly marginHistory: Readonly<Partial<Record<string, readonly number[]>>>;
  },
): LineFacts {
  const focus = focusCriteria(toCoachSummary(result), 1)[0];
  if (focus === undefined) return NO_LINE_FACTS;
  const change = sources.retentionChanges.find((candidate) => candidate.criterionId === focus.id);
  return {
    focusHistory: (sources.marginHistory[focus.id] ?? []).slice(-FOCUS_HISTORY_MAX),
    bestMarginBefore: sources.profileBefore.criteria[focus.id]?.best?.margin ?? null,
    retentionChange: change === undefined ? null : retentionWords(change, result.endedAt),
  };
}

/** The part of a Skill profile that says which Lessons are passed. */
type PassedLessons = Pick<SkillProfile, "lessons">;

const passedIn = (profile: PassedLessons, id: LessonId) => profile.lessons[id]?.passedAt != null;

/** Skip groups whose every Lesson is passed in `after` but not in `before`. */
export function skipGroupsPassed(before: PassedLessons, after: PassedLessons): SkipGroupId[] {
  const complete = (profile: PassedLessons, group: SkipGroupId) =>
    CATALOGUE.filter((lesson) => lesson.skipGroup === group).every((lesson) => passedIn(profile, lesson.id));
  return SKIP_GROUP_IDS.filter((group) => complete(after, group) && !complete(before, group));
}

/** The background Curriculum re-plan after a skip group is passed: the Mission, what is demonstrated, and the result that passed it. */
export function curriculumRequest(record: LearnerRecord, result: CheckResult, requestId: string): CurriculumRequest {
  return {
    requestId,
    mission: record.mission,
    demonstrated: LESSON_IDS.filter((id) => passedIn(record.skillProfile, id)),
    placementResults: [toCoachSummary(result)],
    reason: "skipGroupPassed",
  };
}

/** The part of the Coach's Curriculum answer the record keeps. */
export type CurriculumAnswer = Pick<CoachSuccess<CurriculumData>, "source" | "data">;

/**
 * The record with the new Curriculum. Mission tags are replaced only when the Coach chose them: the
 * fallback has none (coach-design §2.2) and must not erase tags an earlier Coach answer gave.
 */
export function withCurriculum(record: LearnerRecord, answer: CurriculumAnswer): LearnerRecord {
  const { curriculum, missionTags } = answer.data;
  return { ...record, curriculum: [...curriculum], missionTags: answer.source === "llm" ? [...missionTags] : record.missionTags };
}

export interface LineContext {
  readonly requestId: string;
  readonly lessonTitle: string;
  readonly attemptToday: number;
  readonly recentLines: readonly string[];
  readonly facts: LineFacts;
  readonly missionTags: readonly MissionTag[];
}

export function checkLineRequest(result: CheckResult, context: LineContext): CheckLineRequest {
  return {
    requestId: context.requestId,
    result: toCoachSummary(result),
    context: {
      lessonTitle: context.lessonTitle,
      focusHistory: [...context.facts.focusHistory],
      bestMarginBefore: context.facts.bestMarginBefore,
      retentionChange: context.facts.retentionChange,
      attemptToday: Math.max(1, context.attemptToday),
      missionTags: [...context.missionTags],
      recentLines: context.recentLines.slice(-RECENT_LINES_MAX),
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
