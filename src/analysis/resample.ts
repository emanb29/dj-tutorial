/* eslint-disable @typescript-eslint/no-non-null-assertion -- indices are bounded by the input and
   filter-table lengths computed here; this runs over every sample of a track. */

// Rational polyphase resampler (Kaiser-windowed sinc). Stands in for soxr, which the Beat This!
// reference uses; it only has to be linear-phase (no timing shift) and clean below 10 kHz, since
// the model's mel bands stop at 11 kHz.

const greatestCommonDivisor = (a: number, b: number): number => (b === 0 ? a : greatestCommonDivisor(b, a % b));

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 50; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

/** Mean of the channels (Beat This! downmixes with the arithmetic mean, not an energy-preserving
 * mix). Returns the input itself for mono. */
export function downmixMean(channels: readonly Float32Array[]): Float32Array {
  const [first, ...rest] = channels;
  if (first === undefined) throw new RangeError("downmixMean needs at least one channel");
  if (rest.length === 0) return first;
  const out = Float32Array.from(first);
  for (const channel of rest) for (let i = 0; i < out.length; i++) out[i] = out[i]! + channel[i]!;
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / channels.length;
  return out;
}

/** Resamples between integer rates. Returns the input itself when the rates are equal. */
export function resample(input: Float32Array, fromRate: number, toRate: number, zeroCrossings = 24): Float32Array {
  if (fromRate === toRate) return input;
  const divisor = greatestCommonDivisor(fromRate, toRate);
  const up = toRate / divisor;
  const down = fromRate / divisor;
  // Cut off a little below the lower Nyquist frequency.
  const cutoff = 0.95 * Math.min(1, toRate / fromRate);
  const halfWidth = Math.ceil(zeroCrossings / cutoff);
  const taps = 2 * halfWidth;
  const beta = 8.6;
  const norm = besselI0(beta);
  // table[p][k] = h((p / up) + halfWidth - 1 - k) for input sample floor(t) - halfWidth + 1 + k.
  const table = new Float32Array(up * taps);
  for (let p = 0; p < up; p++) {
    const fraction = p / up;
    for (let k = 0; k < taps; k++) {
      const x = fraction + halfWidth - 1 - k;
      const r = x / halfWidth;
      const window = Math.abs(r) >= 1 ? 0 : besselI0(beta * Math.sqrt(1 - r * r)) / norm;
      const argument = Math.PI * cutoff * x;
      const sinc = x === 0 ? 1 : Math.sin(argument) / argument;
      table[p * taps + k] = cutoff * sinc * window;
    }
  }
  const out = new Float32Array(Math.floor((input.length * up) / down));
  for (let n = 0; n < out.length; n++) {
    const position = n * down;
    const base = Math.floor(position / up);
    const phase = position - base * up;
    const first = base - halfWidth + 1;
    const row = phase * taps;
    let sum = 0;
    if (first >= 0 && first + taps <= input.length) {
      for (let k = 0; k < taps; k++) sum += input[first + k]! * table[row + k]!;
    } else {
      for (let k = 0; k < taps; k++) {
        const i = first + k;
        if (i >= 0 && i < input.length) sum += input[i]! * table[row + k]!;
      }
    }
    out[n] = sum;
  }
  return out;
}
