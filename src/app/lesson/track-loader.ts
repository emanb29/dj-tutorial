// Finds the track a Lesson runs on: the composer's Originals first (exact grid and phrases), then a
// starter-pack house track (analysed in the background, cached), then the synthetic practice groove,
// which is always there. A Lesson never waits long: a slow analysis keeps running for next time.
// A Lesson that mixes two tracks (`partner`) gets a pair of Originals whose tempos fit its Check, or
// the two synthetic grooves; the starter pack is not analysed for a pair. Which Originals, and in what
// order, is track-rotation.ts: a different one each time, away from what this browser heard lately.
// With "Your music" on, the Learner's own tracks come first, when one fits the Lesson (own-music.ts).
import { analyseTrack, IndexedDbAnalysisCache } from "@analysis";
import {
  energySections,
  lessonTrackFromAnalysis,
  lessonTrackFromKnownGrid,
  SYNTHETIC_HOUSE,
  SYNTHETIC_PARTNER,
  synthesizeHouse,
  syntheticLessonTrack,
  type LessonDefinition,
  type LessonTrack,
  type SyntheticLayout,
} from "@lessons";
import { createOriginalsSource, createStarterPackSource, decoderAt, type MusicFolder, type Track } from "@tracks";
import { folderLibrary } from "../final-mix/library.ts";
import { pickOwnTracks, type OwnPick } from "./own-music.ts";
import { deckAOrder, localTrackHistory, partnerCandidates, type Random, type TrackHistoryStore } from "./track-rotation.ts";

export interface ReadyTrack {
  /** With `partner` set when the Lesson mixes two tracks. */
  readonly track: LessonTrack;
  readonly audio: AudioBuffer;
  /** Deck B's audio, when `track.partner` is set. */
  readonly partnerAudio?: AudioBuffer;
  /** The Learner's own music ("Your music"). */
  readonly own?: true;
  /** Why "Your music" was asked for but the app's tracks play, in one line. */
  readonly note?: string;
}

export type TrackPreference = "auto" | "synthetic";

export interface TrackLoadOptions {
  readonly preference: TrackPreference;
  readonly signal: AbortSignal;
  readonly onStatus: (status: string) => void;
  /** The engine's sample rate: every buffer is decoded or synthesised at it, or the deck refuses it. */
  readonly sampleRate: number;
  /** Recently heard tracks (default: this browser's localStorage). */
  readonly history?: TrackHistoryStore;
  /** Default `Math.random`; tests pass a seeded one. */
  readonly random?: Random;
  /** "Your music": try the Learner's music folder first. */
  readonly music?: MusicFolder | null;
}

/** How long a starter-pack download and analysis may take before the Lesson starts on the synthetic groove. */
export const STARTER_PACK_BUDGET_MS = 12_000;
/** How long "Your music" may take (a few decodes) before the Lesson uses the app's tracks. */
const OWN_MUSIC_BUDGET_MS = 20_000;
/** How long a just-opened page waits for the remembered music folder to list its tracks. */
const FOLDER_LIST_WAIT_MS = 3_000;
const ORIGINALS_TRIED = 3;
/** Partners tried for each deck A candidate. */
const PARTNERS_TRIED = 2;

const isHouse = (track: Track) => (track.genre ?? "").toLowerCase().includes("house");
const meta = (track: Track) => ({ id: `${track.source}:${track.id}`, title: track.title, artist: track.artist, attribution: track.attribution });

function synthetic(layout: SyntheticLayout, sampleRate: number): { track: LessonTrack; audio: AudioBuffer } {
  const samples = synthesizeHouse(layout, sampleRate);
  const audio = new AudioBuffer({ length: samples.length, numberOfChannels: 1, sampleRate });
  audio.copyToChannel(samples, 0);
  return { track: syntheticLessonTrack(layout), audio };
}

/** The synthetic groove, and for a two-track Lesson the second groove on deck B. */
function syntheticTrack(definition: LessonDefinition, sampleRate: number): ReadyTrack {
  const main = synthetic(SYNTHETIC_HOUSE, sampleRate);
  if (definition.partner === undefined) return main;
  const partner = synthetic(SYNTHETIC_PARTNER, sampleRate);
  return { track: { ...main.track, partner: partner.track }, audio: main.audio, partnerAudio: partner.audio };
}

async function fromOriginals(
  definition: LessonDefinition,
  signal: AbortSignal,
  sampleRate: number,
  history: TrackHistoryStore,
  random: Random,
): Promise<ReadyTrack | null> {
  const source = createOriginalsSource({ decode: decoderAt(sampleRate) });
  const listed = await source.list({ signal });
  if (!listed.ok) return null;
  const heard = history.read();
  const load = async (candidate: Track) => {
    const loaded = await source.load(candidate, { signal });
    if (!loaded.ok || loaded.value.knownGrid === undefined) return null;
    return { track: lessonTrackFromKnownGrid(meta(candidate), loaded.value.knownGrid), audio: loaded.value.audio };
  };
  for (const candidate of deckAOrder(listed.value, definition.id, heard, random).slice(0, ORIGINALS_TRIED)) {
    const main = await load(candidate);
    if (main === null || definition.trackProblems(main.track).length > 0) continue;
    const pairing = definition.partner;
    if (pairing === undefined) {
      history.heard(definition.id, [main.track.trackId]);
      return main;
    }
    for (const other of partnerCandidates(candidate, main.track.grid.bpm, listed.value, definition.id, heard, random).slice(0, PARTNERS_TRIED)) {
      const partner = await load(other);
      if (partner !== null && pairing.problems(main.track, partner.track).length === 0) {
        history.heard(definition.id, [main.track.trackId, partner.track.trackId]);
        return { track: { ...main.track, partner: partner.track }, audio: main.audio, partnerAudio: partner.audio };
      }
    }
  }
  return null;
}

async function fromStarterPack(
  definition: LessonDefinition,
  signal: AbortSignal,
  onStatus: (status: string) => void,
  sampleRate: number,
): Promise<ReadyTrack | null> {
  // Without named sections the phrases Lesson cannot ask for the breakdown; skip the download. A pair
  // would need two analyses: too slow for a Lesson that must start in seconds.
  if (definition.questions.length > 0 || definition.partner !== undefined) return null;
  const source = createStarterPackSource({ decode: decoderAt(sampleRate) });
  const listed = await source.list();
  const candidate = listed.ok ? listed.value.find(isHouse) : undefined;
  if (candidate === undefined) return null;
  onStatus(`Fetching "${candidate.title}"…`);
  const loaded = await source.load(candidate, { signal });
  if (!loaded.ok) return null;
  const { audio, contentHash } = loaded.value;
  onStatus(`Finding the beat in "${candidate.title}"…`);
  const channels = Array.from({ length: audio.numberOfChannels }, (_, channel) => audio.getChannelData(channel));
  const analysed = await analyseTrack({ channels, sampleRate: audio.sampleRate }, { cache: new IndexedDbAnalysisCache(), contentHash });
  if (!analysed.ok) return null;
  const track = lessonTrackFromAnalysis(meta(candidate), analysed.analysis);
  return track !== null && definition.trackProblems(track).length === 0 ? { track, audio } : null;
}

/** The folder's tracks, once a just-opened page has re-read the remembered folder (or the wait is over). */
function folderTracks(music: MusicFolder, signal: AbortSignal): Promise<readonly Track[]> {
  if (music.tracks().length > 0) return Promise.resolve(music.tracks());
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      unsubscribe();
      signal.removeEventListener("abort", done);
      resolve(music.tracks());
    };
    const timer = setTimeout(done, FOLDER_LIST_WAIT_MS);
    const unsubscribe = music.subscribe(() => {
      if (music.tracks().length > 0) done();
    });
    signal.addEventListener("abort", done);
  });
}

async function fromMusicFolder(definition: LessonDefinition, music: MusicFolder, options: TrackLoadOptions): Promise<OwnPick<AudioBuffer>> {
  const { signal, onStatus, sampleRate } = options;
  await folderTracks(music, signal);
  const items = folderLibrary(music, decoderAt(sampleRate)).items();
  const tracks = items.map((item) => ({
    key: item.key,
    bpm: item.bpm,
    prepare: async () => {
      const prepared = await item.prepare({ signal, onStatus, sampleRate });
      if (!prepared.ok) return null;
      const audio = await prepared.prepared.loadAudio(signal);
      const track = prepared.prepared.candidate.track;
      // The Learner's tracks have no named sections: quiet phrases are breakdowns, so a blend stays on the groove.
      const channels = Array.from({ length: audio.numberOfChannels }, (_, channel) => audio.getChannelData(channel));
      return { track: track.sections.length > 0 ? track : { ...track, sections: energySections(channels, audio.sampleRate, track.phraseStarts) }, audio };
    },
  }));
  return pickOwnTracks(definition, tracks, options.random ?? Math.random);
}

function within<Value>(promise: Promise<Value>, ms: number): Promise<Value | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(null);
    }, ms);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        console.warn("[lesson] a track source failed; trying the next one", error);
        resolve(null);
      },
    );
  });
}

export async function loadLessonTrack(definition: LessonDefinition, options: TrackLoadOptions): Promise<ReadyTrack> {
  if (options.music == null) return appTrack(definition, options);
  options.onStatus("Looking in your music…");
  const own = await within(fromMusicFolder(definition, options.music, options), OWN_MUSIC_BUDGET_MS);
  if (own?.ok === true) return { ...own.ready, own: true };
  const note = own === null ? "Your music took too long to load, so this run uses the app's tracks." : own.reason;
  return { ...(await appTrack(definition, options)), note };
}

/** The app's own tracks: an Original, the starter pack, or the synthetic groove. */
async function appTrack(definition: LessonDefinition, options: TrackLoadOptions): Promise<ReadyTrack> {
  if (options.preference === "synthetic") return syntheticTrack(definition, options.sampleRate);
  options.onStatus("Looking for a track…");
  const history = options.history ?? localTrackHistory();
  const original = await within(fromOriginals(definition, options.signal, options.sampleRate, history, options.random ?? Math.random), STARTER_PACK_BUDGET_MS);
  if (original !== null) return original;
  // The analysis is not aborted when the budget runs out: it finishes in the background and is cached.
  const starter = await within(fromStarterPack(definition, options.signal, options.onStatus, options.sampleRate), STARTER_PACK_BUDGET_MS);
  if (starter !== null) return starter;
  console.warn("[lesson] no Original or analysed starter-pack track was ready; using the synthetic practice groove");
  return syntheticTrack(definition, options.sampleRate);
}
