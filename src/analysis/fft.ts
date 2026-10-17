/* eslint-disable @typescript-eslint/no-non-null-assertion -- every index below is bounded by the
   transform size, which is checked once in the constructor; this is the hot loop of analysis. */

/** In-place radix-2 complex FFT of a fixed power-of-two size. */
export class Fft {
  readonly size: number;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly reversed: Uint32Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new RangeError(`FFT size must be a power of two, not ${String(size)}`);
    }
    this.size = size;
    this.cos = Float64Array.from({ length: size / 2 }, (_, i) => Math.cos((2 * Math.PI * i) / size));
    this.sin = Float64Array.from({ length: size / 2 }, (_, i) => -Math.sin((2 * Math.PI * i) / size));
    const bits = Math.log2(size);
    this.reversed = Uint32Array.from({ length: size }, (_, i) => {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      return r;
    });
  }

  /** Forward transform of (real, imaginary), in place. Both must have `size` elements. */
  forward(real: Float64Array, imaginary: Float64Array): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      const j = this.reversed[i]!;
      if (j > i) {
        const tr = real[i]!;
        real[i] = real[j]!;
        real[j] = tr;
        const ti = imaginary[i]!;
        imaginary[i] = imaginary[j]!;
        imaginary[j] = ti;
      }
    }
    for (let length = 2; length <= n; length *= 2) {
      const half = length / 2;
      const step = n / length;
      for (let start = 0; start < n; start += length) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step]!;
          const wi = this.sin[k * step]!;
          const a = start + k;
          const b = a + half;
          const xr = real[b]! * wr - imaginary[b]! * wi;
          const xi = real[b]! * wi + imaginary[b]! * wr;
          real[b] = real[a]! - xr;
          imaginary[b] = imaginary[a]! - xi;
          real[a] = real[a]! + xr;
          imaginary[a] = imaginary[a]! + xi;
        }
      }
    }
  }
}
