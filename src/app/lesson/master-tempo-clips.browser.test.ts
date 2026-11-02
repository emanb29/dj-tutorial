// Lesson 8's Master Tempo clips must land on music with a pitch: 8% faster with Master Tempo off is a
// semitone higher than on only where something holds a note. Drums alone sound the same either way
// (the maintainer's report: the clips sat in the Originals' drum-only intros). Each clip's fast half is
// rendered offline (never the speakers) on the synthetic groove and on the Originals' stand-ins
// (rotated-tracks.harness.ts: their real grids and sections, a pad wherever the real drop has chords),
// and the chord is read where it should be: up 8% with Master Tempo off, where it was with it on.
import { describe, expect, it } from "vitest";
import { createAudioEngine } from "@audio";
import { offlineContext, send, toneLevelDb } from "@audio/offline-test-support.ts";
import { lessonDefinition, SYNTHETIC_HOUSE, synthesizeHouse, syntheticLessonTrack, type LessonTrack, type ListeningClip } from "@lessons";
import { PAD_HZ } from "@lessons/synthetic-track.ts";
import { audioOf, lessonTrackOf, ORIGINALS } from "./rotated-tracks.harness.ts";

const definition = lessonDefinition("tempo-fader");
const RENDER_SEC = 2;
/** Past the stretcher's latency (0.12 s) and its first frames. */
const FROM_SEC = 0.4;
/** How far the chord must sit on the side it should: well clear of hats and kicks, which sound alike either way. */
const CLEAR_DB = 10;

/** The clip's fast half (from `pos` + lead bars, at the clip's tempo) on deck B, rendered offline. */
async function renderFastHalf(track: LessonTrack, audio: (context: BaseAudioContext) => AudioBuffer, clip: ListeningClip): Promise<AudioBuffer> {
  const context = offlineContext(RENDER_SEC);
  const engine = await createAudioEngine({ context });
  const loaded = await engine.load("B", audio(context), { trackId: track.trackId, grid: track.grid });
  if (!loaded.ok) throw new Error(`Loading ${track.trackId} failed: ${loaded.error.kind}`);
  const fastFrom = clip.pos + clip.leadBars * 4 * (60 / track.grid.bpm);
  send(
    engine,
    { control: "channel-fader", deck: "B", value: 1 },
    { control: "tempo-range", deck: "B", value: clip.rangePercent },
    { control: "master-tempo", deck: "B", value: clip.masterTempo },
    { control: "seek", deck: "B", value: fastFrom },
    { control: "tempo", deck: "B", value: clip.tempo },
    { control: "play", deck: "B" },
  );
  await engine.settled();
  return context.startRendering();
}

/** dB more of the chord sped up (each note × the clip's rate) than at its own pitch, averaged over its notes. */
function raisedOverOwnDb(rendered: AudioBuffer, clip: ListeningClip): number {
  const rate = 1 + (clip.tempo * clip.rangePercent) / 100;
  const level = (hz: number) => toneLevelDb(rendered, 0, FROM_SEC, RENDER_SEC, hz);
  return PAD_HZ.reduce((sum, hz) => sum + level(hz * rate) - level(hz), 0) / PAD_HZ.length;
}

const synthetic = syntheticLessonTrack(SYNTHETIC_HOUSE);
const kinds: readonly { readonly name: string; readonly track: LessonTrack; readonly audio: (context: BaseAudioContext) => AudioBuffer }[] = [
  {
    name: "the synthetic groove",
    track: synthetic,
    audio: (context) => {
      const samples = synthesizeHouse(SYNTHETIC_HOUSE, context.sampleRate);
      const buffer = context.createBuffer(1, samples.length, context.sampleRate);
      buffer.copyToChannel(samples, 0);
      return buffer;
    },
  },
  ...ORIGINALS.map((meta) => ({ name: `Original ${meta.id} (${meta.genre})`, track: lessonTrackOf(meta), audio: (context: BaseAudioContext) => audioOf(meta, context) })),
];

describe("Lesson 8's Master Tempo clips hold a chord, so Off is heard higher than On", () => {
  for (const { name, track, audio } of kinds) {
    it(`on ${name}`, async () => {
      const off = definition.practiceClip?.(track, false);
      const on = definition.practiceClip?.(track, true);
      if (off === undefined || on === undefined) throw new Error("tempo-fader has no practice clip");
      // The hook, the ear round and the Check all play from the same place.
      const plan = definition.planCheck(track, 1);
      expect(Object.values(plan.clips ?? {}).map((clip) => clip.pos)).toEqual([off.pos, off.pos]);
      expect(definition.practiceDecks?.(track).B?.pos).toBe(off.pos);

      expect(raisedOverOwnDb(await renderFastHalf(track, audio, off), off)).toBeGreaterThan(CLEAR_DB);
      expect(raisedOverOwnDb(await renderFastHalf(track, audio, on), on)).toBeLessThan(-CLEAR_DB);
    });
  }
});
