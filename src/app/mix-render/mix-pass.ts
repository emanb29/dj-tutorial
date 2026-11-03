// The Render's mix pass (ISS-190): one segment of the set through the app's own AudioEngine on an
// OfflineAudioContext. The decks play each track's rendered playback (track-pass.ts) at their own
// speed with Master Tempo off, and the mixer moves come from commands.ts, each placed on its sample
// (`CommandInput.atCtx`). A segment starts from a snapshot: the mixer as the commands leave it at
// the segment's start, and each deck at its track's frame there, after a short pre-roll that is
// dropped (the mixer's filters settle in it). That is what makes segments join with no seam.
import { createAudioEngine, type AudioEngine, type EngineCommand } from "@audio";
import { stateAt, type TimedCommand } from "./commands.ts";
import { PREROLL_SEC, type Segment } from "./segments.ts";
import type { SetTimeline } from "./timeline.ts";
import { RenderCancelled, type TrackRender } from "./track-pass.ts";

const RENDER_QUANTUM = 128;
/** Commands are sent in batches this many render quanta apart (about 0.25 s), each ahead of its time. */
const BATCH_QUANTA = 86;
/** As a perfect live take: the moves come from the controller. */
const INPUT = { device: "midi" } as const;

export interface SegmentInput {
  readonly timeline: SetTimeline;
  readonly commands: readonly TimedCommand[];
  readonly segment: Segment;
  readonly sampleRate: number;
  /** The rendered playback of each track the segment hears. */
  readonly track: (index: number) => TrackRender;
  readonly signal?: AbortSignal;
}

type SegmentEvent =
  | { readonly atSec: number; readonly kind: "start"; readonly render: TrackRender; readonly deck: "A" | "B"; readonly fromFrame: number }
  | { readonly atSec: number; readonly kind: "command"; readonly command: EngineCommand };

function ok(result: { readonly ok: boolean }, what: string): void {
  if (!result.ok) throw new Error(`The Render's engine refused ${what}: ${JSON.stringify(result)}. This is a bug in src/app/mix-render.`);
}

/** The segment's audio, from its first frame to its last (the pre-roll dropped), left and right. */
export async function renderSegment(input: SegmentInput): Promise<readonly [Float32Array, Float32Array]> {
  const { timeline, commands, segment, sampleRate } = input;
  const prerollFrames = Math.min(segment.fromFrame, Math.round(PREROLL_SEC * sampleRate));
  const startFrame = segment.fromFrame - prerollFrames;
  const length = segment.toFrame - startFrame;
  const startSec = startFrame / sampleRate;
  const endSec = segment.toFrame / sampleRate;
  const context = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate });
  const engine = await createAudioEngine({ context, masterTempo: false });
  try {
    for (const command of stateAt(commands, startSec)) ok(engine.command(command, INPUT), command.control);

    const events: SegmentEvent[] = [];
    for (const track of timeline.tracks.filter((each) => each.stopSec > startSec && each.enterSec < endSec)) {
      const render = input.track(track.index);
      const enters = render.firstFrame / sampleRate;
      events.push(enters <= startSec ? { atSec: startSec, kind: "start", render, deck: track.deck, fromFrame: startFrame - render.firstFrame } : { atSec: enters, kind: "start", render, deck: track.deck, fromFrame: 0 });
    }
    for (const { atSec, command } of commands) if (atSec > startSec && atSec < endSec) events.push({ atSec, kind: "command", command });
    events.sort((a, b) => a.atSec - b.atSec);

    // Each batch runs at a quantum boundary at or before its events; a track starting gets its own, so
    // the deck it takes stops no more than a quantum early.
    const batches = new Map<number, SegmentEvent[]>();
    for (const event of events) {
      const frame = Math.max(0, Math.round((event.atSec - startSec) * sampleRate));
      const quanta = event.kind === "start" ? RENDER_QUANTUM : RENDER_QUANTUM * BATCH_QUANTA;
      const at = Math.floor(frame / quanta) * quanta;
      const batch = batches.get(at) ?? [];
      batch.push(event);
      batches.set(at, batch);
    }
    const run = (batch: readonly SegmentEvent[]) => apply(engine, batch, startSec);
    const first = batches.get(0);
    if (first !== undefined) await run(first);
    batches.delete(0);

    const rendered = await new Promise<AudioBuffer>((resolve, reject) => {
      for (const [frame, batch] of [...batches.entries()].sort((a, b) => a[0] - b[0])) {
        context
          .suspend(frame / sampleRate)
          .then(async () => {
            if (input.signal?.aborted === true) throw new RenderCancelled();
            await run(batch);
            await context.resume();
          })
          .catch(reject);
      }
      context.startRendering().then(resolve, reject);
    });
    return [rendered.getChannelData(0).subarray(prerollFrames), rendered.getChannelData(1).subarray(prerollFrames)];
  } finally {
    await engine.close();
  }
}

async function apply(engine: AudioEngine, batch: readonly SegmentEvent[], startSec: number): Promise<void> {
  // Events are in time order, so one control's moves stay in order and a deck loads before it plays.
  for (const event of batch) {
    const atCtx = event.atSec - startSec;
    if (event.kind === "command") {
      ok(engine.command(event.command, { ...INPUT, atCtx }), event.command.control);
      continue;
    }
    const { render, deck, fromFrame } = event;
    ok(await engine.load(deck, render.buffer, { trackId: `track-${String(render.index + 1)}`, grid: null }), `loading track ${String(render.index + 1)}`);
    if (fromFrame > 0) ok(engine.command({ control: "seek", deck, value: fromFrame / render.buffer.sampleRate }, { ...INPUT, atCtx }), "seek");
    ok(engine.command({ control: "play", deck }, { ...INPUT, atCtx }), "play");
  }
}
