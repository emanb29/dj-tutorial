// Which rekordbox entry is which file in the music folder. rekordbox knows a file's full path on the
// Mac ("/Users/dj/Music/House/a.mp3"); the browser knows only the picked folder and below
// ("Music/House/a.mp3"). So:
// 1. the entry whose path ends the same way, the most parts in common, wins when it is the only one
//    with that many and they share at least a folder as well as the name;
// 2. else the file name and size (the bytes rekordbox saw), and when copies share a size, the length;
// 3. else none.
// Names compare in Unicode NFC (macOS often gives decomposed accents) and ignoring case, as macOS's
// disk does.
import type { RekordboxTrack } from "./xml.ts";

export interface FolderFileFacts {
  /** From the picked folder's name down: "Music/House/a.mp3". */
  readonly path: string;
  readonly size: number;
  /** The decoded length, once the analysis knows it. */
  readonly durationSec?: number;
}

export interface RekordboxMatcher {
  match(file: FolderFileFacts): RekordboxTrack | null;
}

/** How far a file's length may be from rekordbox's TotalTime (whole seconds) and still be the same file. */
const SAME_LENGTH_SEC = 1.5;

const fold = (part: string) => part.normalize("NFC").toLowerCase();

function commonSuffix(a: readonly string[], b: readonly string[]): number {
  let count = 0;
  while (count < a.length && count < b.length && a[a.length - 1 - count] === b[b.length - 1 - count]) count += 1;
  return count;
}

export function createRekordboxMatcher(tracks: readonly RekordboxTrack[]): RekordboxMatcher {
  const byName = new Map<string, { track: RekordboxTrack; parts: readonly string[] }[]>();
  for (const track of tracks) {
    const parts = track.segments.map(fold);
    const name = parts.at(-1);
    if (name === undefined) continue;
    byName.set(name, [...(byName.get(name) ?? []), { track, parts }]);
  }
  return {
    match(file) {
      const parts = file.path.split("/").filter((part) => part !== "").map(fold);
      const candidates = byName.get(parts.at(-1) ?? "") ?? [];
      if (candidates.length === 0) return null;
      const scored = candidates.map((candidate) => ({ ...candidate, common: commonSuffix(candidate.parts, parts) }));
      const best = Math.max(...scored.map((each) => each.common));
      const top = scored.filter((each) => each.common === best);
      if (best >= 2 && top.length === 1) return top[0]?.track ?? null;
      const sized = candidates.filter((candidate) => candidate.track.size === file.size);
      if (sized.length === 1) return sized[0]?.track ?? null;
      if (sized.length > 1 && file.durationSec !== undefined) {
        const { durationSec } = file;
        const timed = sized.filter(({ track }) => track.totalTimeSec !== null && Math.abs(track.totalTimeSec - durationSec) <= SAME_LENGTH_SEC);
        if (timed.length === 1) return timed[0]?.track ?? null;
      }
      return null;
    },
  };
}
