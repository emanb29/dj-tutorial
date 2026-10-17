// One Lesson on one engine, outside React (ADR 0001): sets the decks up for the hook, practice and the
// Check, turns engine commands into `Observation`s for the runtime, records the Check attempt with the
// AttemptRecorder and grades it. The pure runtime (src/lessons/runtime.ts) decides what happens next.
//
// The audio part of a Check ends (and the recorder stops) before any questions are asked, so the
// grading window and the end reason never include the time spent answering.
import { AttemptRecorder, type AudioEngine, type CommandEvent, type EngineCommand, type RecordedAttempt, type Result } from "@audio";
import { runCheck } from "@checks";
import {
  checkDecksFor,
  checkSpecFor,
  classifyTap,
  GAIN_ZONE_DB,
  practiceDecksFor,
  practiceLoopFor,
  sliceTrack,
  withPlannedGrids,
  type CheckPlan,
  type DeckSetup,
  type DeckSetups,
  type LessonDefinition,
  type LessonTrack,
  type LoopPlan,
  type Observation,
  type PositionCue,
} from "@lessons";
import type { DeckId, LessonId } from "@shared/attempt.ts";
import type { CheckResult, VoidAttempt } from "@shared/check-result.ts";

/** How often the session looks at the playhead to end the audio part or loop practice. */
const WATCH_MS = 25;
/** After a fade out, keep recording this long so the meters see the silence. */
const FADE_OUT_SETTLE_MS = 300;
const FADER_UP = 0.9;
const FADER_DOWN = 0.05;
/** Level readings for the gain-staging hook and practice: the peak over the last second, twice a second. */
const LEVEL_WINDOW_SEC = 1;
const LEVEL_EVERY_MS = 500;
/** Practice Ready: both decks' peaks this close count as matched (the Check's loud-match limit). */
const LEVEL_MATCH_DB = 1.5;
/** A cut on the phrase in practice: Play B within this of A's phrase start (the Lesson's ±120 ms). */
const CUT_TOLERANCE_MS = 120;
const DEVICE = { device: "keyboard" } as const;
const DECKS: readonly DeckId[] = ["A", "B"];

export type GradeOutcome =
  | { readonly ok: true; readonly outcome: CheckResult | VoidAttempt }
  | { readonly ok: false; readonly message: string };

export interface BeatClock {
  /** performance.now() milliseconds of the next beat heard. */
  readonly nextBeatAtMs: number;
  /** The next beat's index on the track's grid. */
  readonly nextBeat: number;
  readonly beatMs: number;
  /** 1–4. */
  readonly beatInBar: number;
}

interface RunningCheck {
  readonly plan: CheckPlan;
  readonly startedMs: number;
  /** Ready presses so far, per deck: heard time of the last one. */
  readonly readies: Map<DeckId, number>;
  readyCount: number;
  /** cue-point: the slice on deck A now (index into plan.slices), and whether its cue point is set. */
  slice: number;
  sliceCued: boolean;
  /** Set once the audio part ended: the recorder's stop, with the end reason. */
  stopped: Promise<Result<{ attempt: RecordedAttempt }>> | null;
}

export class LessonSession {
  private readonly recorder: AttemptRecorder;
  private readonly unsubscribe: () => void;
  private watch: ReturnType<typeof setInterval> | null = null;
  private readonly levelTimer: ReturnType<typeof setInterval>;
  private check: RunningCheck | null = null;
  /** The track on each deck now: the Lesson track, or a cue-point slice on A. */
  private readonly onDeck: Record<DeckId, LessonTrack | null>;
  /** The track id of the last load asked for on deck A (it wins in the engine). */
  private requestedA: string;
  private readonly peaks: Record<DeckId, { ctx: number; peak: number }[]> = { A: [], B: [] };
  private readonly lastLevel: Record<DeckId, number | null> = { A: null, B: null };
  private faderWasUp = false;
  /** Commands the session sends itself (set-up) are not the Learner's: no observations from them. */
  private settingUp = false;
  /** Bumped by every set-up, so a slow load that finishes late does not set up an old phase. */
  private generation = 0;
  private closed = false;

  constructor(
    private readonly engine: AudioEngine,
    private readonly definition: LessonDefinition,
    readonly track: LessonTrack,
    private readonly audio: AudioBuffer,
    private readonly learnerId: string,
    private readonly listener: {
      readonly observed: (observation: Observation) => void;
      readonly audioEnded: () => void;
      /** The Check could not start recording; it will not end or grade by itself. */
      readonly checkFailed: (message: string) => void;
    },
    hasDeckB: boolean,
  ) {
    this.recorder = new AttemptRecorder(engine);
    this.onDeck = { A: track, B: hasDeckB ? track : null };
    this.requestedA = track.trackId;
    const stops = [
      engine.on("command", (event) => {
        this.onCommand(event);
      }),
      engine.on("cue-point", (cue) => {
        this.onCuePoint(cue.deck, cue.pos);
      }),
      engine.on("meter", (frame) => {
        if (frame.bus === "A" || frame.bus === "B") this.peaks[frame.bus].push({ ctx: frame.ctx, peak: frame.samplePeakDb });
      }),
    ];
    this.unsubscribe = () => {
      for (const stop of stops) stop();
    };
    this.levelTimer = setInterval(() => {
      this.readLevels();
    }, LEVEL_EVERY_MS);
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  /** Whether a Lesson plays a track on deck B too (gain-staging, headphone-cue, cut-on-phrase). */
  static usesDeckB(definition: LessonDefinition, track: LessonTrack): boolean {
    return practiceDecksFor(definition, track).B !== undefined || definition.planCheck(track).deckB !== undefined;
  }

  /** The track on a deck now (a cue-point slice on A during that Check). */
  deckTrack(deck: DeckId): LessonTrack | null {
    return this.onDeck[deck];
  }

  private readonly onVisibility = () => {
    if (document.visibilityState === "hidden") this.recorder.markTabHidden();
  };

  private observe(observation: Observation): void {
    if (!this.settingUp) this.listener.observed(observation);
  }

  private onCommand(event: CommandEvent): void {
    if (event.rejected !== null || event.device === "engine" || this.settingUp) return;
    const { command } = event;
    switch (command.control) {
      case "play":
      case "pause":
        this.observe({ kind: "play", deck: command.deck, playing: this.engine.deckState(command.deck).playing });
        if (command.control === "play" && command.deck === "B") this.onPlayB(event.heardCtx);
        return;
      case "channel-fader":
        this.onFader(command.deck, command.value);
        return;
      case "headphone-cue":
        this.observe({ kind: "headphone-cue", deck: command.deck, on: command.value });
        return;
      case "trim":
        this.observe({ kind: "touch", control: `${command.deck}.trim` });
        return;
      case "jog-search":
      case "jog-bend":
        this.observe({ kind: "touch", control: `${command.deck}.jog` });
        return;
      case "cue-mix":
      case "headphone-level":
        this.observe({ kind: "touch", control: command.control });
        return;
      case "deck-cue":
        if (command.value && this.engine.deckState(command.deck).previewing) this.observe({ kind: "cue-preview", deck: command.deck });
        return;
      case "tap":
        this.onTap(event.heardCtx);
        return;
      default:
        return;
    }
  }

  private onFader(deck: DeckId, value: number): void {
    this.observe({ kind: "fader", deck, value });
    if (deck !== "A") return;
    if (value >= FADER_UP) this.faderWasUp = true;
    const check = this.check;
    if (check?.plan.endWhen.kind === "faded-out" && this.faderWasUp && value <= FADER_DOWN) {
      setTimeout(() => {
        // Only the attempt that faded out: a restart within the settle time is a new attempt.
        if (this.check === check) this.endAudio();
      }, FADE_OUT_SETTLE_MS);
    }
  }

  private onTap(heardCtx: number | null): void {
    const deck = this.definition.tapDeck ?? "A";
    const track = this.onDeck[deck];
    if (heardCtx === null || track === null || !this.engine.deckState(deck).playing) return;
    const reading = this.engine.playheadAt(deck, heardCtx);
    if (reading !== null) this.observe(classifyTap(track.grid, track.phraseStarts, reading.positionSec));
  }

  /** B started while A plays: a cut, placed against A's nearest phrase start. */
  private onPlayB(heardCtx: number | null): void {
    const track = this.onDeck.A;
    if (heardCtx === null || track === null || !this.engine.deckState("A").playing) return;
    const reading = this.engine.playheadAt("A", heardCtx);
    if (reading === null || track.phraseStarts.length === 0) return;
    const nearest = track.phraseStarts.reduce((best, start) => (Math.abs(start - reading.positionSec) < Math.abs(best - reading.positionSec) ? start : best));
    const offsetMs = Math.round((reading.positionSec - nearest) * 1000);
    this.observe({ kind: "cut", offsetMs, onPhrase: Math.abs(offsetMs) <= CUT_TOLERANCE_MS });
  }

  private onCuePoint(deck: DeckId, pos: number): void {
    const track = this.onDeck[deck];
    if (track === null || this.settingUp) return;
    const tap = classifyTap(track.grid, [], pos);
    const beat = 60 / track.grid.bpm;
    const nearest = Math.round((pos - track.grid.firstBeat) / beat);
    const onDownbeat = (((nearest - track.grid.downbeatIndex) % 4) + 4) % 4 === 0;
    this.observe({ kind: "cue-set", deck, offsetMs: tap.offsetMs, onDownbeat });
    if (this.check !== null && deck === "A") this.check.sliceCued = true;
  }

  /** The peak of each playing deck over the last second, for the gain-staging hook and practice. */
  private readLevels(): void {
    const heard = this.engine.heardTime();
    if (!heard.ok) return;
    for (const deck of DECKS) {
      const recent = this.peaks[deck].filter((frame) => frame.ctx > heard.ctx - LEVEL_WINDOW_SEC);
      this.peaks[deck] = recent;
      if (recent.length === 0 || !this.engine.deckState(deck).playing) {
        this.lastLevel[deck] = null;
        continue;
      }
      const peakDb = recent.reduce((highest, frame) => Math.max(highest, frame.peak), Number.NEGATIVE_INFINITY);
      this.lastLevel[deck] = peakDb;
      this.observe({ kind: "level", deck, peakDb });
    }
  }

  private send(command: EngineCommand): Result {
    const result = this.engine.command(command, DEVICE);
    if (!result.ok) console.warn("[lesson] the engine refused a set-up command", command, result.error);
    return result;
  }

  /** Sends set-up commands without observing them as the Learner's. */
  private settingUpWith(run: () => void): void {
    this.settingUp = true;
    try {
      run();
    } finally {
      this.settingUp = false;
    }
  }

  private stopWatching(): void {
    if (this.watch !== null) clearInterval(this.watch);
    this.watch = null;
  }

  /** Cues a deck as `setup` says, paused; Play is the caller's (after the recorder starts, in a Check). */
  private cueDeck(deck: DeckId, setup: DeckSetup): void {
    this.send({ control: "pause", deck });
    this.send({ control: "seek", deck, value: setup.pos });
    this.send({ control: "channel-fader", deck, value: setup.fader });
    if (setup.trim !== undefined) this.send({ control: "trim", deck, value: setup.trim });
    if (setup.headphoneCue !== undefined) this.send({ control: "headphone-cue", deck, value: setup.headphoneCue });
    if (setup.cuePoint === true && this.engine.deckState(deck).cuePointSec !== setup.pos) {
      this.send({ control: "deck-cue", deck, value: true });
      this.send({ control: "deck-cue", deck, value: false });
    }
  }

  private cueDecks(decks: DeckSetups): void {
    this.settingUpWith(() => {
      this.cueDeck("A", decks.A);
      if (decks.B !== undefined && this.onDeck.B !== null) this.cueDeck("B", decks.B);
    });
  }

  private playDecks(decks: DeckSetups): void {
    this.settingUpWith(() => {
      for (const deck of DECKS) {
        const setup = deck === "A" ? decks.A : decks.B;
        if (setup?.play === true && this.onDeck[deck] !== null) this.send({ control: "play", deck });
      }
    });
  }

  /** Loops back: positions only (knobs and faders stay), or the whole set-up. */
  private loopBack(decks: DeckSetups, loop: LoopPlan): void {
    if (loop.reset === "setup") {
      this.cueDecks(decks);
      this.playDecks(decks);
      return;
    }
    this.settingUpWith(() => {
      for (const deck of DECKS) {
        const setup = deck === "A" ? decks.A : decks.B;
        if (setup !== undefined && this.onDeck[deck] !== null) this.send({ control: "seek", deck, value: setup.pos });
      }
    });
  }

  private watchLoop(decks: DeckSetups, loop: LoopPlan | null, alsoEvery?: () => void): void {
    this.watch = setInterval(() => {
      const reading = this.engine.playhead("A");
      if (loop !== null && reading.ok && reading.positionSec >= loop.atPos) this.loopBack(decks, loop);
      alsoEvery?.();
    }, WATCH_MS);
  }

  /** Puts the Lesson track back on deck A after a cue-point Check left a slice there. */
  private async lessonTrackOnA(): Promise<boolean> {
    const onDeckNow = this.requestedA === this.track.trackId && this.onDeck.A?.trackId === this.track.trackId;
    return onDeckNow || this.loadOnA(this.track, this.audio);
  }

  /**
   * Loads a track on deck A. The engine keeps the last load asked for, so the session does too: a load
   * overtaken by a later one resolves false and never becomes `onDeck.A`.
   */
  private async loadOnA(track: LessonTrack, audio: AudioBuffer): Promise<boolean> {
    this.requestedA = track.trackId;
    const loaded = await this.engine.load("A", audio, { trackId: track.trackId, grid: track.grid });
    if (this.requestedA !== track.trackId || this.closed) return false;
    if (!loaded.ok) {
      console.warn(`[lesson] deck A refused ${track.trackId}`, loaded.error);
      return false;
    }
    this.onDeck.A = track;
    return true;
  }

  /** Hook and practice: the Lesson's practice set-up, looping where the Lesson loops. */
  preparePractice(): void {
    this.abandonCheck();
    const generation = ++this.generation;
    void this.lessonTrackOnA().then((ready) => {
      if (!ready || generation !== this.generation || this.closed) return;
      const decks = practiceDecksFor(this.definition, this.track);
      this.cueDecks(decks);
      this.playDecks(decks);
      this.watchLoop(decks, practiceLoopFor(this.definition, this.track));
    });
  }

  /** Starts (or restarts) the Check's audio part: auto-jump, record, and watch for its end. */
  startCheck(): void {
    this.abandonCheck();
    const generation = ++this.generation;
    const plan = this.definition.planCheck(this.track);
    void this.checkTracksReady(plan).then((ready) => {
      if (generation !== this.generation || this.closed) return;
      if (!ready) {
        this.listener.checkFailed("The deck could not load the Check's track. Try again with Enter.");
        return;
      }
      this.beginCheck(plan);
    });
  }

  private async checkTracksReady(plan: CheckPlan): Promise<boolean> {
    const first = plan.slices?.[0];
    return first === undefined ? this.lessonTrackOnA() : this.loadSlice(plan, 0);
  }

  private async loadSlice(plan: CheckPlan, index: number): Promise<boolean> {
    const slice = plan.slices?.[index];
    if (slice === undefined) return false;
    const track = sliceTrack(this.track, slice, index);
    if (!(await this.loadOnA(track, sliceAudio(this.audio, slice.fromSec, slice.lengthSec)))) return false;
    const setup = checkDecksFor(plan).A;
    this.settingUpWith(() => {
      this.send({ control: "channel-fader", deck: "A", value: setup.fader });
      if (setup.headphoneCue !== undefined) this.send({ control: "headphone-cue", deck: "A", value: setup.headphoneCue });
    });
    return true;
  }

  private beginCheck(plan: CheckPlan): void {
    const decks = checkDecksFor(plan);
    if (plan.slices === undefined) this.cueDecks(decks);
    const started = this.recorder.start({ expectedDurationSec: plan.timeoutSec + 30, allowTrackChanges: plan.slices !== undefined });
    if (!started.ok) {
      console.warn("[lesson] the recorder did not start", started.error);
      this.listener.checkFailed(`The attempt could not be recorded (${started.error.kind}). Try again with Enter.`);
      return;
    }
    const check: RunningCheck = { plan, startedMs: performance.now(), readies: new Map(), readyCount: 0, slice: 0, sliceCued: false, stopped: null };
    this.check = check;
    this.faderWasUp = false;
    this.playDecks(decks);
    this.watchLoop(decks, plan.loop ?? null, () => {
      if (this.ended(check)) this.endAudio();
    });
  }

  private ended(check: RunningCheck): boolean {
    const { plan } = check;
    const elapsedMs = performance.now() - check.startedMs;
    if (elapsedMs > plan.timeoutSec * 1000) return true;
    const end = plan.endWhen;
    switch (end.kind) {
      case "faded-out":
      case "slices-done":
        return false;
      case "after":
        return elapsedMs >= end.sec * 1000;
      case "position": {
        const reading = this.engine.playhead("A");
        return reading.ok && reading.positionSec >= end.pos;
      }
      case "ready-windows": {
        const heard = this.engine.heardTime();
        const barSec = (4 * 60) / this.track.grid.bpm;
        return heard.ok && end.decks.every((deck) => {
          const at = check.readies.get(deck);
          return at !== undefined && heard.ctx >= at + end.bars * barSec;
        });
      }
    }
  }

  /**
   * R: "this is set". In gain-staging's Check it marks the next deck Ready; in cue-point's it locks in
   * this slice's cue point and moves on; in practice it scores the levels.
   */
  ready(): void {
    const check = this.check;
    // No Check, or its audio part is over.
    if (check?.stopped !== null) {
      if (this.definition.practice.rep === "ready") this.observe({ kind: "ready", inZone: this.levelsInZone() });
      return;
    }
    const end = check.plan.endWhen;
    if (end.kind === "ready-windows") {
      // Each deck is Ready once; a stray press after that must not restart a hold window.
      const deck = end.decks.find((candidate) => !check.readies.has(candidate));
      const heard = this.engine.heardTime();
      if (deck === undefined || !heard.ok) return;
      this.engine.command({ control: "ready", deck }, DEVICE);
      check.readies.set(deck, heard.ctx);
      check.readyCount += 1;
      return;
    }
    if (end.kind === "slices-done") {
      if (!check.sliceCued) return;
      this.engine.command({ control: "ready", deck: "A" }, DEVICE);
      check.readyCount += 1;
      const next = check.slice + 1;
      if (next >= (check.plan.slices?.length ?? 0)) {
        this.endAudio();
        return;
      }
      check.slice = next;
      check.sliceCued = false;
      void this.loadSlice(check.plan, next).then((loaded) => {
        if (!loaded && this.check === check) this.endAudio();
      });
    }
  }

  private levelsInZone(): boolean {
    const decks = DECKS.filter((deck) => this.onDeck[deck] !== null);
    const levels = decks.map((deck) => this.lastLevel[deck]);
    if (levels.some((level) => level === null)) return false;
    const known = levels.filter((level) => level !== null);
    const [low, high] = GAIN_ZONE_DB;
    const inZone = known.every((level) => level >= low && level < high);
    return inZone && Math.max(...known) - Math.min(...known) <= LEVEL_MATCH_DB;
  }

  private endAudio(): void {
    const check = this.check;
    if (check?.stopped !== null) return;
    this.stopWatching();
    this.settingUpWith(() => {
      for (const deck of DECKS) if (this.onDeck[deck] !== null) this.send({ control: "pause", deck });
    });
    const timedOut = performance.now() - check.startedMs > check.plan.timeoutSec * 1000;
    // The attempt ends with its audio: answering questions afterwards is not part of it.
    check.stopped = this.recorder.stop({
      attemptId: crypto.randomUUID(),
      learnerId: this.learnerId,
      endReason: timedOut ? "timeout" : "done",
      abandoned: false,
      phraseMarkers: { [this.track.trackId]: this.track.phraseStarts },
      answers: {},
    });
    this.listener.audioEnded();
  }

  /** The live caption for the stretch of the Check the deck is in now. */
  checkCue(): PositionCue | null {
    const check = this.check;
    if (check === null) return null;
    const readyCues = check.plan.readyCues;
    if (readyCues !== undefined) {
      const caption = readyCues[Math.min(check.readyCount, readyCues.length - 1)];
      return caption === undefined ? null : { fromPos: 0, caption };
    }
    const reading = this.engine.playhead("A");
    if (!reading.ok) return null;
    return check.plan.cues.findLast((cue) => cue.fromPos <= reading.positionSec) ?? null;
  }

  /** Where the next beat falls on the tap deck, for the beat pulse on screen. Null while it is stopped. */
  beatClock(): BeatClock | null {
    const deck = this.definition.tapDeck ?? "A";
    const track = this.onDeck[deck];
    const reading = this.engine.playhead(deck);
    const state = this.engine.deckState(deck);
    if (track === null || !reading.ok || reading.beat === null || !state.playing) return null;
    const rate = state.tempoRate * (1 + state.jogBend);
    const beatMs = 60_000 / (track.grid.bpm * rate);
    const nextBeat = Math.ceil(reading.beat);
    const fromDownbeat = nextBeat - track.grid.downbeatIndex;
    return {
      nextBeatAtMs: performance.now() + (nextBeat - reading.beat) * beatMs,
      nextBeat,
      beatMs,
      beatInBar: (((fromDownbeat % 4) + 4) % 4) + 1,
    };
  }

  /** Grades the attempt whose audio part ended, with the Learner's answers. */
  async grade(answers: Readonly<Record<string, number>>, passedLessons: readonly LessonId[]): Promise<GradeOutcome> {
    const check = this.check;
    if (check === null) return { ok: false, message: "No Check was running to grade. Start it again with Enter." };
    if (check.stopped === null) this.endAudio();
    this.check = null;
    this.stopWatching();
    // endAudio has always set it by now.
    const stopped = await (check.stopped ?? Promise.resolve(null));
    if (stopped === null) return { ok: false, message: "The attempt was not stopped. Try again with Enter." };
    if (!stopped.ok) {
      return { ok: false, message: `The attempt could not be recorded (${stopped.error.kind}). Try again with Enter.` };
    }
    // Slices the Check never reached still have their grid: a cue point missing there fails, not voids.
    const attempt: RecordedAttempt = withPlannedGrids({ ...stopped.attempt, answers }, this.track, check.plan);
    return { ok: true, outcome: this.gradeAttempt(check.plan, attempt, passedLessons) };
  }

  private gradeAttempt(plan: CheckPlan, attempt: RecordedAttempt, passedLessons: readonly LessonId[]): CheckResult | VoidAttempt {
    if (attempt.degraded) console.warn("[lesson] the recorder dropped some continuous moves; grading what it kept");
    const spec = checkSpecFor(this.definition, this.track, plan, attempt, {
      window: { from: attempt.startedCtx, to: attempt.endedCtx },
      passedLessons,
    });
    return runCheck(spec, attempt);
  }

  /** Leaves a running Check without grading it (restart, leaving the page). */
  abandonCheck(): void {
    this.stopWatching();
    const check = this.check;
    if (check === null) return;
    this.check = null;
    if (check.stopped !== null) return;
    void this.recorder.stop({
      attemptId: crypto.randomUUID(),
      learnerId: this.learnerId,
      endReason: "done",
      abandoned: true,
      phraseMarkers: {},
      answers: {},
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abandonCheck();
    clearInterval(this.levelTimer);
    this.unsubscribe();
    document.removeEventListener("visibilitychange", this.onVisibility);
  }
}

/** A copy of `lengthSec` of the audio from `fromSec`, at the audio's own (the engine's) sample rate. */
function sliceAudio(audio: AudioBuffer, fromSec: number, lengthSec: number): AudioBuffer {
  const from = Math.max(0, Math.round(fromSec * audio.sampleRate));
  const length = Math.max(1, Math.min(audio.length - from, Math.round(lengthSec * audio.sampleRate)));
  const slice = new AudioBuffer({ length, numberOfChannels: audio.numberOfChannels, sampleRate: audio.sampleRate });
  for (let channel = 0; channel < audio.numberOfChannels; channel++) slice.copyToChannel(audio.getChannelData(channel).subarray(from, from + length), channel);
  return slice;
}
