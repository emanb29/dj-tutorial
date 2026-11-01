// Sections for a track that has none named (the Learner's own music): each phrase is "groove" or, when
// it is much quieter than the track's typical phrase, "breakdown". That is enough for the Lessons'
// planners (steadyRun, fullGroovePhrase) to keep a blend or a loop on the groove. It names no drop or
// chorus, so a Lesson that needs those (or asks about them) still refuses the track. Pure.
import type { TrackSection } from "./types.ts";

/** A phrase this far below the median phrase level is a breakdown. */
const BREAKDOWN_BELOW_DB = 6;
/** Every Nth sample is enough for a level over a whole phrase, and keeps a long track quick. */
const SAMPLE_STRIDE = 16;

function levelDb(channels: readonly Float32Array[], from: number, to: number): number {
  let sum = 0;
  let count = 0;
  for (const channel of channels) {
    for (let index = from; index < Math.min(to, channel.length); index += SAMPLE_STRIDE) {
      const sample = channel[index] ?? 0;
      sum += sample * sample;
      count += 1;
    }
  }
  return count === 0 || sum === 0 ? Number.NEGATIVE_INFINITY : 10 * Math.log10(sum / count);
}

/** `phraseStarts` in track seconds, phrase 1 first (LessonTrack.phraseStarts). */
export function energySections(channels: readonly Float32Array[], sampleRate: number, phraseStarts: readonly number[]): TrackSection[] {
  const length = Math.max(0, ...channels.map((channel) => channel.length));
  const levels = phraseStarts.map((start, index) => {
    const end = phraseStarts[index + 1] ?? length / sampleRate;
    return levelDb(channels, Math.round(start * sampleRate), Math.round(end * sampleRate));
  });
  const sorted = levels.toSorted((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const names = levels.map((level) => (level < median - BREAKDOWN_BELOW_DB ? "breakdown" : "groove"));
  return names.flatMap((name, index) => (index > 0 && names[index - 1] === name ? [] : [{ name, phrase: index + 1 }]));
}
