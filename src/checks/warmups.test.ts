import { describe, expect, it } from "vitest";
import type { LessonId } from "@shared/attempt.ts";
import type { CriterionId } from "@shared/check-result.ts";
import { emptySkillProfile, type CriterionRecord, type RetentionState, type SkillProfile } from "@shared/skill-profile.ts";
import { scheduleWarmups } from "./warmups.ts";

const NOW = "2026-10-17T09:00:00.000Z";

function record(lessonId: LessonId, name: string, state: RetentionState, nextDueAt: string | null): CriterionRecord {
  return {
    criterionId: `${lessonId}.${name}` as CriterionId,
    lessonId,
    last: null,
    best: null,
    firstPassedAt: null,
    passDates: [],
    consecutiveFails: 0,
    retention: { state, step: 0, nextDueAt, lastColdPassAt: null },
    practice: { attempts: 0, met: 0, lastAt: null },
  };
}

function profileWith(...records: readonly CriterionRecord[]): SkillProfile {
  return { ...emptySkillProfile("learner-1"), criteria: Object.fromEntries(records.map((entry) => [entry.criterionId, entry])) };
}

describe("scheduleWarmups", () => {
  it("schedules nothing when nothing is due", () => {
    const profile = profileWith(record("phrases", "phrase-taps", "passed", "2026-10-18T00:00:00.000Z"));

    expect(scheduleWarmups(profile, NOW)).toEqual({ lessons: [], rolledOver: [] });
  });

  it("takes the most overdue Lessons first, at most 2 per session, and rolls the rest over", () => {
    const profile = profileWith(
      record("phrases", "phrase-taps", "retained", "2026-10-16T09:00:00.000Z"),
      record("cue-point", "cue-on-downbeat", "passed", "2026-10-10T09:00:00.000Z"),
      record("beats-and-bars", "beat-taps", "passed", "2026-10-15T09:00:00.000Z"),
      record("beats-and-bars", "downbeat-taps", "passed", "2026-10-20T09:00:00.000Z"),
    );

    expect(scheduleWarmups(profile, NOW)).toEqual({ lessons: ["cue-point", "beats-and-bars"], rolledOver: ["phrases"] });
  });

  it("counts a criterion due exactly now, and lapsed criteria, as due", () => {
    const profile = profileWith(record("phrases", "phrase-taps", "lapsed", NOW));

    expect(scheduleWarmups(profile, NOW).lessons).toEqual(["phrases"]);
  });

  it("never schedules Lessons not passed yet, standing criteria, or final-mix (its re-play is the final project)", () => {
    const standing: CriterionRecord = { ...record("gain-staging", "x", "passed", null), criterionId: "standing.no-clip", retention: null };
    const profile = profileWith(
      record("phrases", "phrase-taps", "notPassed", null),
      record("final-mix", "on-phrase", "passed", "2026-10-01T00:00:00.000Z"),
      standing,
    );

    expect(scheduleWarmups(profile, NOW)).toEqual({ lessons: [], rolledOver: [] });
  });

  it("breaks ties in catalogue order", () => {
    const due = "2026-10-16T00:00:00.000Z";
    const profile = profileWith(
      record("cut-on-phrase", "cut-start", "passed", due),
      record("deck-basics", "fade-in", "passed", due),
      record("phrases", "phrase-taps", "passed", due),
    );

    expect(scheduleWarmups(profile, NOW).lessons).toEqual(["deck-basics", "phrases"]);
  });

  it("keeps within the time budget, filling it with a shorter due Lesson when the next one does not fit", () => {
    const profile = profileWith(
      record("cut-on-phrase", "cut-start", "passed", "2026-10-10T00:00:00.000Z"),
      record("phrases", "phrase-taps", "passed", "2026-10-11T00:00:00.000Z"),
      record("cue-point", "cue-on-downbeat", "passed", "2026-10-12T00:00:00.000Z"),
    );

    expect(scheduleWarmups(profile, NOW, { maxLessons: 2, maxSeconds: 80 })).toEqual({
      lessons: ["cut-on-phrase", "cue-point"],
      rolledOver: ["phrases"],
    });
  });

  it("puts a Lesson skipped for time first in line next session, since it stays the most overdue", () => {
    const profile = profileWith(
      record("phrases", "phrase-taps", "passed", "2026-10-11T00:00:00.000Z"),
      record("cue-point", "cue-on-downbeat", "passed", "2026-10-12T00:00:00.000Z"),
    );
    const today = scheduleWarmups(profile, NOW, { maxLessons: 2, maxSeconds: 30 });
    // Next session: cue-point was re-passed today, so only phrases is still due.
    const afterToday = profileWith(
      record("phrases", "phrase-taps", "passed", "2026-10-11T00:00:00.000Z"),
      record("cue-point", "cue-on-downbeat", "retained", "2026-10-20T05:00:00.000Z"),
    );

    expect(today).toEqual({ lessons: ["cue-point"], rolledOver: ["phrases"] });
    expect(scheduleWarmups(afterToday, "2026-10-18T09:00:00.000Z").lessons[0]).toBe("phrases");
  });
});
