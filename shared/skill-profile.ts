/**
 * The Skill profile: the running record of what a Learner has demonstrated (docs/check-design.md
 * §8–9). Written only from graded `CheckResult`s; times are wall clock (`IsoTime`).
 */
import type { CheckMode, IsoTime, LessonId } from "./attempt.ts";
import type { CriterionId } from "./check-result.ts";

export type RetentionState = "notPassed" | "passed" | "retained" | "lapsed";
/** Index into the retention ladder `[1, 3, 7, 21, 60]` days. */
export type RetentionStep = 0 | 1 | 2 | 3 | 4;

export interface CriterionRetention {
  readonly state: RetentionState;
  readonly step: RetentionStep;
  readonly nextDueAt: IsoTime | null;
  readonly lastColdPassAt: IsoTime | null;
}

export interface CriterionRecord {
  readonly criterionId: CriterionId;
  /** The Lesson that introduced it. */
  readonly lessonId: LessonId;
  readonly last: {
    readonly attemptId: string;
    readonly at: IsoTime;
    readonly mode: CheckMode;
    readonly status: "met" | "notMet";
    /** `null` when there was nothing to measure. */
    readonly measured: number | null;
  } | null;
  readonly best: { readonly attemptId: string; readonly at: IsoTime; readonly measured: number; readonly margin: number } | null;
  readonly firstPassedAt: IsoTime | null;
  /** Gating modes only (not bonus); newest 20, oldest first. */
  readonly passDates: readonly IsoTime[];
  /** Gating modes only; fail-severity misses in a row. */
  readonly consecutiveFails: number;
  /** `null` for standing criteria: they are re-measured in every Check instead. */
  readonly retention: CriterionRetention | null;
  /** Bonus exercises only. */
  readonly practice: { readonly attempts: number; readonly met: number; readonly lastAt: IsoTime | null };
}

export interface LessonRecord {
  readonly lessonId: LessonId;
  readonly passedAt: IsoTime | null;
  readonly passedVia: "lesson" | "placement" | null;
  /** Non-void attempts in gating modes. */
  readonly attempts: number;
  readonly reviewSuggestedAt: IsoTime | null;
  readonly reviewDeclinedAt: IsoTime | null;
  // A Lesson's retention is derived from its CriterionRecords; it is not stored here.
}

export interface SkillProfile {
  readonly schemaVersion: 1;
  readonly learnerId: string;
  readonly lessons: Readonly<Partial<Record<LessonId, LessonRecord>>>;
  readonly criteria: Readonly<Partial<Record<CriterionId, CriterionRecord>>>;
  /** Latched: set once, never cleared. */
  readonly courseCompletedAt: IsoTime | null;
}

export function emptySkillProfile(learnerId: string): SkillProfile {
  return { schemaVersion: 1, learnerId, lessons: {}, criteria: {}, courseCompletedAt: null };
}
