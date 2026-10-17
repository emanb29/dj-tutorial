// One Lesson on one engine, outside React (ADR 0001): sets the deck up for the hook, practice and the
// Check, turns engine commands into `Observation`s for the runtime, records the Check attempt with the
// AttemptRecorder and grades it. The pure runtime (src/lessons/runtime.ts) decides what happens next.
import { AttemptRecorder, type AudioEngine, type CommandEvent, type RecordedAttempt } from "@audio";
import { runCheck } from "@checks";
import { checkSpecFor, classifyTap, type CheckPlan, type LessonDefinition, type LessonTrack, type Observation, type PositionCue } from "@lessons";
import type { LessonId } from "@shared/attempt.ts";
import type { CheckResult, VoidAttempt } from "@shared/check-result.ts";

/** How often the session looks at the playhead to end the audio part or loop practice. */
const WATCH_MS = 25;
/** After a fade out, keep recording this long so the meters see the silence. */
const FADE_OUT_SETTLE_MS = 300;
const FADER_UP = 0.9;
const FADER_DOWN = 0.05;
/** Practice loops over this many bars from the practice start. */
const PRACTICE_LOOP_BARS = { "beat-tap": 16, "phrase-tap": 24, fade: 0 } as const;
const DEVICE = { device: "keyboard" } as const;

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

export class LessonSession {
  private readonly recorder: AttemptRecorder;
  private readonly unsubscribe: () => void;
  private watch: ReturnType<typeof setInterval> | null = null;
  private plan: CheckPlan | null = null;
  private faderWasUp = false;
  private checkStartedMs = 0;
  private closed = false;

  constructor(
    private readonly engine: AudioEngine,
    private readonly definition: LessonDefinition,
    readonly track: LessonTrack,
    private readonly learnerId: string,
    private readonly listener: {
      readonly observed: (observation: Observation) => void;
      readonly audioEnded: () => void;
      /** The Check could not start recording; it will not end or grade by itself. */
      readonly checkFailed: (message: string) => void;
    },
  ) {
    this.recorder = new AttemptRecorder(engine);
    this.unsubscribe = engine.on("command", (event) => {
      this.onCommand(event);
    });
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  private readonly onVisibility = () => {
    if (document.visibilityState === "hidden") this.recorder.markTabHidden();
  };

  private onCommand(event: CommandEvent): void {
    if (event.rejected !== null || event.device === "engine") return;
    const { command } = event;
    if ((command.control === "play" || command.control === "pause") && command.deck === "A") {
      this.listener.observed({ kind: "play", playing: this.engine.deckState("A").playing });
    } else if (command.control === "channel-fader" && command.deck === "A") {
      if (command.value >= FADER_UP) this.faderWasUp = true;
      this.listener.observed({ kind: "fader", value: command.value });
      const plan = this.plan;
      if (plan?.endWhen.kind === "faded-out" && this.faderWasUp && command.value <= FADER_DOWN) {
        setTimeout(() => {
          // Only the attempt that faded out: a restart within the settle time is a new plan.
          if (this.plan === plan) this.endAudio();
        }, FADE_OUT_SETTLE_MS);
      }
    } else if (command.control === "tap" && event.heardCtx !== null) {
      const reading = this.engine.playheadAt("A", event.heardCtx);
      if (reading !== null && this.engine.deckState("A").playing) {
        this.listener.observed(classifyTap(this.track.grid, this.track.phraseStarts, reading.positionSec));
      }
    }
  }

  private send(command: Parameters<AudioEngine["command"]>[0]): void {
    const result = this.engine.command(command, DEVICE);
    if (!result.ok) console.warn("[lesson] the engine refused a set-up command", command, result.error);
  }

  private stopWatching(): void {
    if (this.watch !== null) clearInterval(this.watch);
    this.watch = null;
  }

  private cueTo(pos: number, fader: number, play: boolean): void {
    this.send({ control: "pause", deck: "A" });
    this.send({ control: "seek", deck: "A", value: pos });
    this.send({ control: "channel-fader", deck: "A", value: fader });
    if (play) this.send({ control: "play", deck: "A" });
  }

  /** Hook and practice: deck-basics waits, stopped and silent; tap Lessons play at once and loop. */
  preparePractice(): void {
    this.abandonCheck();
    const start = this.definition.practiceStart(this.track);
    const taps = this.definition.practice.rep !== "fade";
    this.cueTo(start, taps ? 1 : 0, taps);
    const loopBars = PRACTICE_LOOP_BARS[this.definition.practice.rep];
    if (loopBars === 0) return;
    const loopEnd = start + (loopBars * 4 * 60) / this.track.grid.bpm;
    this.watch = setInterval(() => {
      const reading = this.engine.playhead("A");
      if (reading.ok && reading.positionSec >= loopEnd) this.send({ control: "seek", deck: "A", value: start });
    }, WATCH_MS);
  }

  /** Starts (or restarts) the Check's audio part: auto-jump, record, and watch for its end. */
  startCheck(): void {
    this.abandonCheck();
    const plan = this.definition.planCheck(this.track);
    this.cueTo(plan.startPos, plan.faderAtStart, false);
    const started = this.recorder.start({ expectedDurationSec: plan.timeoutSec + 30 });
    if (!started.ok) {
      console.warn("[lesson] the recorder did not start", started.error);
      this.listener.checkFailed(`The attempt could not be recorded (${started.error.kind}). Try again with Enter.`);
      return;
    }
    this.plan = plan;
    this.faderWasUp = false;
    this.checkStartedMs = performance.now();
    if (plan.autoPlay) this.send({ control: "play", deck: "A" });
    this.watch = setInterval(() => {
      const reading = this.engine.playhead("A");
      const pastEnd = plan.endWhen.kind === "position" && reading.ok && reading.positionSec >= plan.endWhen.pos;
      if (pastEnd || performance.now() - this.checkStartedMs > plan.timeoutSec * 1000) this.endAudio();
    }, WATCH_MS);
  }

  private endAudio(): void {
    if (this.plan === null || this.watch === null) return;
    this.stopWatching();
    this.send({ control: "pause", deck: "A" });
    this.listener.audioEnded();
  }

  /** The live caption for the stretch of the Check the deck is in now. */
  checkCue(): PositionCue | null {
    const plan = this.plan;
    const reading = this.engine.playhead("A");
    if (plan === null || !reading.ok) return null;
    return plan.cues.findLast((cue) => cue.fromPos <= reading.positionSec) ?? null;
  }

  /** Where the next beat falls, for the beat pulse on screen. Null while the deck is stopped. */
  beatClock(): BeatClock | null {
    const reading = this.engine.playhead("A");
    const deck = this.engine.deckState("A");
    if (!reading.ok || reading.beat === null || !deck.playing) return null;
    const rate = deck.tempoRate * (1 + deck.jogBend);
    const beatMs = 60_000 / (this.track.grid.bpm * rate);
    const nextBeat = Math.ceil(reading.beat);
    const fromDownbeat = nextBeat - this.track.grid.downbeatIndex;
    return {
      nextBeatAtMs: performance.now() + (nextBeat - reading.beat) * beatMs,
      nextBeat,
      beatMs,
      beatInBar: (((fromDownbeat % 4) + 4) % 4) + 1,
    };
  }

  /** Stops recording and grades the attempt. */
  async grade(answers: Readonly<Record<string, number>>, passedLessons: readonly LessonId[]): Promise<GradeOutcome> {
    const plan = this.plan;
    this.plan = null;
    this.stopWatching();
    if (plan === null) return { ok: false, message: "No Check was running to grade. Start it again with Enter." };
    const stopped = await this.recorder.stop({
      attemptId: crypto.randomUUID(),
      learnerId: this.learnerId,
      endReason: performance.now() - this.checkStartedMs > plan.timeoutSec * 1000 ? "timeout" : "done",
      abandoned: false,
      phraseMarkers: { [this.track.trackId]: this.track.phraseStarts },
      answers,
    });
    if (!stopped.ok) return { ok: false, message: `The attempt could not be recorded (${stopped.error.kind}). Try again with Enter.` };
    return { ok: true, outcome: this.gradeAttempt(plan, stopped.attempt, passedLessons) };
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
    if (this.plan === null) return;
    this.plan = null;
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
    this.unsubscribe();
    document.removeEventListener("visibilitychange", this.onVisibility);
  }
}
