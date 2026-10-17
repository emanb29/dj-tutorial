// A synthetic house track with an exact grid and named sections. It needs no network and no
// analysis, so a Lesson always has a track, and end-to-end tests know every beat. Synthesised
// sample by sample (deterministic, testable in Node); the app wraps the samples in an AudioBuffer.
import type { BeatGrid } from "@shared/attempt.ts";
import { BARS_PER_PHRASE, BEATS_PER_BAR, phraseStartsOf } from "./track.ts";
import type { LessonTrack } from "./types.ts";

type Layer = "kick" | "hat" | "bass" | "pad" | "roll";

export interface SyntheticLayout {
  readonly bpm: number;
  readonly sections: readonly { readonly name: string; readonly bars: number; readonly layers: readonly Layer[] }[];
  /** Silence after the last bar, seconds. */
  readonly tailSec: number;
  readonly peakDbfs: number;
}

/** 80 bars at 124 BPM: intro 16, groove 16, breakdown 8, build 8, drop 16, outro 16. */
export const SYNTHETIC_HOUSE: SyntheticLayout = {
  bpm: 124,
  sections: [
    { name: "intro", bars: 16, layers: ["kick", "hat"] },
    { name: "groove", bars: 16, layers: ["kick", "hat", "bass"] },
    { name: "breakdown", bars: 8, layers: ["pad"] },
    { name: "build", bars: 8, layers: ["pad", "roll"] },
    { name: "drop", bars: 16, layers: ["kick", "hat", "bass", "pad"] },
    { name: "outro", bars: 16, layers: ["kick", "hat"] },
  ],
  tailSec: 1.5,
  peakDbfs: -6,
};

export const SYNTHETIC_TRACK_ID = "synthetic/house-124";

function totalBars(layout: SyntheticLayout): number {
  return layout.sections.reduce((sum, section) => sum + section.bars, 0);
}

function durationOf(layout: SyntheticLayout): number {
  return (totalBars(layout) * BEATS_PER_BAR * 60) / layout.bpm + layout.tailSec;
}

export function syntheticLessonTrack(layout: SyntheticLayout): LessonTrack {
  const grid: BeatGrid = { bpm: layout.bpm, firstBeat: 0, downbeatIndex: 0, rmsResidualMs: 0 };
  const durationSec = durationOf(layout);
  let bar = 1;
  const sections = layout.sections.map((section) => {
    const named = { name: section.name, phrase: Math.floor((bar - 1) / BARS_PER_PHRASE) + 1 };
    bar += section.bars;
    return named;
  });
  return {
    trackId: SYNTHETIC_TRACK_ID,
    title: "Practice Groove (synthetic)",
    attribution: { text: "A practice groove generated in the browser by learn-to-dj", url: null },
    source: "synthetic",
    durationSec,
    grid,
    phraseStarts: phraseStartsOf(grid, durationSec),
    sections,
  };
}

/** Deterministic noise in [-1, 1) (xorshift32), so every render is identical. */
function noise(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 2 ** 31 - 1;
  };
}

/** Adds `voice(t)` for `lengthSec` from `startSec` into `out`. */
function addVoice(out: Float32Array<ArrayBuffer>, rate: number, startSec: number, lengthSec: number, voice: (t: number) => number): void {
  const from = Math.round(startSec * rate);
  const to = Math.min(out.length, from + Math.round(lengthSec * rate));
  for (let index = from; index < to; index += 1) out[index] = (out[index] ?? 0) + voice((index - from) / rate);
}

function kick(t: number): number {
  // Pitch falls 150 → 50 Hz; the phase is the integral of that frequency.
  const phase = 2 * Math.PI * (50 * t + 100 * 0.03 * (1 - Math.exp(-t / 0.03)));
  return Math.sin(phase) * Math.exp(-t / 0.18);
}

const PAD_HZ = [220, 261.63, 329.63];

/** Mono samples of the layout at `sampleRate`, peak-normalised to `layout.peakDbfs`. */
export function synthesizeHouse(layout: SyntheticLayout, sampleRate: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(Math.round(durationOf(layout) * sampleRate));
  const beat = 60 / layout.bpm;
  const random = noise(0x5eed);
  let barIndex = 0;

  for (const section of layout.sections) {
    const sectionStart = barIndex * BEATS_PER_BAR * beat;
    const sectionLength = section.bars * BEATS_PER_BAR * beat;
    const beats = section.bars * BEATS_PER_BAR;
    for (let index = 0; index < beats; index += 1) {
      const at = sectionStart + index * beat;
      if (section.layers.includes("kick")) addVoice(out, sampleRate, at, 0.3, kick);
      if (section.layers.includes("hat")) addVoice(out, sampleRate, at + beat / 2, 0.05, (t) => 0.25 * random() * Math.exp(-t / 0.012));
      if (section.layers.includes("bass")) {
        addVoice(out, sampleRate, at + beat / 2, 0.18, (t) => 0.35 * Math.sin(2 * Math.PI * 55 * t) * Math.min(1, t / 0.005) * Math.exp(-t / 0.12));
      }
      if (section.layers.includes("roll")) {
        const loudness = 0.05 + 0.25 * (index / beats);
        for (let sixteenth = 0; sixteenth < 4; sixteenth += 1) {
          addVoice(out, sampleRate, at + (sixteenth * beat) / 4, 0.04, (t) => loudness * random() * Math.exp(-t / 0.015));
        }
      }
    }
    if (section.layers.includes("pad")) {
      addVoice(out, sampleRate, sectionStart, sectionLength, (t) => {
        const swell = Math.min(1, t / 0.5, (sectionLength - t) / 0.2);
        return 0.06 * swell * PAD_HZ.reduce((sum, hz) => sum + Math.sin(2 * Math.PI * hz * t), 0);
      });
    }
    barIndex += section.bars;
  }

  const peak = out.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
  const gain = peak === 0 ? 0 : 10 ** (layout.peakDbfs / 20) / peak;
  for (let index = 0; index < out.length; index += 1) out[index] = (out[index] ?? 0) * gain;
  return out;
}
