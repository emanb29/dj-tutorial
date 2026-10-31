// Freestyle: both decks and every control, no Lesson and no grading, like a small rekordbox. The
// Learner loads any library track onto either deck; nothing is recorded or kept. One session per
// visit, on one engine, outside React (ADR 0001).
import { describeError, type AudioEngine, type EngineCommand } from "@audio";
import { peakDbfsOf, setUpTrim, type LessonTrack } from "@lessons";
import type { DeckId } from "@shared/attempt.ts";
import type { PreparedTrack } from "../final-mix/library.ts";

const SETUP = { device: "keyboard" } as const;

export interface FreestyleOptions {
  /**
   * Whether a hardware controller is connected now. While one is, the session never turns a knob in
   * software (the hardware is the source of truth), so a new track keeps the TRIM the hardware has.
   */
  readonly hardwareConnected: () => boolean;
}

export type LoadOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string };

export class FreestyleSession {
  private readonly onDeck: Record<DeckId, LessonTrack | null> = { A: null, B: null };
  private readonly loading: Record<DeckId, boolean> = { A: false, B: false };
  private readonly listeners = new Set<() => void>();
  private version = 0;

  constructor(
    private readonly engine: AudioEngine,
    private readonly options: FreestyleOptions,
  ) {}

  /** Re-renders the UI when a deck starts or finishes loading. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Changes whenever what the decks hold changes (for useSyncExternalStore). */
  snapshot = (): number => this.version;

  private changed(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  track(deck: DeckId): LessonTrack | null {
    return this.onDeck[deck];
  }

  isLoading(deck: DeckId): boolean {
    return this.loading[deck];
  }

  /** Why `deck` cannot take a new track now, or null when it can. As on a CDJ, a playing deck can't. */
  loadBlocker(deck: DeckId): string | null {
    if (this.loading[deck]) return `Deck ${deck} is loading`;
    if (this.engine.deckState(deck).playing) return `Pause deck ${deck} first`;
    return null;
  }

  private send(command: EngineCommand): void {
    const result = this.engine.command(command, SETUP);
    if (!result.ok) console.warn("[freestyle] the engine refused a load command", command, describeError(result.error));
  }

  /**
   * Loads `prepared` onto `deck`, paused on its bar 1 with the cue point there (auto cue, as DJ
   * software loads a track). Without a controller, TRIM is set so the track starts out of the red.
   */
  async load(deck: DeckId, prepared: PreparedTrack, signal: AbortSignal): Promise<LoadOutcome> {
    const blocker = this.loadBlocker(deck);
    if (blocker !== null) return { ok: false, message: blocker };
    this.loading[deck] = true;
    this.changed();
    try {
      const audio = await prepared.loadAudio(signal);
      const { track } = prepared.candidate;
      const loaded = await this.engine.load(deck, audio, { trackId: track.trackId, grid: track.grid });
      if (!loaded.ok) return { ok: false, message: `Deck ${deck} could not load "${track.title}": ${describeError(loaded.error)}` };
      if (!this.options.hardwareConnected()) {
        const peakDbfs = peakDbfsOf(Array.from({ length: audio.numberOfChannels }, (_, channel) => audio.getChannelData(channel)));
        this.send({ control: "trim", deck, value: setUpTrim({ ...track, peakDbfs }) });
      }
      const barOne = track.phraseStarts[0];
      if (barOne !== undefined && barOne > 0) {
        this.send({ control: "seek", deck, value: barOne });
        this.send({ control: "deck-cue", deck, value: true });
        this.send({ control: "deck-cue", deck, value: false });
      }
      // The hot cues the Learner set in rekordbox, on the same pads (A = pad 1). A load clears the pads.
      for (const cue of prepared.hotCues ?? []) this.send({ control: "hot-cue-set", deck, slot: cue.slot, pos: cue.sec });
      this.onDeck[deck] = track;
      return { ok: true };
    } catch (error) {
      return { ok: false, message: `Deck ${deck} could not load the track: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
      this.loading[deck] = false;
      this.changed();
    }
  }
}
