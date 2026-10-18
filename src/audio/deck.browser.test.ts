import { describe, expect, it } from "vitest";
import type { BeatGrid } from "./beat-grid.ts";
import type { EngineCommand } from "./commands.ts";
import { createAudioEngine, type CommandEvent, type EngineDeckSnapshot } from "./engine.ts";
import {
  at,
  channelRmsDb,
  clickBuffer,
  engineWithTone,
  KEYBOARD,
  offlineContext,
  onsetSec,
  outputTimeOf,
  peakSec,
  SAMPLE_RATE,
  send,
  toneBuffer,
  toneFrequency,
} from "./offline-test-support.ts";

const grid = (bpm: number, firstBeat: number): BeatGrid => ({ bpm, firstBeat, downbeatIndex: 0, rmsResidualMs: 2 });

describe("scheduling: what is heard matches the playhead model", () => {
  it("starts a deck exactly at the model's start time, a lookahead after the command", async () => {
    const context = offlineContext(0.5);
    const engine = await createAudioEngine({ context, lookaheadSec: 0.01, masterTempo: false });
    await engine.load("A", clickBuffer(context, 1, [0]), { trackId: "click", grid: null });
    const commands: CommandEvent[] = [];
    engine.on("command", (event) => commands.push(event));
    const playedAt = at(context, 0.2, () => {
      send(engine, { control: "play", deck: "A" });
    });
    const rendered = await context.startRendering();

    const start = engine.trackHistory("A").at(-1)?.playhead.segments().find((segment) => segment.rate > 0)?.fromCtx ?? Number.NaN;
    expect(start).toBeCloseTo((await playedAt) + 0.01, 9);
    expect(commands[0]?.appliedCtx).toBe(start);
    expect(Math.abs(onsetSec(rendered) - start)).toBeLessThan(0.001);
  });

  // Stretch-worklet messages sent while an OfflineAudioContext is suspended do not take effect (observed in
  // Chromium), so these two tests schedule before the render starts instead of using suspend().
  it("with Master Tempo on, schedules past the stretcher's latency so clicks land where the model says", async () => {
    const context = offlineContext(1.2);
    const engine = await createAudioEngine({ context });
    await engine.load("A", clickBuffer(context, 2, [0.3, 0.6]), { trackId: "clicks", grid: null });
    send(engine, { control: "master-tempo", deck: "A", value: true }, { control: "play", deck: "A" });
    await engine.settled();
    const rendered = await context.startRendering();

    const segments = engine.trackHistory("A").at(-1)?.playhead.segments() ?? [];
    // The deck starts no earlier than the stretcher's latency (0.12 s for signalsmith-stretch's default).
    expect(segments.at(-1)?.fromCtx).toBeGreaterThanOrEqual(0.12);
    for (const click of [0.3, 0.6]) {
      const expected = outputTimeOf(segments, click) ?? Number.NaN;
      // The stretcher's STFT smears a click over a few samples; its peak stays within 2 ms.
      expect(Math.abs(peakSec(rendered, expected, 0.03) - expected)).toBeLessThan(0.002);
    }
  });

  it("toggling Master Tempo mid-play keeps clicks on the model, before and after the switch", async () => {
    const clicks = [0.05, 0.3, 0.55, 0.8];
    const context = offlineContext(1.2);
    const engine = await createAudioEngine({ context, lookaheadSec: 0.01 });
    await engine.load("A", clickBuffer(context, 3, clicks), { trackId: "clicks", grid: null });
    // Play starts the rate voice at 0.01 s; the switch to the stretcher lands a stretch latency later, mid-play.
    send(engine, { control: "play", deck: "A" }, { control: "master-tempo", deck: "A", value: true });
    await engine.settled();
    const rendered = await context.startRendering();

    const segments = engine.trackHistory("A").at(-1)?.playhead.segments() ?? [];
    for (const click of clicks) {
      const expected = outputTimeOf(segments, click) ?? Number.NaN;
      expect(Math.abs(peakSec(rendered, expected, 0.03) - expected)).toBeLessThan(0.002);
    }
    // The rate voice stopped at the switch: there is one click near each expected time, not two.
    expect(channelRmsDb(rendered, 0, 0.9, 1.2)).toBeLessThan(-80);
  });
});

describe("deck transport", () => {
  it("plays, pauses and reports the position", async () => {
    const { context, engine } = await engineWithTone(1, { frequency: 1000, peak: 0.5 });
    const pausedAt = at(context, 0.5, () => {
      send(engine, { control: "pause", deck: "A" });
    });
    const rendered = await context.startRendering();
    const pauseTime = await pausedAt;

    expect(channelRmsDb(rendered, 0, 0.1, 0.45)).toBeGreaterThan(-12);
    expect(channelRmsDb(rendered, 0, 0.55, 1)).toBeLessThan(-100);
    expect(engine.playheadAt("A", 0.25)?.positionSec).toBeCloseTo(0.25, 9);
    expect(engine.playheadAt("A", 0.9)?.positionSec).toBeCloseTo(pauseTime, 9);
    expect(engine.deckState("A").playing).toBe(false);
  });

  it("seeks while playing", async () => {
    const { context, engine } = await engineWithTone(1, { frequency: 1000, peak: 0.5 });
    const seekedAt = at(context, 0.5, () => {
      send(engine, { control: "seek", deck: "A", value: 1.25 });
    });
    await context.startRendering();
    const seekTime = await seekedAt;
    expect(engine.playheadAt("A", 0.9)?.positionSec).toBeCloseTo(1.25 + (0.9 - seekTime), 9);
  });

  it("deck CUE: while playing it returns to the cue point and pauses", async () => {
    const { context, engine } = await engineWithTone(1, { frequency: 1000, peak: 0.5 });
    const pressedAt = at(context, 0.5, () => {
      send(engine, { control: "deck-cue", deck: "A", value: true }, { control: "deck-cue", deck: "A", value: false });
    });
    await context.startRendering();
    await pressedAt;
    expect(engine.deckState("A")).toMatchObject({ playing: false, cuePointSec: 0 });
    expect(engine.playheadAt("A", 0.9)?.positionSec).toBe(0);
  });

  it("deck CUE: while paused away from the cue point one press sets a new cue point there and plays from it while held", async () => {
    const context = offlineContext(1);
    const engine = await createAudioEngine({ context });
    await engine.load("A", toneBuffer(context, { frequency: 1000, peak: 0.5, seconds: 3 }), { trackId: "t", grid: null });
    const cuePoints: unknown[] = [];
    engine.on("cue-point", (cuePoint) => cuePoints.push(cuePoint));
    send(engine, { control: "crossfader", value: 0 }, { control: "seek", deck: "A", value: 1.5 }, { control: "deck-cue", deck: "A", value: true });

    expect(engine.deckState("A").cuePointSec).toBe(1.5);
    expect(cuePoints).toEqual([{ ctx: 0, deck: "A", trackId: "t", pos: 1.5 }]);
    const releasedAt = at(context, 0.4, () => {
      send(engine, { control: "deck-cue", deck: "A", value: false });
    });
    const rendered = await context.startRendering();
    await releasedAt;

    // Heard at once, from the new cue point, without a second press; released, back to it and silent.
    expect(channelRmsDb(rendered, 0, 0.1, 0.35)).toBeGreaterThan(-12);
    expect(channelRmsDb(rendered, 0, 0.5, 1)).toBeLessThan(-100);
    expect(engine.playheadAt("A", 0.9)?.positionSec).toBe(1.5);
  });

  it("deck CUE: held at the cue point it previews, and releasing returns to the cue point", async () => {
    const context = offlineContext(1);
    const engine = await createAudioEngine({ context });
    await engine.load("A", toneBuffer(context, { frequency: 1000, peak: 0.5, seconds: 3 }), { trackId: "t", grid: null });
    send(engine, { control: "crossfader", value: 0 }, { control: "deck-cue", deck: "A", value: true });
    const releasedAt = at(context, 0.4, () => {
      send(engine, { control: "deck-cue", deck: "A", value: false });
    });
    const rendered = await context.startRendering();
    await releasedAt;

    expect(channelRmsDb(rendered, 0, 0.1, 0.35)).toBeGreaterThan(-12);
    expect(channelRmsDb(rendered, 0, 0.5, 1)).toBeLessThan(-100);
    expect(engine.deckState("A").playing).toBe(false);
    expect(engine.playheadAt("A", 0.9)?.positionSec).toBe(0);
  });

  it("stops at the end of the track and says so", async () => {
    const context = offlineContext(0.6);
    const engine = await createAudioEngine({ context });
    await engine.load("A", toneBuffer(context, { frequency: 1000, peak: 0.5, seconds: 0.3 }), { trackId: "short", grid: null });
    const snapshots: EngineDeckSnapshot[] = [];
    engine.on("deck", (snapshot) => snapshots.push(snapshot));
    send(engine, { control: "play", deck: "A" });
    await context.startRendering();

    expect(engine.deckState("A").playing).toBe(false);
    expect(engine.playheadAt("A", 0.5)?.positionSec).toBeCloseTo(0.3, 3);
    expect(snapshots.filter((snapshot) => snapshot.deck === "A").at(-1)?.playing).toBe(false);
  });

  it("refuses transport commands on an empty deck", async () => {
    const { engine } = await engineWithTone(0.1, { frequency: 1000, peak: 0.5 });
    expect(engine.command({ control: "play", deck: "B" }, KEYBOARD)).toEqual({
      ok: false,
      error: { kind: "no-track-loaded", deck: "B" },
    });
  });
});

describe("loading", () => {
  it("refuses transport while a load is in flight, and the old track stops at once", async () => {
    const { context, engine } = await engineWithTone(0.5, { frequency: 1000, peak: 0.5 });
    const loading = engine.load("A", toneBuffer(context, { frequency: 500, peak: 0.5, seconds: 1 }), { trackId: "next", grid: null });

    expect(engine.deckState("A")).toMatchObject({ loading: true, playing: false });
    expect(engine.command({ control: "play", deck: "A" }, KEYBOARD)).toEqual({
      ok: false,
      error: { kind: "deck-loading", deck: "A" },
    });
    expect(await loading).toEqual({ ok: true });
    expect(engine.deckState("A")).toMatchObject({ loading: false, trackId: "next" });
  });

  it("refuses deck CUE and jog search while a load is in flight, so no cue point lands on the outgoing track", async () => {
    // cue-point loads its slices one after another: a CUE pressed mid-load must not set a cue anywhere.
    const { context, engine } = await engineWithTone(0.5, { frequency: 1000, peak: 0.5 });
    const cuePoints: string[] = [];
    engine.on("cue-point", (cue) => cuePoints.push(cue.trackId));
    const loading = engine.load("A", toneBuffer(context, { frequency: 500, peak: 0.5, seconds: 1 }), { trackId: "next", grid: null });

    expect(engine.command({ control: "jog-search", deck: "A", value: 0.1 }, KEYBOARD)).toMatchObject({ ok: false, error: { kind: "deck-loading" } });
    expect(engine.command({ control: "deck-cue", deck: "A", value: true }, KEYBOARD)).toMatchObject({ ok: false, error: { kind: "deck-loading" } });
    await loading;
    expect(cuePoints).toEqual([]);
  });

  it("serialises overlapping loads: the last one wins and a superseded load leaves no trace", async () => {
    const context = offlineContext(0.1);
    const engine = await createAudioEngine({ context });
    const tone = () => toneBuffer(context, { frequency: 500, peak: 0.5, seconds: 1 });
    await engine.load("A", tone(), { trackId: "before", grid: null });
    const loadedEvents: string[] = [];
    engine.on("track-loaded", ({ record }) => loadedEvents.push(record.trackId));
    const results = await Promise.all([
      engine.load("A", tone(), { trackId: "first", grid: null }),
      engine.load("A", tone(), { trackId: "second", grid: null }),
    ]);

    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(engine.deckState("A").trackId).toBe("second");
    expect(engine.trackHistory("A").map((track) => track.trackId)).toEqual(["before", "second"]);
    expect(loadedEvents).toEqual(["second"]);
  });

  it("keeps only metadata and the playhead model in the track history, not the audio", async () => {
    const { engine } = await engineWithTone(0.1, { frequency: 1000, peak: 0.5 });
    const [record] = engine.trackHistory("A");
    expect(Object.keys(record ?? {}).sort()).toEqual(["durationSec", "grid", "loadedAtCtx", "playhead", "trackId"]);
  });

  it("refuses a bad track with every problem listed", async () => {
    const context = offlineContext(0.1);
    const engine = await createAudioEngine({ context });
    const result = await engine.load("A", toneBuffer(context, { frequency: 500, peak: 0.5, seconds: 1 }), {
      trackId: "",
      grid: { bpm: Number.NaN, firstBeat: 0, downbeatIndex: 5, rmsResidualMs: 1 },
    });
    expect(result).toMatchObject({ ok: false, error: { kind: "invalid-track" } });
    expect(!result.ok && result.error.kind === "invalid-track" && result.error.problems).toHaveLength(3);
    expect(engine.deckState("A").trackId).toBeNull();
  });
});

describe("tempo", () => {
  it("with Master Tempo off, +6% tempo raises a 1 kHz tone to 1060 Hz", async () => {
    const { context, engine } = await engineWithTone(1, { frequency: 1000, peak: 0.5 });
    send(engine, { control: "tempo-range", deck: "A", value: 6 }, { control: "tempo", deck: "A", value: 1 });
    const rendered = await context.startRendering();

    expect(toneFrequency(rendered, 0, 0.2, 1)).toBeCloseTo(1060, -1);
    expect(engine.playheadAt("A", 1)?.positionSec).toBeCloseTo(1.06, 9);
  });

  it("with Master Tempo on, +6% tempo keeps the tone at 1 kHz while the track runs 6% faster", async () => {
    const context = offlineContext(2);
    const engine = await createAudioEngine({ context });
    await engine.load("A", toneBuffer(context, { frequency: 1000, peak: 0.5, seconds: 3 }), { trackId: "t", grid: null });
    send(
      engine,
      { control: "crossfader", value: 0 },
      { control: "master-tempo", deck: "A", value: true },
      { control: "tempo-range", deck: "A", value: 6 },
      { control: "tempo", deck: "A", value: 1 },
      { control: "play", deck: "A" },
    );
    await engine.settled();
    const rendered = await context.startRendering();
    const start = engine.trackHistory("A").at(-1)?.playhead.segments().at(-1)?.fromCtx ?? Number.NaN;

    expect(Math.abs(toneFrequency(rendered, 0, 0.5, 2) - 1000)).toBeLessThan(5);
    expect(channelRmsDb(rendered, 0, 0.5, 2)).toBeGreaterThan(-12);
    expect(engine.playheadAt("A", 2)?.positionSec).toBeCloseTo((2 - start) * 1.06, 9);
  });

  it("reports Master Tempo as unavailable when the stretcher is not loaded", async () => {
    const { engine } = await engineWithTone(0.1, { frequency: 1000, peak: 0.5 }, { masterTempo: false });
    expect(engine.command({ control: "master-tempo", deck: "A", value: true }, KEYBOARD)).toMatchObject({
      ok: false,
      error: { kind: "master-tempo-unavailable" },
    });
    expect(engine.deckState("A").masterTempoAvailability.available).toBe(false);
  });

  it("bends the rate while the jog turns and returns to tempo on release", async () => {
    const { context, engine } = await engineWithTone(1, { frequency: 1000, peak: 0.5 });
    const bendStart = at(context, 0.2, () => {
      send(engine, { control: "jog-bend", deck: "A", value: 0.1 });
    });
    const bendEnd = at(context, 0.6, () => {
      send(engine, { control: "jog-bend", deck: "A", value: 0 });
    });
    await context.startRendering();
    const bentFor = (await bendEnd) - (await bendStart);

    expect(engine.playheadAt("A", 0.9)?.positionSec).toBeCloseTo(0.9 + 0.1 * bentFor, 9);
  });
});

describe("jog search while paused", () => {
  async function pausedDeck() {
    const context = offlineContext(0.2);
    const engine = await createAudioEngine({ context, masterTempo: false });
    await engine.load("A", toneBuffer(context, { frequency: 1000, peak: 0.5, seconds: 3 }), { trackId: "t", grid: null });
    send(engine, { control: "seek", deck: "A", value: 1 });
    return { context, engine };
  }

  it("moves a paused deck's playhead by the searched seconds, without starting it", async () => {
    const { engine } = await pausedDeck();
    send(engine, { control: "jog-search", deck: "A", value: 0.25 }, { control: "jog-search", deck: "A", value: -0.05 });
    expect(engine.playheadAt("A", 0.1)?.positionSec).toBeCloseTo(1.2, 9);
    expect(engine.deckState("A")).toMatchObject({ playing: false, jogBend: 0 });
  });

  it("stops at the start and the end of the track, like a CDJ's platter", async () => {
    const { engine } = await pausedDeck();
    send(engine, { control: "jog-search", deck: "A", value: -5 });
    expect(engine.playheadAt("A", 0.1)?.positionSec).toBe(0);
    send(engine, { control: "jog-search", deck: "A", value: 10 });
    expect(engine.playheadAt("A", 0.1)?.positionSec).toBeCloseTo(3, 6);
  });

  describe("is heard, as a CDJ scrubs", () => {
    const QUANTUM = 128 / SAMPLE_RATE;
    // Every search lands on a render quantum, where an offline suspend can stop; one jog step is 8 quanta.
    const STEP = 8 * QUANTUM;
    const searchTimes = Array.from({ length: 10 }, (_, index) => (40 + 8 * index) * QUANTUM);
    const CLICKS = [1.05, 1.13];

    /** A quiet 200 Hz bed under loud clicks: the bed shows when anything plays, the clicks show where. */
    function scrubTrack(context: OfflineAudioContext): AudioBuffer {
      const buffer = clickBuffer(context, 3, CLICKS);
      for (let channel = 0; channel < 2; channel++) {
        const data = buffer.getChannelData(channel);
        data.forEach((sample, index) => (data[index] = sample + 0.05 * Math.sin((2 * Math.PI * 200 * index) / context.sampleRate)));
      }
      return buffer;
    }

    async function scrubbed(deltaSec: number, setUp: EngineCommand[] = []) {
      const context = offlineContext(0.8);
      const engine = await createAudioEngine({ context, lookaheadSec: 0.01, masterTempo: false });
      await engine.load("A", scrubTrack(context), { trackId: "t", grid: null });
      send(engine, { control: "crossfader", value: 0 }, { control: "seek", deck: "A", value: 1.1 }, ...setUp);
      const searches: { appliedCtx: number; from: number; to: number }[] = [];
      engine.on("command", (event) => {
        if (event.command.control !== "jog-search") return;
        const to = engine.playheadAt("A", event.appliedCtx + 1e-6)?.positionSec ?? Number.NaN;
        searches.push({ appliedCtx: event.appliedCtx, from: to - deltaSec, to });
      });
      for (const time of searchTimes) {
        void at(context, time, () => {
          send(engine, { control: "jog-search", deck: "A", value: deltaSec });
        });
      }
      const rendered = await context.startRendering();
      return { rendered, searches, engine };
    }

    /** When the grain that passed over track position `pos` plays it: grains after the first play at speed 1. */
    function heardAt(searches: readonly { appliedCtx: number; from: number; to: number }[], pos: number): number {
      const search = searches.slice(1).find(({ from, to }) => pos >= Math.min(from, to) && pos < Math.max(from, to));
      if (search === undefined) throw new Error(`No search moved over ${String(pos)} s.`);
      return search.appliedCtx + Math.abs(pos - search.from);
    }

    it("plays what the playhead moves over, as it moves, then goes quiet when the jog stops", async () => {
      // Back to 1.0 first, so the forward scrub crosses both clicks.
      const { rendered, searches, engine } = await scrubbed(STEP, [{ control: "seek", deck: "A", value: 1 }]);
      expect(searches).toHaveLength(searchTimes.length);
      expect(engine.deckState("A").playing).toBe(false);

      for (const click of CLICKS) {
        const expected = heardAt(searches, click);
        // The 1 ms click's loudest sample is within it: within 1 ms of where its start is heard.
        expect(Math.abs(peakSec(rendered, expected, 0.004) - expected)).toBeLessThan(0.001);
      }
      // The bed is heard all through the scrub, at about its level (a sine of peak 0.05 is −29 dB RMS)...
      const first = searches[1]?.appliedCtx ?? Number.NaN;
      const last = searches.at(-1)?.appliedCtx ?? Number.NaN;
      expect(channelRmsDb(rendered, 0, first, last)).toBeGreaterThan(-35);
      // ...and nothing once the last grain is over, though the track goes on past the playhead.
      expect(channelRmsDb(rendered, 0, last + STEP + 0.01, 0.8)).toBeLessThan(-120);
    });

    it("plays the audio backwards when the jog turns back", async () => {
      const { rendered, searches } = await scrubbed(-STEP);

      // Scrubbing back from 1.1 passes the click at 1.05; played backwards, its end (1.051) is heard first.
      const expected = heardAt(searches, 1.05 + 0.001);
      expect(Math.abs(peakSec(rendered, expected, 0.004) - expected)).toBeLessThan(0.001);    });

    it("goes through the channel: with fader A down, the scrub is silent", async () => {
      const { rendered } = await scrubbed(STEP, [{ control: "channel-fader", deck: "A", value: 0 }]);

      expect(channelRmsDb(rendered, 0, 0, 0.8)).toBeLessThan(-120);
    });
  });

  it("then deck CUE sets the cue point where the search stopped", async () => {
    const { engine } = await pausedDeck();
    const cuePoints: number[] = [];
    engine.on("cue-point", (cuePoint) => cuePoints.push(cuePoint.pos));
    send(engine, { control: "jog-search", deck: "A", value: 0.125 }, { control: "deck-cue", deck: "A", value: true });
    expect(cuePoints).toEqual([1.125]);
  });

  it("is refused on a playing deck: there the jog bends pitch instead", async () => {
    const { engine } = await engineWithTone(0.1, { frequency: 1000, peak: 0.5 }, { masterTempo: false });
    expect(engine.command({ control: "jog-search", deck: "A", value: 0.1 }, KEYBOARD)).toMatchObject({
      ok: false,
      error: { kind: "deck-playing", deck: "A" },
    });
  });

  it("refuses a search that is not a finite number of seconds", async () => {
    const { engine } = await pausedDeck();
    expect(engine.command({ control: "jog-search", deck: "A", value: Number.NaN }, KEYBOARD)).toMatchObject({
      ok: false,
      error: { kind: "value-out-of-range", control: "jog-search" },
    });
  });
});

describe("beat sync", () => {
  const gridA = grid(120, 0);
  const gridB = grid(125, 0.1);

  async function twoDecks(seconds: number, grids: { a: BeatGrid; b: BeatGrid }) {
    const context = offlineContext(seconds);
    const engine = await createAudioEngine({ context });
    const tone = () => toneBuffer(context, { frequency: 1000, peak: 0.25, seconds: seconds + 1 });
    await engine.load("A", tone(), { trackId: "a", grid: grids.a });
    await engine.load("B", tone(), { trackId: "b", grid: grids.b });
    const engineCommands: CommandEvent[] = [];
    engine.on("command", (event) => {
      if (event.device === "engine") engineCommands.push(event);
    });
    return { context, engine, engineCommands };
  }

  const phase = (beat: number | null | undefined) => (beat ?? Number.NaN) - Math.floor(beat ?? Number.NaN);

  it("matches the leader's tempo and beat phase", async () => {
    const { context, engine } = await twoDecks(1, { a: gridA, b: gridB });
    send(engine, { control: "play", deck: "A" }, { control: "play", deck: "B" });
    const syncedAt = at(context, 0.3, () => {
      send(engine, { control: "sync", deck: "B", value: true });
    });
    await context.startRendering();
    await syncedAt;

    expect(engine.deckState("B")).toMatchObject({ syncOn: true });
    expect(engine.deckState("B").tempoRate).toBeCloseTo(120 / 125, 12);
    expect(phase(engine.playheadAt("B", 0.9)?.beat)).toBeCloseTo(phase(engine.playheadAt("A", 0.9)?.beat), 9);
    expect(phase(engine.playheadAt("B", 0.4)?.beat)).toBeCloseTo(phase(engine.playheadAt("A", 0.4)?.beat), 9);
  });

  it("follows the leader's tempo fader and locks its own", async () => {
    const { engine } = await twoDecks(0.1, { a: gridA, b: gridB });
    send(engine, { control: "sync", deck: "B", value: true }, { control: "tempo", deck: "A", value: 0.5 });

    expect(engine.deckState("B").tempoRate).toBeCloseTo((1.05 * 120) / 125, 12);
    expect(engine.command({ control: "tempo", deck: "B", value: 0 }, KEYBOARD)).toEqual({
      ok: false,
      error: { kind: "tempo-locked-by-sync", deck: "B" },
    });
  });

  it("starts a synced deck on the leader's beat phase", async () => {
    const { context, engine } = await twoDecks(1, { a: gridA, b: gridB });
    send(engine, { control: "play", deck: "A" }, { control: "sync", deck: "B", value: true });
    const playedAt = at(context, 0.37, () => {
      send(engine, { control: "play", deck: "B" });
    });
    await context.startRendering();
    await playedAt;
    expect(phase(engine.playheadAt("B", 0.8)?.beat)).toBeCloseTo(phase(engine.playheadAt("A", 0.8)?.beat), 9);
  });

  it("emits a recorded engine event when sync is lost because the leader moved out of range", async () => {
    const { engine, engineCommands } = await twoDecks(0.1, { a: gridA, b: grid(120, 0) });
    send(engine, { control: "tempo-range", deck: "B", value: 6 }, { control: "sync", deck: "B", value: true });
    send(engine, { control: "tempo", deck: "A", value: 1 });

    expect(engine.deckState("B").syncOn).toBe(false);
    expect(engineCommands.map((event) => event.command)).toEqual([{ control: "sync", deck: "B", value: false }]);
  });

  it("transfers leadership explicitly, with a recorded event, when the leader presses SYNC", async () => {
    const { engine, engineCommands } = await twoDecks(0.1, { a: gridA, b: gridB });
    send(engine, { control: "sync", deck: "B", value: true }, { control: "sync", deck: "A", value: true });

    expect(engine.deckState("A").syncOn).toBe(true);
    expect(engine.deckState("B").syncOn).toBe(false);
    expect(engineCommands.map((event) => event.command)).toEqual([{ control: "sync", deck: "B", value: false }]);
  });

  it("refuses when the tempo range cannot reach the leader, and needs beat grids", async () => {
    const far = await twoDecks(0.1, { a: grid(140, 0), b: gridA });
    expect(far.engine.command({ control: "sync", deck: "B", value: true }, KEYBOARD)).toMatchObject({
      ok: false,
      error: { kind: "tempo-out-of-range", rangePercent: 10 },
    });

    const { context, engine } = await engineWithTone(0.1, { frequency: 1000, peak: 0.5 });
    await engine.load("B", toneBuffer(context, { frequency: 500, peak: 0.5, seconds: 1 }), { trackId: "b", grid: gridB });
    expect(engine.command({ control: "sync", deck: "B", value: true }, KEYBOARD)).toEqual({
      ok: false,
      error: { kind: "no-beat-grid", deck: "A" },
    });
  });

  it("names the bar and beat of the position", async () => {
    const { context, engine } = await twoDecks(0.1, { a: gridA, b: gridB });
    send(engine, { control: "seek", deck: "A", value: 0.875 });
    await context.startRendering();
    // 0.875 s at 120 BPM is beat 1.75: bar 1, beat 2.
    expect(engine.playheadAt("A", 0.05)).toMatchObject({ beat: 1.75, bar: 1, beatInBar: 2 });
  });
});
