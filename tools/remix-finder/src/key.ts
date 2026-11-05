/**
 * Musical key from audio: a chromagram correlated with the Krumhansl-Kessler key profiles, and the
 * key on the Camelot wheel DJs use. An estimate, like any key detector: expect the relative or a
 * fifth-related key now and then, which are harmonic neighbours on the wheel anyway.
 */
import { Fft } from "../../../src/analysis/fft.ts";

export const PITCH_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"] as const;

export type Mode = "major" | "minor";

export interface MusicalKey {
  /** 0 = C … 11 = B. */
  readonly tonic: number;
  readonly mode: Mode;
}

export interface KeyEstimate extends MusicalKey {
  /** "8A"-style Camelot code. */
  readonly camelot: string;
  /** "A minor"-style name. */
  readonly name: string;
  /** 0–1: how far the best key's correlation beats the runner-up's. Below ~0.05 is a guess. */
  readonly confidence: number;
}

const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const mod = (value: number, base: number) => ((value % base) + base) % base;

/** The Camelot number (1–12) and letter: A for minor, B for major. */
export function camelot(key: MusicalKey): { readonly number: number; readonly letter: "A" | "B" } {
  const majorTonic = key.mode === "major" ? key.tonic : key.tonic + 3;
  const number = mod(7 * majorTonic + 8, 12);
  return { number: number === 0 ? 12 : number, letter: key.mode === "major" ? "B" : "A" };
}

export const camelotCode = (key: MusicalKey) => {
  const { number, letter } = camelot(key);
  return `${String(number)}${letter}`;
};

export const keyName = (key: MusicalKey) => `${PITCH_NAMES[key.tonic] ?? "?"} ${key.mode}`;

/** "8A" → its number and letter, or null when it is not a Camelot code. */
export function parseCamelot(code: string): { readonly number: number; readonly letter: "A" | "B" } | null {
  const match = /^(1[0-2]|[1-9])([AB])$/i.exec(code.trim());
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return { number: Number(match[1]), letter: match[2].toUpperCase() === "A" ? "A" : "B" };
}

/**
 * How two keys mix, by the Camelot wheel: "same", "neighbour" (±1 on the same ring: a fifth
 * apart), "relative" (same number, other ring), or "clash".
 */
export type Harmony = "same" | "neighbour" | "relative" | "clash";

export function harmony(a: string, b: string): Harmony {
  const x = parseCamelot(a);
  const y = parseCamelot(b);
  if (x === null || y === null) return "clash";
  if (x.number === y.number) return x.letter === y.letter ? "same" : "relative";
  const apart = Math.min(mod(x.number - y.number, 12), mod(y.number - x.number, 12));
  return apart === 1 && x.letter === y.letter ? "neighbour" : "clash";
}

const pearson = (a: readonly number[], b: readonly number[]) => {
  const n = a.length;
  const meanA = a.reduce((sum, v) => sum + v, 0) / n;
  const meanB = b.reduce((sum, v) => sum + v, 0) / n;
  let top = 0;
  let left = 0;
  let right = 0;
  for (let i = 0; i < n; i++) {
    const da = (a[i] ?? 0) - meanA;
    const db = (b[i] ?? 0) - meanB;
    top += da * db;
    left += da * da;
    right += db * db;
  }
  return left === 0 || right === 0 ? 0 : top / Math.sqrt(left * right);
};

const FRAME = 8192;
const HOP = 4096;
const LOWEST_HZ = 55;
const HIGHEST_HZ = 2000;

/** Twelve pitch-class energies over the whole clip, each frame normalised so loud bars don't dominate. */
export function chroma(mono: Float32Array, sampleRate: number): number[] {
  const fft = new Fft(FRAME);
  const window = Float64Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1)));
  const binPitch = Int8Array.from({ length: FRAME / 2 }, (_, bin) => {
    const hz = (bin * sampleRate) / FRAME;
    if (hz < LOWEST_HZ || hz > HIGHEST_HZ) return -1;
    return mod(Math.round(12 * Math.log2(hz / 440)) + 9, 12);
  });
  const total = new Array<number>(12).fill(0);
  const real = new Float64Array(FRAME);
  const imaginary = new Float64Array(FRAME);
  for (let start = 0; start + FRAME <= mono.length; start += HOP) {
    for (let i = 0; i < FRAME; i++) {
      real[i] = (mono[start + i] ?? 0) * (window[i] ?? 0);
      imaginary[i] = 0;
    }
    fft.forward(real, imaginary);
    const frame = new Array<number>(12).fill(0);
    for (let bin = 1; bin < FRAME / 2; bin++) {
      const pitch = binPitch[bin] ?? -1;
      if (pitch < 0) continue;
      const magnitude = Math.hypot(real[bin] ?? 0, imaginary[bin] ?? 0);
      frame[pitch] = (frame[pitch] ?? 0) + magnitude;
    }
    const peak = Math.max(...frame);
    if (peak <= 1e-9) continue;
    for (let pitch = 0; pitch < 12; pitch++) total[pitch] = (total[pitch] ?? 0) + (frame[pitch] ?? 0) / peak;
  }
  return total;
}

/** The best-correlating of the 24 keys for a chromagram; null when the clip is silent. */
export function keyFromChroma(profile: readonly number[]): KeyEstimate | null {
  if (profile.every((value) => value === 0)) return null;
  const scores = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].flatMap((tonic) => {
    const rotated = profile.map((_, i) => profile[mod(i + tonic, 12)] ?? 0);
    return [
      { tonic, mode: "major" as const, score: pearson(rotated, MAJOR_PROFILE) },
      { tonic, mode: "minor" as const, score: pearson(rotated, MINOR_PROFILE) },
    ];
  });
  scores.sort((a, b) => b.score - a.score);
  const [best, second] = scores;
  if (best === undefined || second === undefined) return null;
  const key = { tonic: best.tonic, mode: best.mode };
  return { ...key, camelot: camelotCode(key), name: keyName(key), confidence: Math.max(0, best.score - second.score) };
}

export const estimateKey = (mono: Float32Array, sampleRate: number) => keyFromChroma(chroma(mono, sampleRate));
