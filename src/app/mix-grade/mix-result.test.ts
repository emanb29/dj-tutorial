import { describe, expect, it } from "vitest";
import type { MixReport, MixTransition } from "@analysis/mix/index.ts";
import { checkLineRequest, NO_LINE_FACTS, toCoachSummary } from "@lessons";
import { CheckLineRequestSchema } from "@shared/coach-contract.ts";
import { deterministicLine } from "@shared/coach-deterministic.ts";
import { emptyLearnerRecord, withOutsidePractice } from "@shared/learner.ts";
import { OutsidePracticeSchema } from "@shared/outside-practice.ts";
import { checkTallies, clock, criterionCaption, mixCheckResult, mixCriterion, mixProblemText, outsidePracticeOf, transitionCaptions, transitionTitle } from "./mix-result.ts";
import { durationProblem, fileProblem, fileProblemText } from "./decode.ts";

const clean: MixTransition = {
  number: 1,
  startSec: 45,
  endSec: 60,
  kind: "blend",
  bpm: 128,
  phraseOffsetBeats: 0,
  drift: { holdShare: 1, worstMs: 0 },
  levelJumpDb: 0.4,
  clippedSec: 0,
  deadAirSec: 0,
  bassClashBeats: 0,
};
const messy: MixTransition = {
  number: 2,
  startSec: 150.2,
  endSec: 150.2,
  kind: "cut",
  bpm: 128,
  phraseOffsetBeats: -3,
  drift: null,
  levelJumpDb: 6.2,
  clippedSec: 0.14,
  deadAirSec: 1.5,
  bassClashBeats: null,
};
const report = (transitions: readonly MixTransition[], extra: Partial<MixReport> = {}): MixReport => ({
  durationSec: 240,
  method: "dj-core-fallback",
  transitions,
  deadAir: [],
  clippedSec: 0,
  peakDbfs: -3,
  warnings: [],
  ...extra,
});
const ATTEMPT = { attemptId: "mix-1", learnerId: "default", startedAt: "2026-10-18T09:00:00.000Z", endedAt: "2026-10-18T09:01:00.000Z" };

describe("a graded mix as the Lessons' criteria", () => {
  it("is clean when every transition meets every check that applies", () => {
    const result = mixCheckResult(report([clean]), ATTEMPT);
    expect(result.outcome).toEqual({ kind: "passed" });
    expect(result.criteria.map((criterion) => [criterion.id, criterion.status])).toEqual([
      ["standing.on-phrase", "met"],
      ["standing.drift", "met"],
      ["standing.level-match", "met"],
      ["standing.no-clip", "met"],
      ["standing.no-dead-air", "met"],
      ["standing.one-bass", "met"],
    ]);
  });

  it("takes the worst transition, and the whole mix for clipping and dead air", () => {
    const graded = report([clean, messy], { clippedSec: 0.2, deadAir: [{ fromSec: 150.2, toSec: 151.7 }] });
    const result = mixCheckResult(graded, ATTEMPT);
    expect(result.outcome).toEqual({ kind: "failed", failedCriteria: ["standing.on-phrase", "standing.level-match", "standing.no-clip", "standing.no-dead-air"] });
    expect(mixCriterion("onPhrase", graded).measured).toBe(3);
    expect(mixCriterion("levels", graded).measured).toBe(6.2);
    expect(mixCriterion("clipping", graded).measured).toBe(0.2);
    expect(mixCriterion("deadAir", graded).measured).toBeCloseTo(1.5);
    // Only the blend has drift and bass: they still pass on it.
    expect(mixCriterion("drift", graded).status).toBe("met");
    expect(checkTallies(graded)).toEqual({
      onPhrase: { met: 1, of: 2 },
      drift: { met: 1, of: 1 },
      levels: { met: 1, of: 2 },
      clipping: { met: 1, of: 2 },
      deadAir: { met: 1, of: 2 },
      oneBass: { met: 1, of: 1 },
    });
  });

  it("leaves out what cannot be judged: no blends, no drift or bass", () => {
    expect(mixCriterion("drift", report([messy])).status).toBe("notApplicable");
    expect(mixCriterion("oneBass", report([messy])).status).toBe("notApplicable");
  });

  it("makes a Coach request the server accepts, and the built-in line names the worst miss", () => {
    const result = mixCheckResult(report([clean, messy], { clippedSec: 0.2 }), ATTEMPT);
    const request = checkLineRequest(result, {
      requestId: "6f1c4a8e-2b7d-4c1e-9a3f-5d8b7e6c4a21",
      lessonTitle: "Your recorded mix",
      attemptToday: 1,
      recentLines: [],
      facts: NO_LINE_FACTS,
      missionTags: [],
    });
    expect(CheckLineRequestSchema.safeParse(request).success).toBe(true);
    // A check that applies to no transition is left out of what the Coach sees.
    const cutsOnly = toCoachSummary(mixCheckResult(report([messy]), ATTEMPT)).criteria.map((criterion) => criterion.id);
    expect(cutsOnly).not.toContain("standing.drift");
    // The furthest from its mark first: 0.2 s of clipping against 0.01.
    expect(deterministicLine(request)).toMatch(/staying out of the red/);
  });

  it("is kept in the record as counts only, which the schema accepts", () => {
    const entry = outsidePracticeOf(report([clean, messy]), "mix-1", ATTEMPT.endedAt);
    expect(OutsidePracticeSchema.parse(entry)).toEqual(entry);
    expect(entry).toMatchObject({ transitions: 2, blends: 1, clean: false, durationSec: 240 });
    expect(Object.keys(entry)).not.toContain("fileName");
    expect(withOutsidePractice(emptyLearnerRecord("default"), entry).ok).toBe(true);
  });
});

describe("captions", () => {
  it("say each check in a few words", () => {
    expect(transitionTitle(clean)).toBe("Blend, 15 s, at 0:45");
    expect(transitionTitle(messy)).toBe("Cut at 2:30");
    expect(transitionCaptions(clean).map((caption) => caption.text)).toEqual([
      "Came in on the phrase",
      "Beats stayed in step",
      "Levels stayed even",
      "No clipping",
      "No dead air",
      "One bassline at a time",
    ]);
    expect(transitionCaptions(messy).map((caption) => [caption.text, caption.met])).toEqual([
      ["Came in 3 beats early for the phrase", false],
      ["6 dB louder after", false],
      ["Clipped for 0.14 s", false],
      ["1.5 s of silence", false],
    ]);
    expect(transitionCaptions({ ...clean, drift: { holdShare: 0.4, worstMs: 72 }, bassClashBeats: 25 }).map((caption) => caption.text)).toContain("Beats drifted, up to 72 ms apart");
    expect(transitionCaptions({ ...clean, bassClashBeats: 25 }).at(-1)?.text).toBe("Both basslines for 25 beats");
    expect(transitionCaptions({ ...clean, bassClashBeats: null, phraseOffsetBeats: null }).map((caption) => caption.text)).toEqual(
      expect.arrayContaining(["Phrase: no steady beat to count", "Bass: too alike to tell apart"]),
    );
  });

  it("sum the mix up per check", () => {
    const graded = report([clean, messy], { clippedSec: 0.2 });
    expect(criterionCaption("onPhrase", graded)).toBe("On the phrase: 1 of 2");
    expect(criterionCaption("clipping", graded)).toBe("Clipping: 0.20 s in all");
    expect(criterionCaption("deadAir", graded)).toBe("No dead air");
    expect(criterionCaption("drift", report([messy]))).toBe("Beats in step: no blends to check");
    expect(clock(75.4)).toBe("1:15");
  });

  it("say what went wrong and what to do, in one line", () => {
    expect(mixProblemText({ kind: "too-short", durationSec: 12, minimumSec: 30 })).toBe("That's 0:12. Pick a mix of at least 30 s.");
    expect(mixProblemText({ kind: "worker-crashed", message: "x" })).toMatch(/Reload/);
  });
});

describe("the file", () => {
  it("must be audio, and under the size limit", () => {
    expect(fileProblem({ name: "mix.mp3", size: 5e6, type: "audio/mpeg" })).toBeNull();
    // Some systems give no type: the extension decides.
    expect(fileProblem({ name: "mix.flac", size: 5e6, type: "" })).toBeNull();
    expect(fileProblem({ name: "set.mp4", size: 5e6, type: "video/mp4" })).toEqual({ kind: "not-audio" });
    expect(fileProblem({ name: "notes.txt", size: 10, type: "text/plain" })).toEqual({ kind: "not-audio" });
    expect(fileProblem({ name: "huge.wav", size: 200 * 1024 * 1024, type: "audio/wav" })).toEqual({ kind: "too-big", bytes: 200 * 1024 * 1024 });
    expect(fileProblem({ name: "empty.wav", size: 0, type: "audio/wav" })).toEqual({ kind: "unreadable" });
  });

  it("must be 30 s to 30 min long", () => {
    expect(durationProblem(29)).toMatchObject({ kind: "too-short" });
    expect(durationProblem(60)).toBeNull();
    expect(durationProblem(31 * 60)).toMatchObject({ kind: "too-long" });
    expect(fileProblemText({ kind: "too-big", bytes: 200 * 1024 * 1024 })).toBe("That's 200 MB. Up to 150 MB: export it as MP3.");
  });
});
