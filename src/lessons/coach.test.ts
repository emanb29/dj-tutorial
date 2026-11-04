import { describe, expect, it } from "vitest";
import { COACH_CRITERIA_MAX, CheckLineRequestSchema, CurriculumRequestSchema } from "@shared/coach-contract.ts";
import { criterionPlainName, deterministicLine, hasPlainName } from "@shared/coach-deterministic.ts";
import type { CheckResult, CriterionResult } from "@shared/check-result.ts";
import { gradableCriteria, type RetentionChange } from "@checks";
import { emptySkillProfile, type CriterionRecord, type SkillProfile } from "@shared/skill-profile.ts";
import type { LessonId } from "@shared/catalogue.ts";
import { emptyLearnerRecord, type LearnerRecord } from "@shared/learner.ts";
import { checkLineRequest, curriculumRequest, describeCriterion, describeCues, lineFacts, skipGroupsPassed, toCoachSummary, withCurriculum } from "./coach.ts";

const NO_FACTS = { focusHistory: [], bestMarginBefore: null, retentionChange: null } as const;

const fadeOut: CriterionResult = {
  id: "deck-basics.fade-out",
  severity: "fail",
  status: "notMet",
  measured: 0.4,
  unit: "position",
  threshold: { op: "<=", value: 0, unit: "position" },
  margin: -1,
  evidence: [],
};

const beatTaps: CriterionResult = {
  id: "beats-and-bars.beat-taps",
  severity: "fail",
  status: "met",
  measured: 0.9375,
  unit: "ratio",
  threshold: { op: ">=", value: 0.9, unit: "ratio" },
  margin: 0.04,
  evidence: [],
  detail: { matched: 30, extras: 1, targets: 32 },
};

const skipped: CriterionResult = { ...beatTaps, id: "standing.no-clip", status: "notApplicable", measured: null, margin: null };

const result: CheckResult = {
  schemaVersion: 1,
  attemptId: "a1",
  learnerId: "default",
  lessonId: "deck-basics",
  mode: "lesson",
  variant: "full",
  startedAt: "2026-10-17T10:00:00.000Z",
  endedAt: "2026-10-17T10:00:20.000Z",
  inputDevice: "keyboard",
  endReason: "done",
  outcome: { kind: "failed", failedCriteria: ["deck-basics.fade-out"] },
  criteria: [fadeOut, beatTaps, skipped],
  tracks: [],
  aids: { sync: false, quantize: false, bpmDisplay: false, phaseMeter: false, lessonText: true },
  metrics: { medianTapOffsetMs: 12 },
};

describe("toCoachSummary", () => {
  it("keeps what the Coach may see, in the units its contract knows", () => {
    expect(toCoachSummary(result)).toEqual({
      lessonId: "deck-basics",
      mode: "lesson",
      variant: "full",
      outcome: "failed",
      criteria: [
        { id: "deck-basics.fade-out", severity: "fail", status: "notMet", measured: 0.4, unit: "ratio", threshold: { op: "<=", value: 0, unit: "ratio" }, margin: -1 },
        { id: "beats-and-bars.beat-taps", severity: "fail", status: "met", measured: 0.9375, unit: "ratio", threshold: { op: ">=", value: 0.9, unit: "ratio" }, margin: 0.04 },
      ],
      metrics: { medianTapOffsetMs: 12 },
    });
  });

  it("builds a request the server accepts", () => {
    const request = checkLineRequest(result, { requestId: "6f1c1f0e-8a8b-4c39-9d43-1f2a3b4c5d6e", lessonTitle: "Play a track out loud", attemptToday: 2, recentLines: ["x"], facts: NO_FACTS, missionTags: [] });
    expect(CheckLineRequestSchema.safeParse(request).success).toBe(true);
  });

  // ISS-136: a criterion not met with nothing measured ("not within 32 bars") was dropped, so the
  // line's "One thing to fix" named the passed no-clip criterion instead.
  it("keeps a criterion not met with nothing measured, so the line names what failed", () => {
    const tempoMatch: CriterionResult = {
      id: "tempo-by-ear.tempo-match",
      severity: "fail",
      status: "notMet",
      measured: null,
      unit: "bars",
      threshold: { op: "<=", value: 32, unit: "bars" },
      margin: null,
      evidence: [],
    };
    const noClip: CriterionResult = {
      id: "standing.no-clip",
      severity: "fail",
      status: "met",
      measured: -7.59,
      unit: "dBFS",
      threshold: { op: "<", value: -0.1, unit: "dBFS" },
      margin: 7.49,
      evidence: [],
    };
    const tempoResult: CheckResult = {
      ...result,
      lessonId: "tempo-by-ear",
      outcome: { kind: "failed", failedCriteria: ["tempo-by-ear.tempo-match"] },
      criteria: [tempoMatch, noClip],
    };
    expect(toCoachSummary(tempoResult).criteria.map((criterion) => [criterion.id, criterion.status])).toEqual([
      ["tempo-by-ear.tempo-match", "notMet"],
      ["standing.no-clip", "met"],
    ]);
    for (const attemptToday of [1, 2, 3]) {
      const request = checkLineRequest(tempoResult, { requestId: "6f1c1f0e-8a8b-4c39-9d43-1f2a3b4c5d6e", lessonTitle: "Match tempo by ear", attemptToday, recentLines: [], facts: NO_FACTS, missionTags: [] });
      expect(CheckLineRequestSchema.safeParse(request).success).toBe(true);
      const line = deterministicLine(request);
      expect(line).toContain("matching the tempo by ear");
      expect(line).not.toContain("staying out of the red");
    }
  });

  it("keeps every criterion not met when there are more criteria than the Coach takes", () => {
    const passes = Array.from({ length: COACH_CRITERIA_MAX }, () => beatTaps);
    const crowded: CheckResult = { ...result, criteria: [...passes, fadeOut] };
    expect(toCoachSummary(crowded).criteria.map((criterion) => criterion.status)).toContain("notMet");
  });
});

describe("no caption shows a criterion's internal id", () => {
  // The id's own name ("cfx-back"), or the whole id: hyphenated names only, since a one-word name ("hold") is a word.
  const idsOf = (id: string) => [id, ...(id.split(".")[1]?.includes("-") === true ? [id.split(".")[1] ?? id] : [])];

  it.each(gradableCriteria())("%s has a plain name, and its result lines never show the id", (id) => {
    expect(hasPlainName(id)).toBe(true);
    const lines = (["met", "notMet"] as const).flatMap((status) =>
      [1, null].map((measured) =>
        describeCriterion({ id, severity: "fail", status, measured, unit: "count", threshold: { op: "<=", value: 1, unit: "count" }, margin: null, evidence: [] }),
      ),
    );
    const failed = { id, severity: "fail", status: "notMet", measured: 2, unit: "count", threshold: { op: "<=", value: 1, unit: "count" }, margin: -1 } as const;
    const coachLines = [0, 1, 2].map((attemptToday) =>
      deterministicLine({
        requestId: "7d6f8e0a-2b8c-4b3e-9a51-1f2d3c4b5a69",
        result: { lessonId: "crossfader", mode: "lesson", variant: "full", outcome: "failed", criteria: [failed, { ...failed, id: "standing.no-clip", margin: 0 }], metrics: {} },
        context: { lessonTitle: "x", focusHistory: [], bestMarginBefore: null, retentionChange: null, attemptToday, missionTags: [], recentLines: [] },
      }),
    );
    for (const line of [...lines, ...coachLines, criterionPlainName(id)]) {
      for (const leak of idsOf(id)) expect(line.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });
});

describe("describeCriterion", () => {
  it("says taps in plain words: how many landed and how many are needed", () => {
    expect(describeCriterion(beatTaps)).toBe("Beats: 30 of 32 on time (need 29), 1 extra");
  });

  it("says where the fader ended", () => {
    expect(describeCriterion(fadeOut)).toBe("Fade out: fader ended at 40% (needs 0%)");
  });

  it("names a passed loop by its whole bars, and keeps two decimals on one that failed", () => {
    const loopLength = (status: CriterionResult["status"], measured: number, loopBeats: number): CriterionResult => ({
      id: "loop-transition.loop-length", severity: "fail", status, measured, unit: "ms", threshold: { op: "<=", value: 60, unit: "ms" }, margin: null, evidence: [], detail: { loopBeats },
    });
    expect(describeCriterion(loopLength("met", 9, 16.04))).toBe("Loop: 4 bars, 9 ms off 4 or 8 bars (need 60 or less)");
    expect(describeCriterion(loopLength("met", 9, 15.96))).toBe("Loop: 4 bars, 9 ms off 4 or 8 bars (need 60 or less)");
    expect(describeCriterion(loopLength("notMet", 280, 15))).toBe("Loop: 3.75 bars, 280 ms off 4 or 8 bars (need 60 or less)");
  });

  const criterion = (id: CriterionResult["id"], measured: number | null, unit: CriterionResult["unit"], value: number, detail?: Record<string, number>): CriterionResult => ({
    id,
    severity: "fail",
    status: "met",
    measured,
    unit,
    threshold: { op: "<=", value, unit },
    margin: null,
    evidence: [],
    ...(detail === undefined ? {} : { detail }),
  });

  it("words the Lessons 4–7 criteria: levels, cue points and the cut", () => {
    expect(describeCriterion({ ...criterion("gain-staging.trim-A", -3.24, "dBFS", 0), threshold: { op: "in", value: [-6, -0.1], unit: "dBFS" } })).toBe(
      "Deck A peak: −3.2 dBFS (need −6 to −0.1)",
    );
    expect(describeCriterion(criterion("gain-staging.trim-B", null, "dBFS", 0))).toBe("Deck B: no Ready (R) with 8 bars after it");
    expect(describeCriterion(criterion("gain-staging.loud-match", 0.84, "dB", 1.5))).toBe("A and B loudness: 0.8 dB apart (need 1.5 or less)");
    expect(describeCriterion({ ...criterion("headphone-cue.cued-taps", 0.9, "ratio", 0.85, { matched: 29, targets: 32, extras: 0 }), threshold: { op: ">=", value: 0.85, unit: "ratio" } })).toBe(
      "B's beats: 29 of 32 on time (need 28)",
    );
    expect(describeCriterion(criterion("headphone-cue.b-off-master", -120, "dB", -60, { cueOnFraction: 0.97 }))).toBe("B off the speakers: fader down, CUE on 97% of the taps (need 95%)");
    expect(describeCriterion(criterion("headphone-cue.b-off-master", -6, "dB", -60, { cueOnFraction: 1 }))).toBe("B reached the speakers: fader B came up");
    expect(describeCriterion(criterion("cue-point.cue-on-downbeat", 12.4, "ms", 20, { tracks: 3, wrongBeat: 1, missing: 0 }))).toBe(
      "Cue points: worst 12 ms off the beat (need 20 or less), 1 not on a 1",
    );
    expect(describeCriterion(criterion("cut-on-phrase.cut-start", 35.2, "ms", 120))).toBe("Cut: 35 ms from the phrase start (need 120 or less)");
    expect(describeCriterion(criterion("cut-on-phrase.cut-start", null, "ms", 120))).toBe("Cut: B never came in");
    expect(describeCriterion(criterion("cut-on-phrase.cut-tight", 0.42, "beats", 1))).toBe("A out 0.42 beats from B in (need 1 or less)");
    expect(describeCriterion({ ...criterion("cut-on-phrase.cued-before", 6.1, "s", 2), threshold: { op: ">=", value: 2, unit: "s" } })).toBe("CUE B on 6.1 s before the cut (need 2)");
    expect(describeCriterion(criterion("cut-on-phrase.loud-jump", 0.31, "dB", 2))).toBe("Level jump at the cut: 0.3 dB (need 2 or less)");
  });

  it("gives one line per cue point: ms early or late, the wrong beat, or not set", () => {
    const cues = criterion("cue-point.cue-on-downbeat", 34.2, "ms", 20, {
      tracks: 5,
      wrongBeat: 1,
      missing: 1,
      "cue1.offsetMs": -12.4,
      "cue1.beat": 1,
      "cue2.offsetMs": 34.2,
      "cue2.beat": 1,
      "cue3.offsetMs": 3,
      "cue3.beat": 3,
      "cue5.offsetMs": 0.2,
      "cue5.beat": 1,
    });
    expect(describeCues(cues)).toEqual([
      { met: true, text: "Cue 1: 12 ms early" },
      { met: false, text: "Cue 2: 34 ms late" },
      { met: false, text: "Cue 3: on beat 3, not the 1" },
      { met: false, text: "Cue 4: not set" },
      { met: true, text: "Cue 5: on the 1" },
    ]);
  });

  it("gives no cue lines for other criteria, or for a result saved before the per-cue detail", () => {
    expect(describeCues(criterion("cut-on-phrase.cut-start", 35.2, "ms", 120))).toEqual([]);
    expect(describeCues(criterion("cue-point.cue-on-downbeat", 12.4, "ms", 20, { tracks: 3, wrongBeat: 1, missing: 0 }))).toEqual([]);
    expect(describeCues(criterion("cue-point.cue-on-downbeat", null, "ms", 20, { tracks: 2, wrongBeat: 0, missing: 2 }))).toEqual([
      { met: false, text: "Cue 1: not set" },
      { met: false, text: "Cue 2: not set" },
    ]);
  });

  it("words the Lessons 8–11 criteria: BPMs, clips, the blend, the crossfader and the LOW", () => {
    expect(describeCriterion(criterion("tempo-fader.set-bpm", 0.031, "BPM", 0.05, { targets: 3, confirmed: 3 }))).toBe("BPMs: worst 0.03 BPM off (need 0.05 or less)");
    expect(describeCriterion(criterion("tempo-fader.set-bpm", null, "BPM", 0.05, { targets: 3, confirmed: 2 }))).toBe("BPMs set: 2 of 3 confirmed with Ready");
    expect(describeCriterion({ ...criterion("tempo-fader.master-tempo-ear", 1, "count", 2), threshold: { op: ">=", value: 2, unit: "count" } })).toBe("Master Tempo clips: 1 of 2 right");
    expect(describeCriterion(criterion("sync-blend.blend-start", 0.25, "beats", 1))).toBe("Blend start: 0.25 beats from the phrase start (need 1 or less)");
    expect(describeCriterion({ ...criterion("sync-blend.blend-length", 9.4, "bars", 0), threshold: { op: "in", value: [7.75, 16.25], unit: "bars" } })).toBe("Blend: 9.4 bars (need 8–16)");
    expect(describeCriterion(criterion("sync-blend.loud-steady", 1.24, "dB", 3))).toBe("Level through the blend: moved 1.2 dB (need 3 or less)");
    expect(describeCriterion(criterion("crossfader.xf-blend", 0.2, "beats", 1))).toBe("Crossfader blend: on the phrase, 8–16 bars, level steady");
    expect(describeCriterion({ ...criterion("crossfader.xf-cut", 150, "ms", 80), status: "notMet" })).toBe("Cut to A: 150 ms from the phrase start (need 80 or less)");
    expect(describeCriterion({ ...criterion("crossfader.xf-blend", null, "beats", 1), status: "notMet" })).toBe("Blend start: B never came in");
    expect(describeCriterion(criterion("crossfader.faders-up", 0.6, "position", 0.95))).toBe("Channel faders: lowest at 60% (keep both up)");
    expect(describeCriterion({ ...criterion("eq-basics.low-kill", 7.9, "bars", 7), threshold: { op: ">=", value: 7, unit: "bars" } })).toBe("LOW cut: 7.9 bars at the bottom (need 7 or more)");
    expect(describeCriterion(criterion("eq-basics.low-return", 0.3, "beats", 1))).toBe("LOW back 0.30 beats from the phrase start (need 1 or less)");
    expect(describeCriterion(criterion("eq-basics.eq-centred", 0, "dB", 1))).toBe("EQs at the end: 0.0 dB from the middle at most (need 1 or less)");
  });

  it("words the Lessons 12–13 criteria: LOW B in, the swap, two basslines and the CFX sweep", () => {
    expect(describeCriterion(criterion("bass-swap.enter-low-cut", -120, "dB", -20))).toBe("LOW B as B came in: all the way down");
    expect(describeCriterion(criterion("bass-swap.enter-low-cut", -8.5, "dB", -20))).toBe("LOW B as B came in: −8.5 dB (need −20 or lower)");
    expect(describeCriterion(criterion("bass-swap.enter-low-cut", null, "dB", -20))).toBe("LOW B as B came in: B never came in");
    expect(describeCriterion(criterion("bass-swap.swap-time", 0.42, "beats", 1))).toBe("Bass swap 0.42 beats from the phrase start (need 1 or less)");
    expect(describeCriterion(criterion("bass-swap.swap-time", null, "beats", 1))).toBe("Bass swap: the LOWs never swapped while both played");
    expect(describeCriterion(criterion("bass-swap.clash-short", 0, "beats", 1))).toBe("Two basslines at once: 0.00 beats (need 1 or less)");
    expect(describeCriterion({ ...criterion("filter-transition.hpf-depth", 0.84, "ratio", 0.7), threshold: { op: ">=", value: 0.7, unit: "ratio" } })).toBe("CFX A: up to 84% high-pass (need 70%)");
    expect(describeCriterion({ ...criterion("filter-transition.filter-length", 7.94, "bars", 0), threshold: { op: "in", value: [7.75, 16.25], unit: "bars" } })).toBe(
      "Filter on 7.9 bars before A went out (need 8–16)",
    );
    expect(describeCriterion(criterion("filter-transition.filter-length", null, "bars", 0))).toBe("Filter: no sweep was still on as A went out");
    expect(describeCriterion(criterion("filter-transition.cfx-back", -0.86, "bars", 0))).toBe("CFX A back in the middle before A was heard again");
    expect(describeCriterion({ ...criterion("filter-transition.cfx-back", null, "bars", 0), status: "notMet" })).toBe("CFX A: not back in the middle by the end");
    expect(describeCriterion({ ...criterion("filter-transition.cfx-back", 1, "bars", 0), status: "notMet" })).toBe("CFX A: still filtered when A came back in");
  });
});

describe("the Curriculum re-plan when a skip group is passed (coach-design §1 a)", () => {
  const passed = (...ids: LessonId[]): LearnerRecord["skillProfile"] => ({
    ...emptyLearnerRecord("default").skillProfile,
    lessons: Object.fromEntries(ids.map((id) => [id, { lessonId: id, passedAt: "2026-10-17T10:00:00.000Z", passedVia: "lesson", attempts: 1, reviewSuggestedAt: null, reviewDeclinedAt: null }])),
  });

  it("finds a skip group passed by this result: Timing once phrases joins beats-and-bars", () => {
    expect(skipGroupsPassed(passed("deck-basics", "beats-and-bars"), passed("deck-basics", "beats-and-bars", "phrases"))).toEqual(["timing"]);
    expect(skipGroupsPassed(passed("deck-basics"), passed("deck-basics", "beats-and-bars"))).toEqual([]);
    expect(skipGroupsPassed(passed("beats-and-bars", "phrases"), passed("beats-and-bars", "phrases"))).toEqual([]);
  });

  it("asks with the Mission, every demonstrated Lesson and this result, and the server accepts it", () => {
    const record: LearnerRecord = { ...emptyLearnerRecord("default"), mission: "post my mixes", skillProfile: passed("deck-basics", "beats-and-bars", "phrases") };
    const request = curriculumRequest(record, result, "6f1c1f0e-8a8b-4c39-9d43-1f2a3b4c5d6e");
    expect(request).toMatchObject({ mission: "post my mixes", demonstrated: ["deck-basics", "beats-and-bars", "phrases"], reason: "skipGroupPassed" });
    expect(request.placementResults).toEqual([toCoachSummary(result)]);
    expect(CurriculumRequestSchema.safeParse(request).success).toBe(true);
  });

  it("stores the Curriculum, and the Mission tags only when the Coach (not the fallback) chose them", () => {
    const record: LearnerRecord = { ...emptyLearnerRecord("default"), missionTags: ["record-mixes"] };
    const data = { job: "curriculum", curriculum: ["gain-staging", "final-mix"], missionTags: ["edits"], electiveNotes: {} } as const;
    expect(withCurriculum(record, { source: "llm", data })).toMatchObject({ curriculum: ["gain-staging", "final-mix"], missionTags: ["edits"] });
    expect(withCurriculum(record, { source: "fallback", data: { ...data, missionTags: [] } })).toMatchObject({
      curriculum: ["gain-staging", "final-mix"],
      missionTags: ["record-mixes"],
    });
  });
});

describe("lineFacts: what the Coach line knows beyond this result", () => {
  const record = (margin: number): CriterionRecord => ({
    criterionId: "deck-basics.fade-out",
    lessonId: "deck-basics",
    last: null,
    best: { attemptId: "a0", at: "2026-10-16T10:00:00.000Z", measured: 0, margin },
    firstPassedAt: null,
    passDates: [],
    consecutiveFails: 1,
    retention: null,
    practice: { attempts: 0, met: 0, lastAt: null },
  });
  const before: SkillProfile = { ...emptySkillProfile("default"), criteria: { "deck-basics.fade-out": record(0.3) } };

  it("follows the focus criterion (the one not met): its margins this session and its best before", () => {
    const facts = lineFacts(result, { profileBefore: before, retentionChanges: [], marginHistory: { "deck-basics.fade-out": [-1, -0.5], "beats-and-bars.beat-taps": [0.2] } });
    expect(facts).toEqual({ focusHistory: [-1, -0.5], bestMarginBefore: 0.3, retentionChange: null });
  });

  it("has no history or best for a criterion never graded before", () => {
    const facts = lineFacts(result, { profileBefore: emptySkillProfile("default"), retentionChanges: [], marginHistory: {} });
    expect(facts).toEqual({ focusHistory: [], bestMarginBefore: null, retentionChange: null });
  });

  it("says the focus criterion's retention change in words, with days to the next check-in", () => {
    const change = (to: RetentionChange["to"], nextDueAt: string | null): RetentionChange => ({ criterionId: "deck-basics.fade-out", from: "passed", to, nextDueAt });
    const facts = (changes: readonly RetentionChange[]) => lineFacts(result, { profileBefore: before, retentionChanges: changes, marginHistory: {} }).retentionChange;
    expect(facts([change("retained", "2026-10-24T10:00:20.000Z")])).toBe("retained, next in 7 days");
    expect(facts([change("passed", "2026-10-18T10:00:20.000Z")])).toBe("passed, next in 1 day");
    expect(facts([change("lapsed", null)])).toBe("lapsed");
    // An unreadable date never becomes "next in NaN days".
    expect(facts([change("passed", "not a date")])).toBe("passed");
    // Another criterion's change is not about the line's focus.
    expect(facts([{ ...change("retained", "2026-10-24T10:00:20.000Z"), criterionId: "beats-and-bars.beat-taps" }])).toBeNull();
  });

  it("goes into the line request with the Mission tags, and the server accepts it", () => {
    const request = checkLineRequest(result, {
      requestId: "6f1c1f0e-8a8b-4c39-9d43-1f2a3b4c5d6e",
      lessonTitle: "Play a track out loud",
      attemptToday: 3,
      recentLines: [],
      facts: { focusHistory: [-1, -0.5], bestMarginBefore: 0.3, retentionChange: "retained, next in 7 days" },
      missionTags: ["record-mixes", "edits"],
    });
    expect(request.context).toMatchObject({
      focusHistory: [-1, -0.5],
      bestMarginBefore: 0.3,
      retentionChange: "retained, next in 7 days",
      missionTags: ["record-mixes", "edits"],
    });
    expect(CheckLineRequestSchema.safeParse(request).success).toBe(true);
  });
});
