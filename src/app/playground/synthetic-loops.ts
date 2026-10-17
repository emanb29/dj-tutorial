// Synthetic house loops for the playground, generated in code (no downloads). Four-on-the-floor kick,
// off-beat hats, claps on 2 and 4 and an off-beat bass. Phrases are audible: the first 8 bars are drums
// only, and each 8-bar phrase opens with a crash. The beat grid is exact: beat 0 at 0 s, a downbeat.

export interface LoopOptions {
  readonly sampleRate: number;
  readonly bpm: number;
  readonly bars: number;
  /** Bass root in Hz. */
  readonly rootHz: number;
  /** Seeds the noise for hats, claps and crashes, so a loop renders the same every time. */
  readonly seed: number;
}

export interface StereoSamples {
  readonly left: Float32Array<ArrayBuffer>;
  readonly right: Float32Array<ArrayBuffer>;
}

const BEATS_PER_BAR = 4;
const PHRASE_BARS = 8;
const MASTER_GAIN = 0.7;

/** mulberry32: a small deterministic PRNG returning -1…1. */
function noiseSource(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

type Voice = (data: Float32Array, start: number, sampleRate: number) => void;

const kick: Voice = (data, start, sampleRate) => {
  const length = Math.round(0.32 * sampleRate);
  let phase = 0;
  for (let index = 0; index < length && start + index < data.length; index++) {
    const t = index / sampleRate;
    const frequency = 45 + 85 * Math.exp(-t * 32);
    phase += (2 * Math.PI * frequency) / sampleRate;
    data[start + index] = (data[start + index] ?? 0) + 0.95 * Math.exp(-t * 9) * Math.sin(phase);
  }
};

function noiseBurst(noise: () => number, seconds: number, decay: number, gain: number, bright: boolean): Voice {
  return (data, start, sampleRate) => {
    const length = Math.round(seconds * sampleRate);
    let previous = 0;
    for (let index = 0; index < length && start + index < data.length; index++) {
      const sample = noise();
      // A first difference tilts the noise bright (hats); plain noise is fuller (claps, crash).
      const shaped = bright ? sample - previous : sample;
      previous = sample;
      data[start + index] = (data[start + index] ?? 0) + gain * Math.exp((-index / sampleRate) * decay) * shaped;
    }
  };
}

function bassNote(frequency: number, seconds: number): Voice {
  return (data, start, sampleRate) => {
    const length = Math.round(seconds * sampleRate);
    for (let index = 0; index < length && start + index < data.length; index++) {
      const t = index / sampleRate;
      const envelope = Math.min(1, t * 200) * Math.exp(-t * 6);
      const tone = Math.sin(2 * Math.PI * frequency * t) + 0.3 * Math.sin(4 * Math.PI * frequency * t);
      data[start + index] = (data[start + index] ?? 0) + 0.32 * envelope * tone;
    }
  };
}

export function renderHouseLoop(options: LoopOptions): StereoSamples {
  const { sampleRate, bpm, bars, rootHz } = options;
  const beatSamples = (60 / bpm) * sampleRate;
  const totalBeats = bars * BEATS_PER_BAR;
  const length = Math.round(totalBeats * beatSamples);
  const mono = new Float32Array(length);
  const sides = new Float32Array(length);
  const noise = noiseSource(options.seed);
  const hat = noiseBurst(noise, 0.09, 45, 0.16, true);
  const clap = noiseBurst(noise, 0.16, 26, 0.22, false);
  const crash = noiseBurst(noise, 1.6, 2.4, 0.12, true);
  // Root, root, fifth, minor third: a simple one-bar bass figure.
  const bassLine = [rootHz, rootHz, rootHz * 1.5, rootHz * 1.2];

  for (let beat = 0; beat < totalBeats; beat++) {
    const at = (offsetBeats: number) => Math.round((beat + offsetBeats) * beatSamples);
    const bar = Math.floor(beat / BEATS_PER_BAR);
    const beatInBar = beat % BEATS_PER_BAR;
    kick(mono, at(0), sampleRate);
    hat(sides, at(0.5), sampleRate);
    if (bar >= PHRASE_BARS / 2 && beatInBar % 2 === 1) clap(mono, at(0), sampleRate);
    if (bar >= PHRASE_BARS) bassNote(bassLine[beatInBar] ?? rootHz, 0.22)(mono, at(0.5), sampleRate);
    if (beatInBar === 0 && bar % PHRASE_BARS === 0) crash(sides, at(0), sampleRate);
  }

  // Hats and crashes sit a little to each side; everything else is centred.
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  for (let index = 0; index < length; index++) {
    const centre = mono[index] ?? 0;
    const side = sides[index] ?? 0;
    left[index] = Math.tanh(MASTER_GAIN * (centre + 0.9 * side));
    right[index] = Math.tanh(MASTER_GAIN * (centre + 1.1 * side));
  }
  return { left, right };
}
