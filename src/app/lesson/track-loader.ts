// Finds the track a Lesson runs on: the composer's Originals first (exact grid and phrases), then a
// starter-pack house track (analysed in the background, cached), then the synthetic practice groove,
// which is always there. A Lesson never waits long: a slow analysis keeps running for next time.
import { analyseTrack, IndexedDbAnalysisCache } from "@analysis";
import {
  lessonTrackFromAnalysis,
  lessonTrackFromKnownGrid,
  SYNTHETIC_HOUSE,
  synthesizeHouse,
  syntheticLessonTrack,
  type LessonDefinition,
  type LessonTrack,
} from "@lessons";
import { createOriginalsSource, createStarterPackSource, decoderAt, type Track } from "@tracks";

export interface ReadyTrack {
  readonly track: LessonTrack;
  readonly audio: AudioBuffer;
}

export type TrackPreference = "auto" | "synthetic";

export interface TrackLoadOptions {
  readonly preference: TrackPreference;
  readonly signal: AbortSignal;
  readonly onStatus: (status: string) => void;
  /** The engine's sample rate: every buffer is decoded or synthesised at it, or the deck refuses it. */
  readonly sampleRate: number;
}

/** How long a starter-pack download and analysis may take before the Lesson starts on the synthetic groove. */
export const STARTER_PACK_BUDGET_MS = 12_000;
const ORIGINALS_TRIED = 3;

const isHouse = (track: Track) => (track.genre ?? "").toLowerCase().includes("house");
const meta = (track: Track) => ({ id: `${track.source}:${track.id}`, title: track.title, attribution: track.attribution });

function syntheticTrack(sampleRate: number): ReadyTrack {
  const samples = synthesizeHouse(SYNTHETIC_HOUSE, sampleRate);
  const audio = new AudioBuffer({ length: samples.length, numberOfChannels: 1, sampleRate });
  audio.copyToChannel(samples, 0);
  return { track: syntheticLessonTrack(SYNTHETIC_HOUSE), audio };
}

async function fromOriginals(definition: LessonDefinition, signal: AbortSignal, sampleRate: number): Promise<ReadyTrack | null> {
  const source = createOriginalsSource({ decode: decoderAt(sampleRate) });
  const listed = await source.list({ signal });
  if (!listed.ok) return null;
  for (const candidate of listed.value.filter(isHouse).slice(0, ORIGINALS_TRIED)) {
    const loaded = await source.load(candidate, { signal });
    if (!loaded.ok || loaded.value.knownGrid === undefined) continue;
    const track = lessonTrackFromKnownGrid(meta(candidate), loaded.value.knownGrid);
    if (definition.trackProblems(track).length === 0) return { track, audio: loaded.value.audio };
  }
  return null;
}

async function fromStarterPack(
  definition: LessonDefinition,
  signal: AbortSignal,
  onStatus: (status: string) => void,
  sampleRate: number,
): Promise<ReadyTrack | null> {
  // Without named sections the phrases Lesson cannot ask for the breakdown; skip the download.
  if (definition.questions.length > 0) return null;
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
  if (options.preference === "synthetic") return syntheticTrack(options.sampleRate);
  options.onStatus("Looking for a house track…");
  const original = await within(fromOriginals(definition, options.signal, options.sampleRate), STARTER_PACK_BUDGET_MS);
  if (original !== null) return original;
  // The analysis is not aborted when the budget runs out: it finishes in the background and is cached.
  const starter = await within(fromStarterPack(definition, options.signal, options.onStatus, options.sampleRate), STARTER_PACK_BUDGET_MS);
  if (starter !== null) return starter;
  console.warn("[lesson] no Original or analysed starter-pack track was ready; using the synthetic practice groove");
  return syntheticTrack(options.sampleRate);
}
