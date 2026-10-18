import { describe, expect, it } from "vitest";
import { PHRASE_COUNT_START, phraseCountStep, phrasePosition, type PhraseCountEvent, type PhraseCountState } from "./phrase-count.ts";

const run = (events: readonly PhraseCountEvent[], from: PhraseCountState = PHRASE_COUNT_START) => events.reduce(phraseCountStep, from);
const right: PhraseCountEvent = { kind: "tap", onPhraseStart: true };
const off: PhraseCountEvent = { kind: "tap", onPhraseStart: false };
const passed: PhraseCountEvent = { kind: "phrase-passed" };

describe("the phrase count", () => {
  it("shows at first, and fades out after 2 phrase taps right in a row", () => {
    expect(PHRASE_COUNT_START.shown).toBe(true);
    expect(run([right, passed]).shown).toBe(true);
    expect(run([right, passed, right, passed]).shown).toBe(false);
  });

  it("does not count a double tap on one phrase start as two right", () => {
    expect(run([right, right, passed]).shown).toBe(true);
  });

  it("comes back after 2 misses in a row: off taps or phrase starts passed untapped", () => {
    const byEar = run([right, passed, right, passed]);
    expect(run([off], byEar).shown).toBe(false);
    expect(run([off, passed], byEar).shown).toBe(true);
    expect(run([passed, passed], byEar).shown).toBe(true);
    // A right tap between two misses breaks the run.
    expect(run([off, right, passed, off], byEar).shown).toBe(false);
  });

  it("other phrase-timed reps fade it the same way: 2 right in a row, back after 2 misses", () => {
    const good: PhraseCountEvent = { kind: "action", good: true };
    const bad: PhraseCountEvent = { kind: "action", good: false };
    expect(run([good]).shown).toBe(true);
    const byEar = run([good, good]);
    expect(byEar.shown).toBe(false);
    expect(run([bad], byEar).shown).toBe(false);
    expect(run([bad, bad], byEar).shown).toBe(true);
    expect(run([good, bad, good]).shown).toBe(true);
  });

  it("an off tap breaks a run of right taps", () => {
    expect(run([right, passed, off, right, passed]).shown).toBe(true);
  });
});

describe("phrasePosition", () => {
  const grid = { bpm: 120, firstBeat: 0.25, downbeatIndex: 1, rmsResidualMs: 0 };
  // Bar 1 is beat 1 (0.75 s); a beat is 0.5 s, a bar 2 s, a phrase 16 s.
  it("counts bars and beats from bar 1 of the grid", () => {
    expect(phrasePosition(grid, 0.75)).toEqual({ phrase: 1, bar: 1, beat: 1 });
    expect(phrasePosition(grid, 0.75 + 2 * 2 + 0.5 * 3)).toEqual({ phrase: 1, bar: 3, beat: 4 });
    expect(phrasePosition(grid, 0.75 + 16)).toEqual({ phrase: 2, bar: 1, beat: 1 });
    expect(phrasePosition(grid, 0.75 + 16 - 0.01)).toEqual({ phrase: 1, bar: 8, beat: 4 });
  });

  it("puts a pickup before bar 1 in phrase 0's last bar", () => {
    expect(phrasePosition(grid, 0.3)).toEqual({ phrase: 0, bar: 8, beat: 4 });
  });
});
