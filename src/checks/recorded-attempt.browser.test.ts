// The Checks' deck-control readers on an attempt the real recorder made, rendered offline (never the speakers).
// The engine applies each change a lookahead after it is heard; the readers must line deck controls up with
// the playhead model on the applied time, or a jog bend is factored out before the rate it bends has changed.
import { describe, expect, it } from "vitest";
import { AttemptRecorder, createAudioEngine } from "@audio";
import { KEYBOARD, at, offlineContext, send, toneBuffer } from "@audio/offline-test-support.ts";
import type { BeatGrid } from "@shared/attempt.ts";
import { deckControlChanges, jogBendAt } from "./deck-controls.ts";
import { tempoBpmAt } from "./phase.ts";

const grid: BeatGrid = { bpm: 120, firstBeat: 0, downbeatIndex: 0, rmsResidualMs: 4 };
const LOOKAHEAD_S = 0.05;

describe("deck controls on a recorded attempt", () => {
  it("factor the jog bend out of the playhead rate on the applied time, so the tempo-fader BPM holds through a bend", async () => {
    const context = offlineContext(2);
    const engine = await createAudioEngine({ context, lookaheadSec: LOOKAHEAD_S, masterTempo: false });
    await engine.load("A", toneBuffer(context, { frequency: 440, peak: 0.25, seconds: 3 }), { trackId: "track-a", grid });
    const recorder = new AttemptRecorder(engine);
    expect(recorder.start()).toEqual({ ok: true });
    send(engine, { control: "play", deck: "A" });
    const moves = [
      at(context, 0.5, () => {
        send(engine, { control: "tempo", deck: "A", value: 0.5 });
      }),
      at(context, 1, () => {
        send(engine, { control: "jog-bend", deck: "A", value: 0.04 });
      }),
      at(context, 1.3, () => {
        send(engine, { control: "jog-bend", deck: "A", value: 0 });
      }),
    ];
    await context.startRendering();
    await Promise.all(moves);
    const stopped = await recorder.stop({
      attemptId: "attempt-1",
      learnerId: "learner-1",
      endReason: "done",
      abandoned: false,
      phraseMarkers: {},
      answers: {},
      inputDevice: KEYBOARD.device,
    });
    if (!stopped.ok) throw new Error(`stop failed: ${stopped.error.kind}`);
    const { attempt } = stopped;
    const playhead = attempt.decks.A?.playhead;
    if (playhead === undefined) throw new Error("deck A was not recorded");
    const loaded = { deck: "A", trackId: "track-a", playhead, grid, phraseMarkers: [] } as const;

    // Heard at 1 s, applied a lookahead later: the bend is read where the playhead model bends.
    const bend = deckControlChanges(attempt, "jogBend", "A")[0];
    expect(attempt.events.find((event) => event.control === "jogBend")?.ctx).toBeCloseTo(1, 6);
    expect(bend?.ctx).toBeCloseTo(1 + LOOKAHEAD_S, 6);
    expect(jogBendAt(attempt, "A", 1.02)).toBe(0);
    expect(jogBendAt(attempt, "A", 1.2)).toBe(0.04);
    // 120 BPM × 1.05 throughout: before the bend, between its heard and applied times, during it and after.
    for (const t of [0.6, 1.02, 1.2, 1.4, 1.8]) expect(tempoBpmAt(attempt, loaded, t)).toBeCloseTo(126, 9);
    // The tempo event carries the rate ratio, which is what the playhead plays.
    expect(attempt.events.find((event) => event.control === "tempo")?.value).toBeCloseTo(1.05, 12);
  });
});
