// Synthetic two-track mixes with known transitions, rendered offline (pure TypeScript, so the same
// fixture runs in Node and in the browser). Each track is a kick (with a click) on every beat, an
// off-beat hat and bass note, and a three-note pad; the two tracks use different notes, so they sound
// different without changing tempo.
//
// The incoming track comes in at -6 dB on a beat and rises to full over the blend; the outgoing one
// stays full for the first half of the blend and fades out over the second.

export interface MixFixtureSpec {
  readonly sampleRate?: number;
  readonly bpm: number;
  /** Silence before track A. */
  readonly leadInSec?: number;
  /** Beat of A's grid (from A's first beat, which is a phrase start) at which B comes in. */
  readonly bEntryBeat: number;
  /** 0 is a cut: A stops on the beat B starts. */
  readonly blendBeats: number;
  /** How long B plays, in beats. */
  readonly bBeats: number;
  /** B's tempo over A's: anything but 1 drifts. */
  readonly bTempoRatio?: number;
  /** In the blend: "swap" cuts A's bass at the midpoint and brings B's in there; "both" plays both basslines in full. */
  readonly bass?: "swap" | "both";
  /** B's level relative to A, in dB. */
  readonly bGainDb?: number;
  /** A cut only: silence between A's end and B's start. */
  readonly gapSec?: number;
  /** B plays 12 dB hot, clipped at full scale. */
  readonly clip?: boolean;
}

export interface MixFixture {
  readonly channels: readonly [Float32Array, Float32Array];
  readonly sampleRate: number;
  readonly truth: {
    readonly aStartSec: number;
    readonly bEntrySec: number;
    /** When A is gone (A's last sound for a cut). */
    readonly blendEndSec: number;
  };
}

interface Voice {
  readonly bassHz: number;
  readonly padHz: readonly number[];
  readonly seed: number;
}

/** A minor over C#2; F# major over F#2: no pitch class in common above 80 Hz, and basslines clear of the kick (48 Hz) and of each other. */
const VOICE_A: Voice = { bassHz: 69.3, padHz: [220, 261.63, 329.63], seed: 7 };
const VOICE_B: Voice = { bassHz: 92.5, padHz: [185, 233.08, 277.18], seed: 11 };
/** Keeps the loudest blend (two kicks on one beat) under full scale. */
const MASTER = 0.32;

function kickWave(sampleRate: number): Float32Array {
  const wave = new Float32Array(Math.round(0.3 * sampleRate));
  let phase = 0;
  for (let i = 0; i < wave.length; i++) {
    phase += (2 * Math.PI * (48 + 110 * Math.exp(-i / sampleRate / 0.03))) / sampleRate;
    wave[i] = Math.min(1, i / 32) * Math.sin(phase) * Math.exp(-i / sampleRate / 0.16);
  }
  return wave;
}

/**
 * Adds one track to `out`: beats at `startSec + n * beatSec` for n in [0, beats), the level from
 * `gain(t)` and the bassline's from `bassGain(t)` (both 0-1, t in seconds of the mix).
 */
function addTrack(
  out: Float32Array,
  sampleRate: number,
  voice: Voice,
  startSec: number,
  beatSec: number,
  beats: number,
  gain: (t: number) => number,
  bassGain: (t: number) => number,
): void {
  const kick = kickWave(sampleRate);
  let seed = voice.seed;
  const noise = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed / 2147483647) * 2 - 1;
  };
  const add = (index: number, value: number) => {
    if (index >= 0 && index < out.length) out[index] = (out[index] ?? 0) + value;
  };
  for (let n = 0; n < beats; n++) {
    const t = startSec + n * beatSec;
    const level = MASTER * gain(t);
    const start = Math.round(t * sampleRate);
    for (let i = 0; i < kick.length; i++) add(start + i, level * (kick[i] ?? 0));
    // The kick's click: 3 ms of noise, as a real kick's beater has.
    for (let i = 0; i < 0.003 * sampleRate; i++) add(start + i, level * 0.4 * noise());
    const hat = Math.round((t + beatSec / 2) * sampleRate);
    for (let i = 0; i < 1500; i++) add(hat + i, level * 0.25 * noise() * Math.exp(-i / 300));
    // An off-beat bassline, as in house: the kick keeps the beat.
    const noteStart = Math.round((t + beatSec / 2) * sampleRate);
    const bassLevel = level * bassGain(t + beatSec / 2) * 0.7;
    if (bassLevel > 0) {
      const length = Math.round(0.45 * beatSec * sampleRate);
      for (let i = 0; i < length; i++) {
        add(noteStart + i, bassLevel * Math.sin((2 * Math.PI * voice.bassHz * i) / sampleRate) * Math.exp(-i / sampleRate / 0.18) * Math.min(1, i / 64));
      }
    }
  }
  const from = Math.round(startSec * sampleRate);
  const to = Math.min(out.length, Math.round((startSec + beats * beatSec) * sampleRate));
  for (let i = Math.max(0, from); i < to; i++) {
    const t = i / sampleRate;
    const level = MASTER * gain(t) * 0.09;
    if (level === 0) continue;
    const swell = 0.75 + 0.25 * Math.cos((2 * Math.PI * (t - startSec)) / beatSec);
    out[i] = (out[i] ?? 0) + level * swell * voice.padHz.reduce((sum, hz) => sum + Math.sin(2 * Math.PI * hz * (t - startSec)), 0);
  }
}

export function renderMixFixture(spec: MixFixtureSpec): MixFixture {
  const sampleRate = spec.sampleRate ?? 22_050;
  const beatSec = 60 / spec.bpm;
  const bBeatSec = beatSec / (spec.bTempoRatio ?? 1);
  const aStartSec = spec.leadInSec ?? 0;
  const bEntrySec = aStartSec + spec.bEntryBeat * beatSec;
  const blendSec = spec.blendBeats * beatSec;
  const blendEndSec = bEntrySec + blendSec;
  const bStartSec = bEntrySec + (spec.blendBeats === 0 ? (spec.gapSec ?? 0) : 0);
  const bLevel = 10 ** ((spec.bGainDb ?? 0) / 20) * (spec.clip === true ? 4 : 1);
  const totalSec = bStartSec + spec.bBeats * bBeatSec + 0.5;
  const mono = new Float32Array(Math.round(totalSec * sampleRate));
  const midSec = bEntrySec + blendSec / 2;
  const blend = spec.blendBeats > 0;
  // A: full until the blend's midpoint, then down to silence at its end.
  const aGain = (t: number) => (!blend || t < midSec ? 1 : Math.max(0, (blendEndSec - t) / (blendEndSec - midSec)));
  const aBass = (t: number) => (blend && spec.bass !== "both" && t >= midSec ? 0 : 1);
  const aBeats = blend ? Math.ceil((blendEndSec - aStartSec) / beatSec) : spec.bEntryBeat;
  addTrack(mono, sampleRate, VOICE_A, aStartSec, beatSec, aBeats, aGain, aBass);
  // B: -6 dB on its first beat, rising to full at the blend's end.
  const bGain = (t: number) => bLevel * (!blend || t >= blendEndSec ? 1 : 0.5 + (0.5 * (t - bEntrySec)) / blendSec);
  const bBass = (t: number) => (blend && spec.bass !== "both" && t < midSec ? 0 : 1);
  addTrack(mono, sampleRate, VOICE_B, bStartSec, bBeatSec, spec.bBeats, bGain, bBass);
  if (spec.clip === true) mono.forEach((x, i) => (mono[i] = Math.max(-1, Math.min(1, x))));
  return {
    channels: [mono, mono.slice()],
    sampleRate,
    truth: { aStartSec, bEntrySec: bStartSec, blendEndSec: blend ? blendEndSec : bEntrySec },
  };
}

/** 16-bit PCM WAV bytes of `channels`, as a recording app would save them. */
export function encodeWav(channels: readonly Float32Array[], sampleRate: number): Uint8Array<ArrayBuffer> {
  const frames = channels[0]?.length ?? 0;
  const bytes = new Uint8Array(new ArrayBuffer(44 + frames * channels.length * 2));
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + frames * channels.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels.length, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels.length * 2, true);
  view.setUint16(32, channels.length * 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, frames * channels.length * 2, true);
  for (let i = 0; i < frames; i++) {
    for (const [c, channel] of channels.entries()) {
      const x = Math.max(-1, Math.min(1, channel[i] ?? 0));
      view.setInt16(44 + (i * channels.length + c) * 2, Math.round(x < 0 ? x * 32768 : x * 32767), true);
    }
  }
  return bytes;
}
