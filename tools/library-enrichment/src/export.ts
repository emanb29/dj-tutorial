/**
 * The bridge to the app and to rekordbox: the collection XML with the applied fields filled in.
 *
 * Only attributes the collection has empty are written, except a title, which is written only when
 * an apply run was told to clean titles. rekordbox has no field for a remix's original artist, so it
 * goes in Comments ("Original artist: X") when Comments is empty.
 */
import type { CollectionTrack } from "./rekordbox-xml.ts";
import type { EnrichedField, StoreItem } from "./store.ts";

const ATTRIBUTE_OF: Partial<Record<EnrichedField, string>> = {
  artist: "Artist",
  title: "Name",
  remixer: "Remixer",
  mix: "Mix",
  genre: "Genre",
  year: "Year",
  originalArtist: "Comments",
};

export const ORIGINAL_ARTIST_PREFIX = "Original artist: ";

const isEmpty = (attribute: string, value: string | undefined) => {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" || (attribute === "Year" && trimmed === "0");
};

export interface Projection {
  readonly edits: Map<string, Record<string, string>>;
  /** Per attribute, how many TRACKs it was written on. */
  readonly counts: Record<string, number>;
}

export function projectEdits(tracks: readonly CollectionTrack[], hashByTrackId: ReadonlyMap<string, string>, items: Readonly<Record<string, StoreItem>>): Projection {
  const edits = new Map<string, Record<string, string>>();
  const counts: Record<string, number> = {};
  for (const track of tracks) {
    const hash = hashByTrackId.get(track.trackId);
    const item = hash === undefined ? undefined : items[hash];
    if (item === undefined) continue;
    const trackEdits: Record<string, string> = {};
    for (const [field, applied] of Object.entries(item.applied)) {
      const attribute = ATTRIBUTE_OF[field as EnrichedField];
      if (attribute === undefined) continue;
      if (attribute !== "Name" && !isEmpty(attribute, track.attributes[attribute])) continue;
      trackEdits[attribute] = attribute === "Comments" ? `${ORIGINAL_ARTIST_PREFIX}${applied.value}` : applied.value;
      counts[attribute] = (counts[attribute] ?? 0) + 1;
    }
    if (Object.keys(trackEdits).length > 0) edits.set(track.trackId, trackEdits);
  }
  return { edits, counts };
}
