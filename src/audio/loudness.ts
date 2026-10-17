// K-weighted loudness (ITU-R BS.1770-4, EBU R128) and sample peak, computed in 20 ms frames.
// Pure DSP with no Web Audio dependency: the meter AudioWorklet wraps it, and unit tests drive it directly.
//
// Momentary loudness is the mean square over the last 400 ms, short-term over the last 3 s, both
// K-weighted, summed over channels with weight 1 (left/right/mono), as -0.691 + 10·log10(sum).
// Windows start silent: just after metering begins they include the silence before it.

export interface LoudnessFrame {
  /** Sample index (on the meter's clock) just after the frame's last sample. */
  readonly endFrame: number;
  /** Highest absolute sample in the frame, in dBFS (not true peak). */
  readonly samplePeakDb: number;
  readonly momentaryLufs: number;
  readonly shortTermLufs: number;
}

export const METER_FRAMES_PER_SECOND = 50;
/** Registered name of the AudioWorklet processor in meter-processor.ts. */
export const METER_PROCESSOR_NAME = "learn-to-dj-loudness-meter";
const MOMENTARY_FRAMES = 20; // 400 ms
const SHORT_TERM_FRAMES = 150; // 3 s

interface BiquadCoefficients {
  readonly b0: number;
  readonly b1: number;
  readonly b2: number;
  readonly a1: number;
  readonly a2: number;
}

/**
 * The two K-weighting stages for any sample rate, by the bilinear transform of the analogue prototypes
 * as in libebur128 (https://github.com/jiixyj/libebur128/blob/v1.2.6/ebur128/ebur128.c#L113-L146).
 * At 48 kHz this reproduces the BS.1770 coefficient table.
 */
function kWeightingStages(sampleRate: number): readonly BiquadCoefficients[] {
  const shelf = (() => {
    const q = 0.7071752369554196;
    const k = Math.tan((Math.PI * 1681.974450955533) / sampleRate);
    const highGain = 10 ** (3.999843853973347 / 20);
    const bandGain = highGain ** 0.4996667741545416;
    const a0 = 1 + k / q + k * k;
    return {
      b0: (highGain + (bandGain * k) / q + k * k) / a0,
      b1: (2 * (k * k - highGain)) / a0,
      b2: (highGain - (bandGain * k) / q + k * k) / a0,
      a1: (2 * (k * k - 1)) / a0,
      a2: (1 - k / q + k * k) / a0,
    };
  })();
  const highPass = (() => {
    const q = 0.5003270373238773;
    const k = Math.tan((Math.PI * 38.13547087602444) / sampleRate);
    const a0 = 1 + k / q + k * k;
    return { b0: 1, b1: -2, b2: 1, a1: (2 * (k * k - 1)) / a0, a2: (1 - k / q + k * k) / a0 };
  })();
  return [shelf, highPass];
}

/** Transposed direct form II state of one biquad on one channel. */
class BiquadState {
  private z1 = 0;
  private z2 = 0;

  constructor(private readonly c: BiquadCoefficients) {}

  step(input: number): number {
    const output = this.c.b0 * input + this.z1;
    this.z1 = this.c.b1 * input - this.c.a1 * output + this.z2;
    this.z2 = this.c.b2 * input - this.c.a2 * output;
    return output;
  }
}

/** Fixed-size ring of frame energies with a running sum. Bounded by construction. */
class EnergyWindow {
  private readonly energies: Float64Array;
  private next = 0;

  constructor(frames: number) {
    this.energies = new Float64Array(frames);
  }

  push(energy: number): void {
    this.energies[this.next] = energy;
    this.next = (this.next + 1) % this.energies.length;
  }

  /** Mean energy per frame; summed fresh each time so rounding never accumulates. */
  mean(): number {
    return this.energies.reduce((sum, energy) => sum + energy, 0) / this.energies.length;
  }
}

function toLufs(meanSquare: number): number {
  return meanSquare <= 0 ? Number.NEGATIVE_INFINITY : -0.691 + 10 * Math.log10(meanSquare);
}

function toDb(amplitude: number): number {
  return amplitude <= 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(amplitude);
}

export class LoudnessMeter {
  readonly frameLength: number;
  private readonly stages: readonly BiquadCoefficients[];
  private readonly filters: BiquadState[][] = [];
  private readonly momentary = new EnergyWindow(MOMENTARY_FRAMES);
  private readonly shortTerm = new EnergyWindow(SHORT_TERM_FRAMES);
  private samplesInFrame = 0;
  private sumOfSquares = 0;
  private peak = 0;

  constructor(sampleRate: number) {
    this.frameLength = Math.round(sampleRate / METER_FRAMES_PER_SECOND);
    this.stages = kWeightingStages(sampleRate);
  }

  /**
   * Meters one render block. `channels` may be empty (a disconnected input is silence).
   * `startFrame` is the sample index of the block's first sample; `onFrame` is called for each completed frame.
   */
  process(
    channels: readonly Float32Array[],
    blockLength: number,
    startFrame: number,
    onFrame: (frame: LoudnessFrame) => void,
  ): void {
    const filters = this.filtersFor(channels.length);
    for (let index = 0; index < blockLength; index++) {
      for (const [channelIndex, channel] of channels.entries()) {
        const sample = channel[index] ?? 0;
        this.peak = Math.max(this.peak, Math.abs(sample));
        const weighted = (filters[channelIndex] ?? []).reduce((value, filter) => filter.step(value), sample);
        this.sumOfSquares += weighted * weighted;
      }
      this.samplesInFrame++;
      if (this.samplesInFrame === this.frameLength) onFrame(this.completeFrame(startFrame + index + 1));
    }
  }

  private completeFrame(endFrame: number): LoudnessFrame {
    const energy = this.sumOfSquares / this.frameLength;
    this.momentary.push(energy);
    this.shortTerm.push(energy);
    const frame = {
      endFrame,
      samplePeakDb: toDb(this.peak),
      momentaryLufs: toLufs(this.momentary.mean()),
      shortTermLufs: toLufs(this.shortTerm.mean()),
    };
    this.samplesInFrame = 0;
    this.sumOfSquares = 0;
    this.peak = 0;
    return frame;
  }

  private filtersFor(channelCount: number): BiquadState[][] {
    while (this.filters.length < channelCount) {
      this.filters.push(this.stages.map((stage) => new BiquadState(stage)));
    }
    return this.filters;
  }
}
