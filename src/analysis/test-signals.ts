// Deterministic synthetic audio and a stand-in model for tests.

import type { BeatModel } from "./model.ts";
import { MEL_BANDS } from "./mel.ts";
import { CHUNK } from "./postprocess.ts";

/** A sine kick on every beat and a quieter hat on every off-beat. The kick's energy builds over its
 * first half cycle, so onset detectors land ~3.5 ms late. With `downbeatPhase`, the kick on beat
 * `downbeatPhase + 4n` is louder (the others play at 0.6). */
export function kickTrack(
  bpm: number,
  firstBeatSec: number,
  seconds: number,
  sampleRate = 44_100,
  downbeatPhase: number | null = null,
): Float32Array {
  const signal = new Float32Array(Math.round(seconds * sampleRate));
  const add = (index: number, value: number) => {
    if (index >= 0 && index < signal.length) signal[index] = (signal[index] ?? 0) + value;
  };
  const period = 60 / bpm;
  const beats = Math.ceil((seconds - firstBeatSec) / period);
  for (let n = 0; n < beats; n++) {
    const t = firstBeatSec + n * period;
    const gain = downbeatPhase === null || (n - downbeatPhase) % 4 === 0 ? 1 : 0.6;
    const start = Math.round(t * sampleRate);
    let phase = 0;
    for (let i = 0; i < 0.3 * sampleRate; i++) {
      phase += (2 * Math.PI * (48 + 110 * Math.exp(-i / sampleRate / 0.03))) / sampleRate;
      add(start + i, gain * Math.min(1, i / 32) * Math.sin(phase) * Math.exp(-i / sampleRate / 0.16));
    }
    // A quieter off-beat hat, which must not attract the grid.
    const hat = Math.round((t + period / 2) * sampleRate);
    for (let i = 0; i < 2000; i++) add(hat + i, 0.2 * Math.sin(i * 2.7) * Math.exp(-i / 400));
  }
  return signal;
}

/** A stand-in for Beat This! that "detects" beats as rises in the lowest mel bands of its window:
 * the strongest rises are downbeats, the rest above half the window's peak are beats. It sees only
 * the spectrogram, as the real model does, so the pipeline's chunking and timing are exercised. */
export function onsetModel(version = "fake-onset-model"): BeatModel {
  const LOW_BANDS = 12;
  return {
    version,
    run(spect: Float32Array) {
      const level = (f: number) => {
        let sum = 0;
        for (let m = 0; m < LOW_BANDS; m++) sum += spect[f * MEL_BANDS + m] ?? 0;
        return sum;
      };
      const rise = Float32Array.from({ length: CHUNK }, (_, f) => (f === 0 ? 0 : Math.max(0, level(f) - level(f - 1))));
      const peak = rise.reduce((a, b) => Math.max(a, b), 0) || 1;
      return Promise.resolve({
        beat: rise.map((r) => r - 0.5 * peak),
        downbeat: rise.map((r) => r - 0.85 * peak),
      });
    },
  };
}
