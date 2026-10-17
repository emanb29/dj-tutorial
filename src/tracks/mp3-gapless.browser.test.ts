import { describe, expect, it } from "vitest";
import fixtureUrl from "./fixtures/impulses-320k.mp3?url";
import { decoderAt } from "./load-audio.ts";

// Guards the Originals' beat grid against MP3 encoder delay. The fixture is one second of 44.1 kHz
// mono silence with single-sample impulses at 0.1 s, 0.5 s and 0.9 s, encoded the way the composer
// encodes Originals (`ffmpeg -c:a libmp3lame -b:a 320k`), so it carries a LAME/Xing header declaring
// the encoder delay and padding. If the decoder ignored that header, every impulse would land
// ~1105 samples (~25 ms) late and tap grading against `firstDownbeatSec` would be biased.
// Regenerate: write the impulse WAV described above, then run the ffmpeg command on it.

const IMPULSE_SECONDS = [0.1, 0.5, 0.9];
const TOLERANCE_SECONDS = 0.001;

/** The time of the loudest sample within 0.2 s either side of `aroundSeconds`. */
function peakSeconds(buffer: AudioBuffer, aroundSeconds: number): number {
  const samples = buffer.getChannelData(0);
  const rate = buffer.sampleRate;
  const start = Math.max(0, Math.round((aroundSeconds - 0.2) * rate));
  const end = Math.min(samples.length, Math.round((aroundSeconds + 0.2) * rate));
  let best = start;
  for (let index = start; index < end; index += 1) {
    if (Math.abs(samples[index] ?? 0) > Math.abs(samples[best] ?? 0)) best = index;
  }
  return best / rate;
}

describe("MP3 decoding honours the LAME gapless header", () => {
  it.each([44_100, 48_000])("places impulses within 1 ms of truth at %i Hz", async (rate) => {
    const bytes = await (await fetch(fixtureUrl)).arrayBuffer();
    const buffer = await decoderAt(rate)(bytes);
    expect(buffer.duration).toBeCloseTo(1, 2);
    for (const truth of IMPULSE_SECONDS) {
      expect(Math.abs(peakSeconds(buffer, truth) - truth)).toBeLessThan(TOLERANCE_SECONDS);
    }
  });
});
