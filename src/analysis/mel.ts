/* eslint-disable @typescript-eslint/no-non-null-assertion -- indices are bounded by the frame,
   bin and band counts computed here; this runs over every frame of a track. */

// Beat This! front end, matching beat_this.preprocessing.LogMelSpect (torchaudio MelSpectrogram):
// 22050 Hz mono, n_fft 1024, hop 441 (50 fps), periodic Hann, center=True with reflect padding,
// magnitude (power 1) divided by sqrt(n_fft) (normalized="frame_length"), 128 slaney-scale mel
// bands from 30 Hz to 11 kHz without area normalisation, then log1p(1000 * mel).
// Checked against torchaudio by mel.test.ts (fixture from scripts/model-export/reference.py).

import { Fft } from "./fft.ts";

export const MODEL_SAMPLE_RATE = 22_050;
export const FFT_SIZE = 1024;
export const HOP = 441;
export const MEL_BANDS = 128;
export const FRAMES_PER_SECOND = MODEL_SAMPLE_RATE / HOP;
const BINS = FFT_SIZE / 2 + 1;

const hzToSlaney = (hz: number) => (hz < 1000 ? (3 * hz) / 200 : 15 + (27 * Math.log(hz / 1000)) / Math.log(6.4));
const slaneyToHz = (mel: number) => (mel < 15 ? (200 * mel) / 3 : 1000 * Math.exp(((mel - 15) * Math.log(6.4)) / 27));

/** torchaudio.functional.melscale_fbanks(513, 30, 11000, 128, 22050, norm=None, mel_scale="slaney"),
 * row-major [bin][mel]. */
export function melFilterbank(lowestHz = 30, highestHz = 11_000): Float32Array {
  const lowMel = hzToSlaney(lowestHz);
  const highMel = hzToSlaney(highestHz);
  const points = Array.from({ length: MEL_BANDS + 2 }, (_, i) =>
    slaneyToHz(lowMel + ((highMel - lowMel) * i) / (MEL_BANDS + 1)),
  );
  const bank = new Float32Array(BINS * MEL_BANDS);
  for (let bin = 0; bin < BINS; bin++) {
    const hz = (bin * MODEL_SAMPLE_RATE) / 2 / (BINS - 1);
    for (let m = 0; m < MEL_BANDS; m++) {
      const down = (hz - points[m]!) / (points[m + 1]! - points[m]!);
      const up = (points[m + 2]! - hz) / (points[m + 2]! - points[m + 1]!);
      bank[bin * MEL_BANDS + m] = Math.max(0, Math.min(down, up));
    }
  }
  return bank;
}

/** Number of frames torchaudio produces for `samples` samples with center=True. */
export const frameCount = (samples: number) => 1 + Math.floor(samples / HOP);

/** Log-mel spectrogram of a 22 050 Hz mono signal, row-major [frame][mel]. */
export function logMel(signal: Float32Array, bank: Float32Array = melFilterbank()): Float32Array {
  if (signal.length <= FFT_SIZE / 2) {
    throw new RangeError(
      `need more than ${String(FFT_SIZE / 2)} samples for reflect padding, got ${String(signal.length)}`,
    );
  }
  const frames = frameCount(signal.length);
  const out = new Float32Array(frames * MEL_BANDS);
  const fft = new Fft(FFT_SIZE);
  const window = Float64Array.from({ length: FFT_SIZE }, (_, n) => 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / FFT_SIZE));
  const real = new Float64Array(FFT_SIZE);
  const imaginary = new Float64Array(FFT_SIZE);
  const magnitude = new Float64Array(BINS);
  const mel = new Float64Array(MEL_BANDS);
  const pad = FFT_SIZE / 2;
  const last = signal.length - 1;
  const scale = 1 / Math.sqrt(FFT_SIZE);
  for (let f = 0; f < frames; f++) {
    const start = f * HOP - pad;
    for (let n = 0; n < FFT_SIZE; n++) {
      let index = start + n;
      if (index < 0) index = -index;
      else if (index > last) index = 2 * last - index;
      real[n] = signal[index]! * window[n]!;
      imaginary[n] = 0;
    }
    fft.forward(real, imaginary);
    for (let b = 0; b < BINS; b++) magnitude[b] = Math.hypot(real[b]!, imaginary[b]!) * scale;
    mel.fill(0);
    for (let b = 0; b < BINS; b++) {
      const value = magnitude[b]!;
      if (value === 0) continue;
      const row = b * MEL_BANDS;
      for (let m = 0; m < MEL_BANDS; m++) mel[m] = mel[m]! + value * bank[row + m]!;
    }
    const row = f * MEL_BANDS;
    for (let m = 0; m < MEL_BANDS; m++) out[row + m] = Math.log1p(1000 * mel[m]!);
  }
  return out;
}
