/**
 * Grading a recorded mix (ISS-96): a mix the Learner recorded in rekordbox or any DJ software, from
 * files they own, uploaded as one audio file. Audio only: the app never reads deck state or any file
 * but the one uploaded.
 *
 * ```ts
 * const buffer = await new OfflineAudioContext(2, 1, MIX_RATE).decodeAudioData(bytes);
 * const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).slice());
 * const outcome = await gradeMix({ channels, sampleRate: buffer.sampleRate }, { onProgress, signal });
 * if (outcome.ok) show(outcome.report); else explain(outcome.error);
 * ```
 *
 * In the worker (grade.ts): beats over the whole mix with Beat This! (or none, when the model cannot
 * run), transitions from spectral novelty (features.ts, transitions.ts), a beat grid per track
 * (grids.ts), then per transition: on the phrase (phrase.ts), drift through blends (drift.ts),
 * loudness jumps, clipping and dead air (levels.ts), and bass clash (bass.ts). Pass marks are
 * MIX_THRESHOLDS in types.ts.
 *
 * Tests: each detector on its own, the whole grading on synthetic two-track mixes with known
 * transitions (test-mixes.ts), and the worker round trip in the browser.
 *
 * @module
 */
export { gradeMix, type GradeMixOptions } from "./client.ts";
export { MIX_RATE } from "./features.ts";
export type * from "./types.ts";
export { MIX_THRESHOLDS } from "./types.ts";
