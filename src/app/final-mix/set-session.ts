// One set on one engine, outside React (ADR 0001): the warm-up on the first two tracks, then the set
// itself, recorded twice: the attempt (AttemptRecorder, with track changes allowed) for the Check, and
// the master (AudioEngine.recordMaster) for the final project. The next track goes onto whichever
// deck is free; the set ends with "End set" or after SET_RULES.maxSetSec.
import { AttemptRecorder, describeError, type AudioEngine, type EngineCommand, type FinishedRecording, type MasterRecording, type RecordedAttempt } from "@audio";
import { finalMixTransitions, runCheck, type TransitionReport } from "@checks";
import { finalMixSpec, peakDbfsOf, preparedTrack, SET_RULES, setUpTrim, type PlayedTrack, type SetEntry } from "@lessons";
import type { CheckMode, DeckId, LessonId } from "@shared/attempt.ts";
import type { CheckResult, VoidAttempt } from "@shared/check-result.ts";
import { MAX_FINAL_PROJECT_BYTES } from "@shared/learner.ts";
import type { PreparedTrack } from "./library.ts";

const SETUP = { device: "keyboard" } as const;
/** A channel fader at or below this counts as closed: the deck is off the master. */
const FADER_CLOSED = 0.05;
const WATCH_MS = 250;

export interface SetTrackInfo {
  readonly entry: SetEntry;
  readonly prepared: PreparedTrack;
}

export interface GradedSet {
  readonly outcome: CheckResult | VoidAttempt;
  readonly transitions: readonly TransitionReport[];
  readonly played: readonly PlayedTrack[];
  /** Null when the browser could not record (the Check still grades). */
  readonly recording: FinishedRecording | null;
  readonly recordingProblem: string | null;
  readonly attempt: RecordedAttempt;
}

export type SetStatus =
  | { readonly kind: "warm-up" }
  | { readonly kind: "running"; readonly startedMs: number }
  | { readonly kind: "ended" };

export class SetSession {
  private readonly recorder: AttemptRecorder;
  private master: MasterRecording | null = null;
  private masterProblem: string | null = null;
  /** The tracks in play order, with the deck each went onto. */
  private readonly played: PlayedTrack[] = [];
  private nextIndex = 0;
  private loading = false;
  private status: SetStatus = { kind: "warm-up" };
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly engine: AudioEngine,
    private readonly tracks: readonly SetTrackInfo[],
    private readonly learnerId: string,
    private readonly onTimeout: () => void,
  ) {
    this.recorder = new AttemptRecorder(engine);
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  private readonly onVisibility = () => {
    if (document.visibilityState === "hidden") this.recorder.markTabHidden();
  };

  /** Re-renders the UI when the set's state changes (loads, start, end). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  private send(command: EngineCommand): void {
    const result = this.engine.command(command, SETUP);
    if (!result.ok) console.warn("[set] the engine refused a set-up command", command, describeError(result.error));
  }

  current(): SetStatus {
    return this.status;
  }

  /** The tracks played so far (loaded onto a deck), in order. */
  playedTracks(): readonly PlayedTrack[] {
    return this.played;
  }

  /** The set's next track, when one is left. */
  nextTrack(): SetTrackInfo | null {
    return this.tracks[this.nextIndex] ?? null;
  }

  /** The deck the next track goes onto: the one holding the older of the two tracks on the decks. */
  freeDeck(): DeckId {
    const latest = this.played.at(-1)?.deck ?? "B";
    return latest === "A" ? "B" : "A";
  }

  /** The free deck is off the master: paused, or its channel fader closed. Loading stops it. */
  canLoadNext(): boolean {
    if (this.loading || this.nextTrack() === null || this.status.kind !== "running") return false;
    const deck = this.freeDeck();
    const playing = this.engine.deckState(deck).playing;
    return !playing || this.engine.mixerState().channels[deck]["channel-fader"] <= FADER_CLOSED;
  }

  isLoading(): boolean {
    return this.loading;
  }

  private async loadOn(deck: DeckId, track: SetTrackInfo, signal: AbortSignal): Promise<void> {
    const audio = await track.prepared.loadAudio(signal);
    const prepared = preparedTrack(track.entry);
    const loaded = await this.engine.load(deck, audio, { trackId: prepared.trackId, grid: prepared.grid });
    if (!loaded.ok) throw new Error(`deck ${deck} refused "${prepared.title}": ${describeError(loaded.error)}`);
    // The set-up level, as every Lesson's: TRIM brings the track's peak down to SET_UP_PEAK_DB, so a set never starts in the red.
    const peakDbfs = peakDbfsOf(Array.from({ length: audio.numberOfChannels }, (_, channel) => audio.getChannelData(channel)));
    this.send({ control: "trim", deck, value: setUpTrim({ ...prepared, peakDbfs }) });
    this.played.push({ entry: track.entry, deck });
  }

  /** The warm-up: track 1 on A (fader up), track 2 on B (fader down). Nothing is recorded yet. */
  async warmUp(signal: AbortSignal): Promise<void> {
    const [first, second] = this.tracks;
    if (first === undefined || second === undefined) throw new Error("A set needs at least two tracks to start.");
    await this.loadOn("A", first, signal);
    await this.loadOn("B", second, signal);
    this.nextIndex = 2;
    this.send({ control: "channel-fader", deck: "A", value: 1 });
    this.send({ control: "channel-fader", deck: "B", value: 0 });
    this.changed();
  }

  /**
   * Starts the set: both decks paused at their cue points, A open and B closed, then the attempt and
   * the master recording. The cue (a seek, after the recorder starts) is the set's own start.
   */
  startSet(): { readonly ok: true } | { readonly ok: false; readonly message: string } {
    if (this.status.kind !== "warm-up") return { ok: false, message: "The set has already started." };
    for (const deck of ["A", "B"] as const) this.send({ control: "pause", deck });
    this.send({ control: "channel-fader", deck: "A", value: 1 });
    this.send({ control: "channel-fader", deck: "B", value: 0 });
    const started = this.recorder.start({ expectedDurationSec: SET_RULES.maxSetSec + 60, allowTrackChanges: true });
    if (!started.ok) return { ok: false, message: `The set could not be recorded (${describeError(started.error)}).` };
    for (const deck of ["A", "B"] as const) this.send({ control: "seek", deck, value: this.engine.deckState(deck).cuePointSec });
    const master = this.engine.recordMaster(MAX_FINAL_PROJECT_BYTES);
    if (master.ok) this.master = master.recording;
    else {
      this.masterProblem = describeError(master.error);
      console.warn("[set] the master is not recorded", this.masterProblem);
    }
    const startedMs = performance.now();
    this.status = { kind: "running", startedMs };
    this.timer = setInterval(() => {
      if (performance.now() - startedMs > SET_RULES.maxSetSec * 1000) this.onTimeout();
    }, WATCH_MS);
    this.changed();
    return { ok: true };
  }

  /** Loads the set's next track onto the free deck, paused at its start, channel fader closed. */
  async loadNext(signal: AbortSignal): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
    const next = this.nextTrack();
    if (next === null || !this.canLoadNext()) return { ok: false, message: "The free deck is still on the master: pull its fader down first." };
    const deck = this.freeDeck();
    this.loading = true;
    this.changed();
    try {
      this.send({ control: "channel-fader", deck, value: 0 });
      await this.loadOn(deck, next, signal);
      this.nextIndex += 1;
      return { ok: true };
    } catch (error) {
      return { ok: false, message: `The next track could not load: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
      this.loading = false;
      this.changed();
    }
  }

  /** Ends the set and grades it. */
  async end(options: { readonly passedLessons: readonly LessonId[]; readonly mode: CheckMode; readonly timedOut: boolean }): Promise<GradedSet | { readonly error: string }> {
    if (this.status.kind !== "running") return { error: "No set is running." };
    this.status = { kind: "ended" };
    this.stopTimer();
    this.changed();
    const phraseMarkers = Object.fromEntries(this.played.map(({ entry }) => {
      const track = preparedTrack(entry);
      return [track.trackId, track.phraseStarts] as const;
    }));
    const stopped = await this.recorder.stop({
      attemptId: crypto.randomUUID(),
      learnerId: this.learnerId,
      endReason: options.timedOut ? "timeout" : "done",
      abandoned: false,
      phraseMarkers,
      answers: {},
    });
    const recording = this.master === null ? null : await this.master.stop();
    this.master = null;
    for (const deck of ["A", "B"] as const) this.send({ control: "pause", deck });
    if (!stopped.ok) return { error: `The set could not be recorded (${describeError(stopped.error)}). Play it again.` };
    const { attempt } = stopped;
    const spec = finalMixSpec(this.played, attempt, {
      startedCtx: attempt.startedCtx,
      endedCtx: attempt.endedCtx,
      passedLessons: options.passedLessons,
      mode: options.mode,
    });
    return {
      outcome: runCheck(spec, attempt),
      transitions: finalMixTransitions(spec, attempt),
      played: [...this.played],
      recording,
      recordingProblem: this.masterProblem,
      attempt,
    };
  }

  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopTimer();
    document.removeEventListener("visibilitychange", this.onVisibility);
    if (this.recorder.isRecording()) {
      void this.recorder.stop({ attemptId: crypto.randomUUID(), learnerId: this.learnerId, endReason: "done", abandoned: true, phraseMarkers: {}, answers: {} });
    }
    void this.master?.stop();
  }
}
