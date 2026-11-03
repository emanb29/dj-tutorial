/**
 * Track sources: where the decks' music comes from. Every source lists or searches `Track`s and
 * loads one into a decoded `AudioBuffer` plus the content hash that keys its cached analysis.
 *
 * | Source | Module | Where the audio comes from | Shareable mixes |
 * |---|---|---|---|
 * | `starter-pack` | starter-pack.ts | archive.org, per tracks/starter-pack.json (bundled) | not for ND licences |
 * | `local-file` | local-files.ts | the Learner's files, read in the browser, never uploaded | no (licence unknown) |
 * | `audius` | audius.ts | Audius streams, kept in memory for the session only | no |
 * | `original` | originals.ts | the API, from .local/tracks/originals (server/originals.ts) | yes |
 * | `local-file` | music-folder/ | the Learner's music folder (picked here, or the API server's MUSIC_DIR), scanned in the background and kept up to date | no |
 *
 * ## Using it
 *
 * ```ts
 * const source = createStarterPackSource();
 * const listed = await source.list();
 * if (!listed.ok) return show(listed.error); // every error has .message and .fix
 * const loaded = await source.load(listed.value[0], { signal, onProgress: ({ fraction }) => bar(fraction) });
 * if (!loaded.ok) return show(loaded.error);
 * deck.load(loaded.value.audio);
 * // An Original carries its exact grid: use loaded.value.knownGrid and skip analysis.
 * // Otherwise analyse, caching under loaded.value.contentHash, unless
 * // loaded.value.track.retention is "session-only" (Audius): then keep the result in memory only.
 * ```
 *
 * ## Rules every source keeps
 *
 * - Failures are `TrackError` values with a `fix`; aborting the signal gives `{ kind: "aborted" }`.
 * - Progress `fraction` never decreases: fetching or reading is 0-0.8, decoding to 0.95, hashing to 1.
 * - Decoding uses an `OfflineAudioContext`, so loading never makes a sound.
 * - The content hash is shared/track-hash.ts, the one implementation; src/analysis re-exports it.
 * - `shareable` is false unless the licence allows sharing a recorded mix (an adaptation): ND
 *   licences, Audius tracks and unknown licences are not shareable.
 * - Show `track.attribution` (text and link) on the deck. For Audius, also show
 *   `audius.termsNotice()` wherever Audius search is offered.
 *
 * ## Tests
 *
 * Node (*.test.ts) with a fake fetch and decoder (test-support.ts); the browser test
 * (local-files.browser.test.ts) decodes a generated WAV through the real local-file path and checks
 * the IndexedDB handle store. The API side is tested in server/originals.test.ts.
 *
 * @module
 */
export { AUDIUS_API_TERMS_URL, AUDIUS_PRIVACY_POLICY_URL, createAudiusSource, type AudiusOptions, type AudiusSource } from "./audius.ts";
export { describeLicence, type LicenceInfo } from "./licence.ts";
export { decodeOffline, decoderAt, type AudioDecoder } from "./load-audio.ts";
export {
  createLocalFileSource,
  indexedDbHandleStore,
  LOCAL_FILE_INPUT,
  type DirectoryHandleLike,
  type FileHandleLike,
  type HandleStore,
  type LocalFileOptions,
  type LocalFileSource,
} from "./local-files.ts";
export {
  createMusicFolder,
  type AnalyseFile,
  type AnalyseFileResult,
  type FolderAccess,
  type FolderFile,
  type FolderOutcome,
  type FolderSource,
  type MusicFolder,
  type MusicFolderOptions,
  type MusicFolderRekordbox,
  type MusicFolderSnapshot,
} from "./music-folder/music-folder.ts";
export { indexedDbRekordboxCache, memoryRekordboxCache, type RekordboxCache } from "./rekordbox/cache.ts";
export { camelotFromTonality, knownGridFromRekordbox, rekordboxGrid, type RekordboxGrid } from "./rekordbox/grid.ts";
export { parseRekordboxFile } from "./rekordbox/parser.ts";
export {
  createRekordboxLink,
  type RekordboxFileHandle,
  type RekordboxLink,
  type RekordboxOutcome,
  type RekordboxStatus,
} from "./rekordbox/rekordbox-link.ts";
export type { RekordboxCue, RekordboxLibrary, RekordboxTrack } from "./rekordbox/xml.ts";
export { indexedDbEntryCache, memoryEntryCache, type EntryCache, type EntryRecord } from "./music-folder/entry-cache.ts";
export { scanAnywhere } from "./music-folder/scanner.ts";
export {
  isServerRoot,
  probeServerLibrary,
  scanServerLibrary,
  type ServerLibraryOptions,
  type ServerLibraryProbe,
  type ServerLibraryRoot,
} from "./music-folder/server-library.ts";
export { POLL_EVERY_MS, pollFolder, watchFolder, type FolderWatch } from "./music-folder/watch.ts";
export { createOriginalsSource, knownGridFromMeta, type OriginalsOptions } from "./originals.ts";
export { createRateLimiter, type RateLimiter } from "./rate-limiter.ts";
export { createStarterPackSource, type StarterPackOptions } from "./starter-pack.ts";
export type * from "./types.ts";
