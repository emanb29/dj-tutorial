import type { StretchNode } from "signalsmith-stretch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Deck } from "./deck.ts";
import { PendingWork } from "./pending-work.ts";

// The stretch worklet is the seam here: Deck's only route to the audio a Master Tempo deck plays.
// A fake context stands in for the clock, so the test controls when the old track's stop is reached.

interface FakeContext {
  currentTime: number;
  state: AudioContextState;
}

function fakeStretch(context: FakeContext) {
  const calls: { call: string; atCtx: number }[] = [];
  const record = (call: string) => {
    calls.push({ call, atCtx: context.currentTime });
    return Promise.resolve(0);
  };
  const node = {
    connect: () => undefined,
    disconnect: () => undefined,
    schedule: () => record("schedule"),
    dropBuffers: () => record("dropBuffers"),
    addBuffers: () => record("addBuffers"),
  };
  return { node: node as unknown as StretchNode, calls };
}

const fakeBuffer = { duration: 10, numberOfChannels: 2, getChannelData: () => new Float32Array(16) } as unknown as AudioBuffer;
const track = (trackId: string) => ({ trackId, grid: null });

describe("Deck loading with Master Tempo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the old track's audio in the stretcher until its scheduled stop has played", async () => {
    const context: FakeContext = { currentTime: 0, state: "running" };
    const stretch = fakeStretch(context);
    const deck = new Deck("A", context as unknown as BaseAudioContext, {} as AudioNode, stretch.node, { available: true }, new PendingWork());
    deck.beginLoad(0);
    await deck.finishLoad(fakeBuffer, track("old"), () => 0);
    expect(deck.setMasterTempo(0, true)).toEqual({ ok: true });
    expect(deck.play(0.1)).toEqual({ ok: true });

    // The old track is scheduled to stop a stretch lead ahead, at 0.5 s.
    deck.beginLoad(0.5);
    const loading = deck.finishLoad(fakeBuffer, track("new"), () => context.currentTime + 0.15);
    await vi.advanceTimersByTimeAsync(100);
    context.currentTime = 0.3;
    await vi.advanceTimersByTimeAsync(100);
    expect(stretch.calls.slice(-1)).toEqual([{ call: "schedule", atCtx: 0 }]);

    context.currentTime = 0.55;
    await vi.advanceTimersByTimeAsync(100);
    const loaded = await loading;

    expect(loaded.ok && loaded.record.trackId).toBe("new");
    const drop = stretch.calls.findLast(({ call }) => call === "dropBuffers");
    expect(drop?.atCtx).toBeGreaterThanOrEqual(0.5);
  });

  it("does not wait when the old track was not playing through the stretcher", async () => {
    const context: FakeContext = { currentTime: 0, state: "running" };
    const stretch = fakeStretch(context);
    const deck = new Deck("A", context as unknown as BaseAudioContext, {} as AudioNode, stretch.node, { available: true }, new PendingWork());
    deck.beginLoad(0);
    await deck.finishLoad(fakeBuffer, track("old"), () => 0);
    deck.beginLoad(0.5);

    const loaded = await deck.finishLoad(fakeBuffer, track("new"), () => 0.5);
    expect(loaded.ok).toBe(true);
  });
});
