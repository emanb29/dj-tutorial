// Skill profile writes (check-design §8.1): records, the per-criterion retention state machine,
// the Review trigger and the course-complete latch. Pure: the attempt's `endedAt` is "now".
import type { CheckMode, IsoTime, LessonId } from "@shared/attempt.ts";
import type { CheckResult, CriterionId, CriterionResult, StandingId } from "@shared/check-result.ts";
import type {
  CriterionRecord,
  CriterionRetention,
  LessonRecord,
  RetentionState,
  RetentionStep,
  SkillProfile,
} from "@shared/skill-profile.ts";

const HOUR_MS = 3_600_000;
/** Retention intervals, days, by step. */
export const RETENTION_LADDER_DAYS = [1, 3, 7, 21, 60] as const;
/** `nextDueAt` is this much early, so a same-time session the next day qualifies. */
export const DUE_SLACK_HOURS = 4;
/** A cold re-pass counts only this long after the criterion's last pass. */
export const COLD_GAP_HOURS = 20;
export const REVIEW_AFTER_FAILS = 3;
const PASS_DATES_KEPT = 20;

/** The Lesson that teaches each standing criterion (check-design §3, "From"). */
export const STANDING_TAUGHT_IN: Readonly<Record<StandingId, LessonId>> = {
  "no-clip": "gain-staging",
  "no-dead-air": "cut-on-phrase",
  "on-phrase": "cut-on-phrase",
  "level-match": "cut-on-phrase",
  "cued-first": "cut-on-phrase",
  "trim-still": "sync-blend",
  "no-boost": "eq-basics",
  "controls-reset": "eq-basics",
  "sync-kept": "sync-blend",
  "no-recue": "nudge-phase",
  "one-bass": "blend-by-ear",
  drift: "blend-by-ear",
  overcorrect: "tempo-by-ear",
  "key-clash": "final-mix",
  "technique-mix": "final-mix",
};

/** The critical path to `final-mix` (catalogue §2): Lessons 1–9, 11, 12, 14–16 and 20. */
export const FINAL_MIX_ROUTE: readonly LessonId[] = [
  "deck-basics",
  "beats-and-bars",
  "phrases",
  "gain-staging",
  "headphone-cue",
  "cue-point",
  "cut-on-phrase",
  "tempo-fader",
  "sync-blend",
  "eq-basics",
  "bass-swap",
  "nudge-phase",
  "tempo-by-ear",
  "blend-by-ear",
  "final-mix",
];

export function isStanding(id: CriterionId): id is `standing.${StandingId}` {
  return id.startsWith("standing.");
}

/** The Lesson that introduced a criterion. */
export function lessonOfCriterion(id: CriterionId): LessonId {
  const [prefix = "", rest = ""] = id.split(".", 2) as [string?, string?];
  return isStanding(id) ? STANDING_TAUGHT_IN[rest as StandingId] : (prefix as LessonId);
}

const isCold = (mode: CheckMode): boolean => mode === "cold" || mode === "warmup";
const isGating = (mode: CheckMode): boolean => mode !== "bonus";

function plusHours(at: IsoTime, hours: number): IsoTime {
  return new Date(Date.parse(at) + hours * HOUR_MS).toISOString();
}

function dueAfter(at: IsoTime, step: RetentionStep): IsoTime {
  return plusHours(at, RETENTION_LADDER_DAYS[step] * 24 - DUE_SLACK_HOURS);
}

function hoursBetween(from: IsoTime, to: IsoTime): number {
  return (Date.parse(to) - Date.parse(from)) / HOUR_MS;
}

const NOT_PASSED: CriterionRetention = { state: "notPassed", step: 0, nextDueAt: null, lastColdPassAt: null };

function newRecord(id: CriterionId): CriterionRecord {
  return {
    criterionId: id,
    lessonId: lessonOfCriterion(id),
    last: null,
    best: null,
    firstPassedAt: null,
    passDates: [],
    consecutiveFails: 0,
    retention: isStanding(id) ? null : NOT_PASSED,
    practice: { attempts: 0, met: 0, lastAt: null },
  };
}

function newLessonRecord(lessonId: LessonId): LessonRecord {
  return { lessonId, passedAt: null, passedVia: null, attempts: 0, reviewSuggestedAt: null, reviewDeclinedAt: null };
}

interface Attempted {
  readonly result: CheckResult;
  readonly criterion: CriterionResult;
  readonly met: boolean;
  /** The criterion's previous pass, before this attempt. */
  readonly lastPassAt: IsoTime | null;
}

/** The retention state machine for one criterion and one graded result (check-design §8.1 table). */
function nextRetention(retention: CriterionRetention, { result, met, lastPassAt }: Attempted): CriterionRetention {
  const at = result.endedAt;
  const { state, step, nextDueAt } = retention;
  const passedCheck = result.outcome.kind === "passed";

  if (!isCold(result.mode)) {
    if (state === "notPassed" && met && passedCheck) return { ...retention, state: "passed", step: 0, nextDueAt: dueAfter(at, 0) };
    if (state === "lapsed" && met && result.mode === "lesson") return { ...retention, step: 0, nextDueAt: dueAfter(at, 0) };
    return retention;
  }

  if (state === "notPassed") return retention;
  if (!met) return { ...retention, state: "lapsed", step: 0, nextDueAt: dueAfter(at, 0) };

  const due = nextDueAt !== null && Date.parse(nextDueAt) <= Date.parse(at);
  const rested = lastPassAt === null || hoursBetween(lastPassAt, at) >= COLD_GAP_HOURS;
  if (!due || !rested) return retention;

  const nextStep = (state === "retained" ? Math.min(step + 1, 4) : 1) as RetentionStep;
  return { state: "retained", step: nextStep, nextDueAt: dueAfter(at, nextStep), lastColdPassAt: at };
}

function nextRecord(record: CriterionRecord, attempted: Attempted): CriterionRecord {
  const { result, criterion, met } = attempted;
  const at = result.endedAt;

  if (!isGating(result.mode)) {
    const { attempts, met: metCount } = record.practice;
    return { ...record, practice: { attempts: attempts + 1, met: metCount + (met ? 1 : 0), lastAt: at } };
  }

  const { margin, measured } = criterion;
  const best =
    met && margin !== null && measured !== null && (record.best === null || margin > record.best.margin)
      ? { attemptId: result.attemptId, at, measured, margin }
      : record.best;
  const gatingMiss = !met && criterion.severity === "fail";
  return {
    ...record,
    last: { attemptId: result.attemptId, at, mode: result.mode, status: met ? "met" : "notMet", measured },
    best,
    firstPassedAt: record.firstPassedAt ?? (met ? at : null),
    passDates: met ? [...record.passDates, at].slice(-PASS_DATES_KEPT) : record.passDates,
    consecutiveFails: met ? 0 : record.consecutiveFails + (gatingMiss ? 1 : 0),
    retention: record.retention === null ? null : nextRetention(record.retention, attempted),
  };
}

function nextLessonRecord(record: LessonRecord, result: CheckResult): LessonRecord {
  if (!isGating(result.mode)) return record;
  const passesNow =
    record.passedAt === null && result.outcome.kind === "passed" && (result.mode === "lesson" || result.mode === "placement");
  return {
    ...record,
    attempts: record.attempts + 1,
    ...(passesNow ? { passedAt: result.endedAt, passedVia: result.mode === "placement" ? "placement" : "lesson" } : {}),
  };
}

/** Every criterion record in the profile. */
export function criterionRecords(profile: SkillProfile): CriterionRecord[] {
  return Object.values(profile.criteria).filter((record) => record !== undefined);
}

const RANK: Readonly<Record<RetentionState, number>> = { notPassed: 0, lapsed: 1, passed: 2, retained: 3 };

/** A Lesson's retention: the worst state of its criteria; `notPassed` without any. Derived, never stored. */
export function lessonRetention(profile: SkillProfile, lessonId: LessonId): RetentionState {
  const states = criterionRecords(profile)
    .filter((record) => record.lessonId === lessonId && record.retention !== null)
    .map((record) => record.retention?.state ?? "notPassed");
  if (states.length === 0) return "notPassed";
  return states.reduce((worst, state) => (RANK[state] < RANK[worst] ? state : worst));
}

/** `final-mix` passed and every Lesson on its route retained. */
export function isCourseComplete(profile: SkillProfile): boolean {
  return (
    profile.lessons["final-mix"]?.passedAt != null &&
    FINAL_MIX_ROUTE.every((lessonId) => lessonRetention(profile, lessonId) === "retained")
  );
}

export interface RetentionChange {
  readonly criterionId: CriterionId;
  readonly from: RetentionState;
  readonly to: RetentionState;
  readonly nextDueAt: IsoTime | null;
}

export interface ReviewTrigger {
  readonly criterionId: CriterionId;
  /** The Lesson that introduced the criterion: the one to suggest as a Review. */
  readonly lessonId: LessonId;
}

export interface ProfileUpdate {
  readonly profile: SkillProfile;
  /** Criteria whose retention state changed, e.g. for "next check-in in 7 days". */
  readonly retentionChanges: readonly RetentionChange[];
  /** Criteria that just reached 3 consecutive gating fails. */
  readonly reviewTriggers: readonly ReviewTrigger[];
}

/**
 * Writes one graded result into the Skill profile. Void attempts are a different type and cannot
 * be passed here. Placement fails write nothing; bonus exercises write only practice counters.
 */
export function applyCheckResult(profile: SkillProfile, result: CheckResult): ProfileUpdate {
  if (result.mode === "placement" && result.outcome.kind === "failed") {
    return { profile, retentionChanges: [], reviewTriggers: [] };
  }

  const measured = result.criteria.filter((criterion) => criterion.status !== "notApplicable");
  const updates = measured.map((criterion) => {
    const before = profile.criteria[criterion.id] ?? newRecord(criterion.id);
    const after = nextRecord(before, {
      result,
      criterion,
      met: criterion.status === "met",
      lastPassAt: before.passDates.at(-1) ?? null,
    });
    return { before, after };
  });

  const criteria = { ...profile.criteria, ...Object.fromEntries(updates.map(({ after }) => [after.criterionId, after])) };
  const lessonBefore = profile.lessons[result.lessonId] ?? newLessonRecord(result.lessonId);
  const lessons = { ...profile.lessons, [result.lessonId]: nextLessonRecord(lessonBefore, result) };
  const updated: SkillProfile = { ...profile, criteria, lessons };
  const completed: SkillProfile =
    updated.courseCompletedAt === null && isCourseComplete(updated) ? { ...updated, courseCompletedAt: result.endedAt } : updated;

  return {
    profile: completed,
    retentionChanges: updates.flatMap(({ before, after }) =>
      before.retention !== null && after.retention !== null && before.retention.state !== after.retention.state
        ? [{ criterionId: after.criterionId, from: before.retention.state, to: after.retention.state, nextDueAt: after.retention.nextDueAt }]
        : [],
    ),
    reviewTriggers: updates.flatMap(({ before, after }) =>
      after.consecutiveFails >= REVIEW_AFTER_FAILS && before.consecutiveFails < REVIEW_AFTER_FAILS
        ? [{ criterionId: after.criterionId, lessonId: after.lessonId }]
        : [],
    ),
  };
}

/** Every criterion currently at or past the Review threshold. */
export function reviewsDue(profile: SkillProfile): ReviewTrigger[] {
  return criterionRecords(profile)
    .filter((record) => record.consecutiveFails >= REVIEW_AFTER_FAILS)
    .map((record) => ({ criterionId: record.criterionId, lessonId: record.lessonId }));
}
