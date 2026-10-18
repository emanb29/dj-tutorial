import { describe, expect, it } from "vitest";
import { gradeMix, type MixProgress } from "@analysis/mix/index.ts";
import { encodeWav, renderMixFixture } from "@analysis/mix/test-mixes.ts";
import { decodeMix } from "./decode.ts";
import { mixCheckResult, outsidePracticeOf } from "./mix-result.ts";

// The whole pipeline in a real browser, as the page runs it: a WAV of a short synthetic two-track
// mix (a cut on the phrase at 30 s, rendered offline, never played), decoded by the browser, graded
// in the mix worker, and turned into the result card's criteria. Without the model file (CI), the
// worker falls back to dj-core; with it, Beat This! finds the beats. Either way the answer is the same.
const BEAT = 60 / 128;
const fixture = renderMixFixture({ bpm: 128, bEntryBeat: 64, blendBeats: 0, bBeats: 64 });
const wav = encodeWav(fixture.channels, fixture.sampleRate);

describe("grading an uploaded mix in the browser", () => {
  it("decodes the file, grades it in the worker and finds the one cut, on the phrase", async () => {
    const file = new File([wav], "my-mix.wav", { type: "audio/wav" });
    const decoded = await decodeMix(file, new AbortController().signal);
    if (!decoded.ok) throw new Error(JSON.stringify(decoded.problem));
    expect(decoded.audio.sampleRate).toBe(22_050);
    const progress: MixProgress[] = [];
    const outcome = await gradeMix(decoded.audio, { onProgress: (p) => progress.push(p) });
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
    const { report } = outcome;
    expect(report.durationSec).toBeCloseTo(64 * BEAT * 2 + 0.5, 0);
    expect(report.transitions).toHaveLength(1);
    expect(report.transitions[0]).toMatchObject({ kind: "cut", phraseOffsetBeats: 0, clippedSec: 0, deadAirSec: 0 });
    expect(report.transitions[0]?.startSec).toBeCloseTo(64 * BEAT, 1);
    expect(progress.at(-1)?.fraction).toBe(1);
    // Handed to the worker, not copied: a mix can be hundreds of MB.
    expect(decoded.audio.channels[0]?.length).toBe(0);

    const result = mixCheckResult(report, { attemptId: "a", learnerId: "default", startedAt: "2026-10-18T09:00:00.000Z", endedAt: "2026-10-18T09:00:10.000Z" });
    expect(result.outcome.kind).toBe("passed");
    expect(outsidePracticeOf(report, "a", "2026-10-18T09:00:10.000Z")).toMatchObject({ transitions: 1, blends: 0, clean: true });
  }, 120_000);

  it("refuses a file that is not audio before reading it, and one it cannot decode", async () => {
    const text = new File(["not audio"], "notes.txt", { type: "text/plain" });
    expect(await decodeMix(text, new AbortController().signal)).toEqual({ ok: false, problem: { kind: "not-audio" } });
    const broken = new File([new Uint8Array(1000).fill(7)], "broken.mp3", { type: "audio/mpeg" });
    expect(await decodeMix(broken, new AbortController().signal)).toEqual({ ok: false, problem: { kind: "unreadable" } });
  }, 30_000);

  it("stops when aborted, and says so", async () => {
    const controller = new AbortController();
    const channels = fixture.channels.map((channel) => channel.slice());
    const pending = gradeMix({ channels, sampleRate: fixture.sampleRate }, { signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ ok: false, error: { kind: "aborted" } });
  });
});
