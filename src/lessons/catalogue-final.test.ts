import { describe, expect, it } from "vitest";
import type { Attempt } from "@shared/attempt.ts";
import { attempt, frames, SILENT } from "@checks/testing/synthetic.ts";
import {
  COURSE,
  FINAL_MIX,
  camelotOf,
  finalMixMode,
  finalMixSpec,
  finalMixWindow,
  keysCompatible,
  preparedTrack,
  setEntry,
  setNotesText,
  setProblems,
  warningText,
  type SetCandidate,
} from "./catalogue-final.ts";
import { syntheticLessonTrack, SYNTHETIC_HOUSE } from "./synthetic-track.ts";

function candidate(id: string, bpm: number, overrides: Partial<SetCandidate> = {}): SetCandidate {
  const track = syntheticLessonTrack({ ...SYNTHETIC_HOUSE, bpm, id, title: id });
  return { track, artist: "learn-to-dj", genre: "house", camelot: "8A", shareable: true, ...overrides };
}

describe("the final-mix set builder", () => {
  it("lists the set after every built Lesson, and covers sync, the BPM displays and the phase meter", () => {
    expect(COURSE.at(-1)).toEqual(FINAL_MIX);
    expect(FINAL_MIX.lockedOff).toEqual(expect.arrayContaining(["A.sync", "B.sync", "A.bpm", "B.bpm", "phase-meter"]));
  });

  it("blocks a set of fewer than 3 tracks, mixed genres, an untagged file or an uneven grid, with every reason at once", () => {
    const uneven = candidate("uneven", 124);
    const problems = setProblems([
      setEntry(candidate("one", 124)),
      setEntry(candidate("two", 124, { genre: "bass music" })),
      setEntry(candidate("file", 124, { genre: null })),
      setEntry({ ...uneven, track: { ...uneven.track, grid: { ...uneven.track.grid, rmsResidualMs: 18 } } }),
    ]);
    expect(problems.blocking).toEqual([
      "Give 1 track(s) a genre.",
      "One genre per set: you have house, bass music. Take some out, or retag them.",
      `"uneven": this track's beat grid is too uneven to grade; pick another.`,
    ]);
    expect(setProblems([setEntry(candidate("one", 124))]).blocking).toEqual(["Pick 2 more track(s): a set needs 3."]);
  });

  it("warns, without blocking, when a tempo is over 2% from track 1 or keys clash", () => {
    const entries = [setEntry(candidate("one", 124)), setEntry(candidate("two", 126.6, { camelot: "9A" })), setEntry(candidate("three", 124, { camelot: "3B" }))];
    const { blocking, warnings } = setProblems(entries);
    expect(blocking).toEqual([]);
    expect(warnings).toEqual([
      { kind: "tempo", index: 1, apartPercent: expect.closeTo(2.1, 1) as number },
      { kind: "key", index: 2, from: "9A", to: "3B" },
    ]);
    const [tempo, key] = warnings;
    if (tempo === undefined || key === undefined) throw new Error("expected two warnings");
    expect(warningText(tempo, entries)).toContain("the Check allows 2%");
    expect(warningText(key, entries)).toContain("Allowed");
  });

  it("reads Camelot keys and knows the harmonic moves", () => {
    expect(camelotOf("8A (A minor)")).toBe("8A");
    expect(camelotOf("12b")).toBe("12B");
    expect(camelotOf("A minor")).toBeNull();
    expect(keysCompatible("8A", "9A")).toBe(true);
    expect(keysCompatible("12A", "1A")).toBe(true);
    expect(keysCompatible("8A", "8B")).toBe(true);
    expect(keysCompatible("8A", "10A")).toBe(false);
    expect(keysCompatible("8A", "9B")).toBe(false);
  });

  it("moves the phrase markers by whole bars in track prep", () => {
    const entry = { ...setEntry(candidate("one", 120)), phraseShiftBars: 2 };
    expect(preparedTrack(entry).phraseStarts[0]).toBeCloseTo(4);
    expect(preparedTrack({ ...entry, phraseShiftBars: 0 }).phraseStarts[0]).toBe(0);
  });
});

describe("grading a set", () => {
  const recorded = (): Attempt =>
    attempt({
      decks: {
        A: { trackId: "one", playhead: { segments: [{ fromCtx: 0, pos: 30, rate: 0 }, { fromCtx: 10.2, pos: 0, rate: 0 }, { fromCtx: 11, pos: 0, rate: 1 }] }, loadedCtx: 0 },
        B: { trackId: "two", playhead: { segments: [{ fromCtx: 10.3, pos: 0, rate: 0 }] }, loadedCtx: 0 },
      },
      meters: { master: frames(10, 60, (t) => (t < 50 ? { peak: -3, momentary: -14 } : SILENT)) },
    });

  it("grades from the set's own cue to the end of the last master audio", () => {
    const window = finalMixWindow(recorded(), 10, 60);
    expect(window.from).toBeCloseTo(10.3);
    expect(window.to).toBeCloseTo(50);
  });

  it("builds an exam spec: aids off, genres as tagged, the set in play order", () => {
    const entries = [setEntry(candidate("one", 124)), { ...setEntry(candidate("two", 124)), genre: "House" }];
    const spec = finalMixSpec(
      entries.map((entry, index) => ({ entry, deck: index % 2 === 0 ? ("A" as const) : ("B" as const) })),
      recorded(),
      { startedCtx: 10, endedCtx: 60, passedLessons: ["blend-by-ear"], mode: "lesson" },
    );
    expect(spec.task).toEqual({ lessonId: "final-mix", set: [{ trackId: "one", genre: "house", camelot: "8A" }, { trackId: "two", genre: "house", camelot: "8A" }] });
    expect(spec.aids).toEqual({ sync: false, quantize: false, bpmDisplay: false, phaseMeter: false, lessonText: false });
    expect(spec.tracks.map((track) => track.deck)).toEqual(["A", "B"]);
  });

  it("is a rehearsal until passed, then the cold re-pass that is the final project", () => {
    const profile = { schemaVersion: 1 as const, learnerId: "l", lessons: {}, criteria: {}, courseCompletedAt: null };
    expect(finalMixMode(profile)).toBe("lesson");
    const record = { lessonId: "final-mix" as const, passedAt: "2026-10-16T10:00:00.000Z", passedVia: "lesson" as const, attempts: 1, reviewSuggestedAt: null, reviewDeclinedAt: null };
    expect(finalMixMode({ ...profile, lessons: { "final-mix": record } })).toBe("cold");
  });

  it("writes notes with the track list and each transition's results", () => {
    const text = setNotesText({
      title: "My first set",
      recordedAt: "2026-10-17T20:15:00.000Z",
      tracks: [{ title: "One", artist: "A", bpm: 124, credit: "CC BY" }],
      transitions: [{ number: 1, from: "One", to: "Two", kind: "cut", met: true, phraseBeats: 0.1, levelDb: 0.5, phaseHold: null }],
      result: { outcome: { kind: "passed", bands: { beatSyncing: "merit", balance: "pass", phrasing: "merit", overall: "pass" } } },
    });
    expect(text).toContain("Check: passed (pass).");
    expect(text).toContain("1. A – One (124.0 BPM). CC BY");
    expect(text).toContain("1. One → Two: cut, met (0.10 beats off the phrase, levels 0.5 dB apart)");
  });
});
