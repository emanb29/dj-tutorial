// The Render's output as it is kept (ISS-190): 16-bit PCM, stereo interleaved, little-endian, and
// what is measured on it on the way: sample peak, integrated loudness (ITU-R BS.1770-4 gating, from
// the meter in src/audio/loudness.ts) and how many samples clipped. Nothing is normalised: a plan
// that clips says so, with the fix. Pure.
import { LoudnessMeter } from "@audio/loudness.ts";

/** BS.1770 gating: blocks are 400 ms, every 100 ms; the meter's frames are 20 ms. */
const FRAMES_PER_BLOCK_STEP = 5;
const BLOCK_FRAMES = 20;
const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = -10;

const energyOf = (lufs: number) => 10 ** ((lufs + 0.691) / 10);
const lufsOf = (energy: number) => (energy <= 0 ? Number.NEGATIVE_INFINITY : -0.691 + 10 * Math.log10(energy));

/** Integrated loudness from the momentary loudness of each 400 ms block, LUFS (−∞ for silence). */
export function integratedLoudness(blockLufs: readonly number[]): number {
  const loud = blockLufs.filter((lufs) => lufs > ABSOLUTE_GATE_LUFS).map(energyOf);
  if (loud.length === 0) return Number.NEGATIVE_INFINITY;
  const relativeGate = lufsOf(loud.reduce((sum, energy) => sum + energy, 0) / loud.length) + RELATIVE_GATE_LU;
  const gated = loud.filter((energy) => lufsOf(energy) > relativeGate);
  return lufsOf(gated.reduce((sum, energy) => sum + energy, 0) / gated.length);
}

export interface RenderLevels {
  /** Highest absolute sample, dBFS, before the 16-bit conversion (above 0 means it clipped). */
  readonly peakDbfs: number;
  readonly integratedLufs: number;
  /** Samples (either channel) past full scale, held at full scale in the file. */
  readonly clippedSamples: number;
}

/** Full scale is held, never wrapped round. */
function toInt16(sample: number): number {
  const held = Math.max(-1, Math.min(1, sample));
  return Math.round(held < 0 ? held * 0x8000 : held * 0x7fff);
}

/** Turns the kept audio into 16-bit PCM, segment by segment, measuring it as one continuous signal. */
export class PcmEncoder {
  private readonly meter: LoudnessMeter;
  private readonly blocks: number[] = [];
  private frames = 0;
  private meterFrames = 0;
  private peak = 0;
  private clipped = 0;

  constructor(sampleRate: number) {
    this.meter = new LoudnessMeter(sampleRate);
  }

  /** Little-endian interleaved 16-bit PCM of `left` and `right` (equal lengths). */
  encode(left: Float32Array, right: Float32Array): Uint8Array<ArrayBuffer> {
    if (left.length !== right.length) throw new Error(`The channels differ in length (${String(left.length)} and ${String(right.length)}): pass one segment's two channels.`);
    const bytes = new Uint8Array(left.length * 4);
    const view = new DataView(bytes.buffer);
    let peak = this.peak;
    let clipped = this.clipped;
    for (let index = 0; index < left.length; index++) {
      const l = left[index] ?? 0;
      const r = right[index] ?? 0;
      const size = Math.max(Math.abs(l), Math.abs(r));
      if (size > peak) peak = size;
      if (size > 1) clipped += (Math.abs(l) > 1 ? 1 : 0) + (Math.abs(r) > 1 ? 1 : 0);
      view.setInt16(index * 4, toInt16(l), true);
      view.setInt16(index * 4 + 2, toInt16(r), true);
    }
    this.peak = peak;
    this.clipped = clipped;
    // Every 100 ms, the 400 ms block just ended (its momentary loudness), once the first is complete.
    this.meter.process([left, right], left.length, this.frames, (frame) => {
      this.meterFrames++;
      if (this.meterFrames >= BLOCK_FRAMES && this.meterFrames % FRAMES_PER_BLOCK_STEP === 0) this.blocks.push(frame.momentaryLufs);
    });
    this.frames += left.length;
    return bytes;
  }

  levels(): RenderLevels {
    return { peakDbfs: this.peak === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(this.peak), integratedLufs: integratedLoudness(this.blocks), clippedSamples: this.clipped };
  }
}
