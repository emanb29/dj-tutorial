// A new plan's level match per track (PlanTrack.gainDb): the Lessons' set-up trim, from the track's
// own sample peak, so a set of loud masters starts out of the red as every Lesson, Freestyle and the
// set builder do. Stored plans keep the level they were saved with.
import { peakDbfsOf, setUpTrimDbForPeaks } from "@lessons/track.ts";

/** The level match for a track with this sample peak (dBFS; null when it could not be measured). */
export function planTrackGainDb(peakDbfs: number | null): number {
  return setUpTrimDbForPeaks([peakDbfs]);
}

/** The level match of decoded audio. */
export function planTrackGainDbOf(audio: AudioBuffer): number {
  return planTrackGainDb(peakDbfsOf(Array.from({ length: audio.numberOfChannels }, (_, channel) => audio.getChannelData(channel))));
}
