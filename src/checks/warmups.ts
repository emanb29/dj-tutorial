// Warm-up scheduling (check-design §7.2, owner decision C1): at most 5 minutes, about 2 skills.
import { LESSON_IDS, type IsoTime, type LessonId } from "@shared/attempt.ts";
import type { SkillProfile } from "@shared/skill-profile.ts";
import { criterionRecords } from "./profile.ts";

export interface WarmupLimits {
  readonly maxLessons: number;
  readonly maxSeconds: number;
}

/** C1: warm-ups are capped at 5 minutes per session, at most 2 skills. */
export const WARMUP_LIMITS: WarmupLimits = { maxLessons: 2, maxSeconds: 300 };

/**
 * Estimated length of each Lesson's short form, seconds (Placement design §4.1 timings; attempts
 * last under a minute). Lessons without a short form yet are budgeted at a minute.
 */
const SHORT_FORM_SECONDS: Readonly<Partial<Record<LessonId, number>>> = {
  "deck-basics": 20,
  "beats-and-bars": 25,
  phrases: 60,
  "gain-staging": 30,
  "headphone-cue": 20,
  "cue-point": 20,
  "cut-on-phrase": 55,
};
const DEFAULT_SHORT_FORM_SECONDS = 60;

export interface WarmupPlan {
  /** Run these, in order, at the start of the session. */
  readonly lessons: readonly LessonId[];
  /** Due but over this session's budget: first in line next session. */
  readonly rolledOver: readonly LessonId[];
}

/**
 * The due list: Lessons with any criterion due (`nextDueAt ≤ now`), most overdue first, ties in
 * catalogue order. `final-mix` is never a warm-up: its cold re-play is the recorded final project.
 */
export function scheduleWarmups(profile: SkillProfile, now: IsoTime, limits: WarmupLimits = WARMUP_LIMITS): WarmupPlan {
  const nowMs = Date.parse(now);
  const mostOverdue = new Map<LessonId, number>();
  for (const record of criterionRecords(profile)) {
    const retention = record.retention;
    if (retention === null || retention.state === "notPassed" || retention.nextDueAt === null) continue;
    if (record.lessonId === "final-mix") continue;
    const dueMs = Date.parse(retention.nextDueAt);
    if (dueMs > nowMs) continue;
    mostOverdue.set(record.lessonId, Math.min(dueMs, mostOverdue.get(record.lessonId) ?? Infinity));
  }

  const due = [...mostOverdue.entries()]
    .sort(([lessonA, dueA], [lessonB, dueB]) => dueA - dueB || LESSON_IDS.indexOf(lessonA) - LESSON_IDS.indexOf(lessonB))
    .map(([lessonId]) => lessonId);

  const lessons: LessonId[] = [];
  let seconds = 0;
  for (const lessonId of due) {
    const length = SHORT_FORM_SECONDS[lessonId] ?? DEFAULT_SHORT_FORM_SECONDS;
    // Over budget: it rolls over and stays the most overdue, so it is first next session; a shorter one fills the gap.
    if (lessons.length >= limits.maxLessons || seconds + length > limits.maxSeconds) continue;
    lessons.push(lessonId);
    seconds += length;
  }
  return { lessons, rolledOver: due.filter((lessonId) => !lessons.includes(lessonId)) };
}
