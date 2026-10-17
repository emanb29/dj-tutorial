// One Lesson, end to end: the controller fills the screen, one caption line sits above it, a compact
// strip gives live feedback, and the result card follows each Check. Hook → practice → Check → result
// → Check again is one loop driven by the pure runtime; Enter always goes (back) into the Check.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type RefObject } from "react";
import { createAudioEngine, describeError, MasterOnlyMonitor, SplitCueMonitor, type AudioEngine } from "@audio";
import { applyCheckResult, CUE_PLACEMENT_TOLERANCE_MS } from "@checks";
import {
  initialLessonState,
  lessonDefinition,
  lineFacts,

  peakDbfsOf,
  readyUsedIn,
  skipGroupsPassed,
  lessonReducer,
  unlocksAfter,
  type BuiltLessonId,
  type ControlId,
  type DeckId,
  type LessonPhase,
  type LessonTrack,
  type Observation,
} from "@lessons";
import type { LessonId } from "@shared/attempt.ts";
import type { CheckResult, VoidAttempt } from "@shared/check-result.ts";
import { withHeadphonesChecked, withSkillProfile, type LearnerRecord } from "@shared/learner.ts";
import { Controller } from "../controller/Controller.tsx";
import type { ControllerCaption } from "../controller/context.tsx";
import { inputWording, useWording } from "../controller/wording.ts";
import type { SaveStatus } from "../save-queue.ts";
import { FeedbackStrip, type TapMark } from "./FeedbackStrip.tsx";
import { needsHeadphonesCheck } from "./headphones-check.ts";
import { HeadphonesGate } from "./HeadphonesGate.tsx";
import { lessonKey } from "./lesson-keys.ts";
import { LessonSession } from "./lesson-session.ts";
import { ResultCard } from "./ResultCard.tsx";
import { loadLessonTrack, type TrackPreference } from "./track-loader.ts";
import "./lesson.css";
import "./lesson-extras.css";

export interface LessonHandle {
  readonly engine: AudioEngine;
  readonly track: LessonTrack;
  readonly phase: () => LessonPhase["kind"];
  /** The track on a deck now: the Lesson track, or a cue-point slice. */
  readonly deckTrack: (deck: DeckId) => LessonTrack | null;
}

declare global {
  interface Window {
    /** Set while a Lesson is open, like the playground's handle: lets end-to-end tests read the engine. */
    learnToDjLesson?: LessonHandle;
  }
}

export interface LessonPlayerProps {
  readonly lessonId: BuiltLessonId;
  readonly learner: LearnerRecord;
  /** A new record to keep and save (the App saves it, one save at a time). */
  readonly onLearnerChange: (record: LearnerRecord) => void;
  /** Whether the last save reached the server; a failure shows "not saved — retry". */
  readonly saveStatus: SaveStatus;
  readonly onRetrySave: () => void;
  /** A graded result completed a skip group: the app re-plans the Curriculum in the background. */
  readonly onSkipGroupPassed: (result: CheckResult) => void;
  readonly trackPreference: TrackPreference;
  readonly onExit: () => void;
  readonly onOpenLesson: (lessonId: BuiltLessonId) => void;
}

type Setup = { kind: "loading"; status: string } | { kind: "ready"; engine: AudioEngine; session: LessonSession } | { kind: "failed"; message: string };

const NO_CAPTIONS: readonly ControllerCaption[] = [];
const TAP_MARKS_KEPT = 12;

export function passedLessons(learner: LearnerRecord): LessonId[] {
  return Object.values(learner.skillProfile.lessons).flatMap((record) => (record.passedAt != null ? [record.lessonId] : []));
}

function isGraded(outcome: CheckResult | VoidAttempt): outcome is CheckResult {
  return outcome.outcome.kind !== "void";
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

function tapMark(observation: Observation): TapMark | null {
  if (observation.kind === "tap") return { offsetMs: observation.offsetMs, good: observation.onBeat };
  if (observation.kind === "cue-set") return { offsetMs: observation.offsetMs, good: observation.onDownbeat && Math.abs(observation.offsetMs) <= CUE_PLACEMENT_TOLERANCE_MS };
  return null;
}

export function LessonPlayer({ lessonId, learner, onLearnerChange, saveStatus, onRetrySave, onSkipGroupPassed, trackPreference, onExit, onOpenLesson }: LessonPlayerProps) {
  const definition = useMemo(() => lessonDefinition(lessonId), [lessonId]);
  // Asked once per Learner, before the first headphone-cue Lesson; read at mount only.
  const [headphonesGate, setHeadphonesGate] = useState(() => needsHeadphonesCheck(definition, learner));
  const reducer = useMemo(() => lessonReducer(definition), [definition]);
  const [state, dispatch] = useReducer(reducer, lessonId, initialLessonState);
  const [setup, setSetup] = useState<Setup>({ kind: "loading", status: "Getting the deck ready…" });
  const [audioRunning, setAudioRunning] = useState(true);
  const [taps, setTaps] = useState<readonly TapMark[]>([]);
  const learnerRef = useRef(learner);
  const phaseRef = useRef(state.phase);
  const cueLine = useRef<HTMLSpanElement>(null);
  const recentLines = useRef<string[]>([]);
  const marginsRef = useRef(state.margins);
  const { phase, margins } = state;
  const wording = useWording();
  useEffect(() => {
    learnerRef.current = learner;
    phaseRef.current = phase;
    marginsRef.current = margins;
  }, [learner, phase, margins]);

  // The engine, the track and the session, once per Lesson visit.
  useEffect(() => {
    const abort = new AbortController();
    // A function, not the flag itself: the flag changes across the awaits below.
    const cancelled = () => abort.signal.aborted;
    let engine: AudioEngine | null = null;
    let session: LessonSession | null = null;
    let engineClosed = false;
    // Once, from whichever comes last: the cleanup, or a set-up that finishes after the cleanup ran
    // (StrictMode's first run, or Esc while the track loads). Otherwise its AudioContext would leak.
    const closeEngine = () => {
      if (engine === null || engineClosed) return;
      engineClosed = true;
      engine.close().catch((error: unknown) => {
        console.warn("[lesson] the audio engine did not close cleanly", error);
      });
    };
    const observed = (observation: Observation) => {
      dispatch({ type: "observed", observation });
      const mark = tapMark(observation);
      if (mark !== null) setTaps((marks) => [...marks, mark].slice(-TAP_MARKS_KEPT));
    };
    void (async () => {
      try {
        // Headphone Lessons use split cue: cue in the left ear, master in the right.
        engine = await createAudioEngine({ masterTempo: false, monitor: definition.headphones === true ? new SplitCueMonitor() : new MasterOnlyMonitor() });
        const ready = await loadLessonTrack(definition, {
          preference: trackPreference,
          signal: abort.signal,
          sampleRate: engine.context.sampleRate,
          onStatus: (status) => {
            if (!abort.signal.aborted) setSetup({ kind: "loading", status });
          },
        });
        if (cancelled()) return;
        const channels = Array.from({ length: ready.audio.numberOfChannels }, (_, channel) => ready.audio.getChannelData(channel));
        const track: LessonTrack = { ...ready.track, peakDbfs: peakDbfsOf(channels) };
        const withDeckB = LessonSession.usesDeckB(definition, track);
        for (const deck of withDeckB ? (["A", "B"] as const) : (["A"] as const)) {
          const loaded = await engine.load(deck, ready.audio, { trackId: track.trackId, grid: track.grid });
          if (!loaded.ok) throw new Error(`deck ${deck} refused the track: ${describeError(loaded.error)}`);
        }
        if (cancelled()) return;
        const created = new LessonSession(
          engine,
          definition,
          track,
          ready.audio,
          learnerRef.current.learnerId,
          {
            observed,
            audioEnded: () => {
              dispatch({ type: "audio-ended" });
            },
            checkFailed: (message) => {
              dispatch({ type: "check-failed", message });
            },
          },
          withDeckB,
        );
        session = created;
        const running = engine;
        window.learnToDjLesson = { engine: running, track, phase: () => phaseRef.current.kind, deckTrack: (deck) => created.deckTrack(deck) };
        setSetup({ kind: "ready", engine: running, session: created });
      } catch (error) {
        if (abort.signal.aborted) return;
        const message = `The deck could not start: ${error instanceof Error ? error.message : String(error)}. Reload to try again.`;
        setSetup({ kind: "failed", message });
        dispatch({ type: "track-failed", message });
      } finally {
        if (cancelled()) closeEngine();
      }
    })();
    return () => {
      abort.abort();
      session?.close();
      delete window.learnToDjLesson;
      closeEngine();
    };
  }, [definition, trackPreference]);

  const engine = setup.kind === "ready" ? setup.engine : null;
  const session = setup.kind === "ready" ? setup.session : null;

  // The hook starts once the deck is ready and, for headphone Lessons, the headphones check passed.
  const deckReady = session !== null;
  useEffect(() => {
    if (deckReady && !headphonesGate) dispatch({ type: "track-ready" });
  }, [deckReady, headphonesGate]);
  const headphonesPassed = useCallback(() => {
    onLearnerChange(withHeadphonesChecked(learnerRef.current, new Date().toISOString()));
    setHeadphonesGate(false);
  }, [onLearnerChange]);

  // Browsers start audio only after a gesture; the click that opened the Lesson usually was one.
  useEffect(() => {
    const context = engine?.context;
    if (!(context instanceof AudioContext)) return;
    const sync = () => {
      setAudioRunning(context.state === "running");
    };
    const resume = () => {
      if (context.state !== "running") void context.resume();
    };
    resume();
    sync();
    context.addEventListener("statechange", sync);
    window.addEventListener("pointerdown", resume, { capture: true });
    window.addEventListener("keydown", resume, { capture: true });
    return () => {
      context.removeEventListener("statechange", sync);
      window.removeEventListener("pointerdown", resume, { capture: true });
      window.removeEventListener("keydown", resume, { capture: true });
    };
  }, [engine]);

  // Deck set-up follows the phase: practice cues the deck, each Check attempt auto-jumps and records.
  const inPractice = phase.kind === "hook" || phase.kind === "practice";
  const attempt = phase.kind === "check" ? phase.attempt : null;
  useEffect(() => {
    if (session !== null && inPractice) session.preparePractice();
  }, [session, inPractice]);
  useEffect(() => {
    if (session === null || attempt === null) return;
    setTaps([]);
    session.startCheck();
  }, [session, attempt]);

  // Grading: stop the recorder, run the Check, write the Skill profile, save it in the background.
  const grading = phase.kind === "grading" ? phase.answers : null;
  useEffect(() => {
    if (session === null || grading === null) return;
    let cancelled = false;
    const before = learnerRef.current;
    void session.grade(grading, passedLessons(before)).then((graded) => {
      if (cancelled) return;
      if (!graded.ok) {
        dispatch({ type: "grading-failed", message: graded.message });
        return;
      }
      const { outcome } = graded;
      if (!isGraded(outcome)) {
        dispatch({ type: "voided", reason: outcome.outcome.reason });
        return;
      }
      const result = outcome;
      const update = applyCheckResult(before.skillProfile, result);
      const written = withSkillProfile(before, update.profile);
      if (!written.ok) {
        console.warn("[lesson] the Skill profile refused the graded result", written.issues);
        dispatch({ type: "profile-refused", message: written.issues.join("; ") });
        return;
      }
      const { record } = written;
      const firstPass = before.skillProfile.lessons[lessonId]?.passedAt == null && update.profile.lessons[lessonId]?.passedAt != null;
      // Saved by the App, one save at a time; the re-plan below saves after this record.
      onLearnerChange(record);
      if (skipGroupsPassed(before.skillProfile, record.skillProfile).length > 0) onSkipGroupPassed(result);
      const facts = lineFacts(result, { profileBefore: before.skillProfile, retentionChanges: update.retentionChanges, marginHistory: marginsRef.current });
      dispatch({ type: "graded", result, reviewTriggers: update.reviewTriggers, firstPass, lineFacts: facts });
    });
    return () => {
      cancelled = true;
    };
  }, [session, grading, lessonId, onLearnerChange, onSkipGroupPassed]);

  // The live caption during the Check follows the deck's position; drawn on animation frames.
  useEffect(() => {
    if (session === null || attempt === null) return;
    let frame = requestAnimationFrame(function draw() {
      const node = cueLine.current;
      if (node !== null) {
        const cue = session.checkCue();
        const text = inputWording(cue?.caption ?? definition.checkCaption, wording);
        // Written only on change: the checkpoint tick's animation restarts when its attribute flips.
        if (node.textContent !== text) node.textContent = text;
        const checkpoint = String(cue?.checkpoint === true);
        if (node.dataset["checkpoint"] !== checkpoint) node.dataset["checkpoint"] = checkpoint;
      }
      frame = requestAnimationFrame(draw);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [session, attempt, definition, wording]);

  // Lesson keys: Enter = into the Check (again), P = practice, Escape = back to the list, 1–8 = answers.
  const answering = phase.kind === "answering" ? phase.answers : null;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return;
      // A held Enter still must not reach a focused button as a click.
      if (event.code === "Enter") event.preventDefault();
      const key = lessonKey(event, { answering: answering !== null });
      if (key === null) return;
      switch (key.kind) {
        case "check":
          dispatch({ type: "start-check" });
          break;
        case "practice":
          dispatch({ type: "practice-again" });
          break;
        case "ready":
          session?.ready();
          break;
        case "exit":
          onExit();
          break;
        case "answer": {
          const question = definition.questions.find((candidate) => answering !== null && !(candidate.id in answering));
          if (question !== undefined && key.value <= question.options) dispatch({ type: "answer", questionId: question.id, value: key.value });
          break;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [answering, definition, onExit, session]);

  // The controller: earlier Lessons' controls, plus this Lesson's as the hook reaches them.
  const before = useMemo(() => passedLessons(learner).filter((id) => id !== lessonId), [learner, lessonId]);
  const hookStep = phase.kind === "hook" ? phase.step : null;
  const unlocks = useMemo<ReadonlySet<ControlId>>(() => {
    const earlier = unlocksAfter(before);
    const now = hookStep === null ? definition.unlocks : definition.hook.slice(0, hookStep + 1).map((step) => step.control);
    return new Set([...earlier, ...now]);
  }, [before, hookStep, definition]);
  const step = hookStep === null ? undefined : definition.hook[hookStep];
  const captions = useMemo<readonly ControllerCaption[]>(() => (step === undefined ? NO_CAPTIONS : [{ control: step.control, text: step.caption }]), [step]);

  return (
    <main className="lesson" data-phase={phase.kind} data-input={wording}>
      <header className="lesson-bar">
        <button type="button" className="btn btn-quiet lesson-back" onClick={onExit}>
          ← Lessons <kbd>Esc</kbd>
        </button>
        <h1>{definition.title}</h1>
        {audioRunning ? null : <span className="lesson-audio-off">{wording === "touch" ? "Tap to start the sound" : "Click or press a key to start the sound"}</span>}
        {setup.kind === "ready" ? <TrackCredit track={setup.session.track} /> : null}
      </header>

      <div className="lesson-stage">
        <p className="lesson-caption" role="status" aria-live="polite" aria-label="Lesson caption">
          <Caption phase={phase} definition={definition} setupStatus={setup.kind === "loading" ? setup.status : headphonesGate ? "Headphones check first" : null} cueLine={cueLine} />
        </p>
        {wording === "touch" ? <TouchGo phase={phase} dispatch={dispatch} /> : null}
        {wording === "touch" && session !== null ? <TouchReady phase={phase} session={session} definition={definition} /> : null}
        {session === null ? null : <FeedbackStrip session={session} taps={taps} showBeat={phase.kind !== "check"} practice={phase.kind === "practice" ? phase : null} />}
      </div>

      <div className="lesson-board">
        {phase.kind === "answering" ? (
          <section className="lesson-questions lesson-overlay" aria-label="Questions">
            {definition.questions.map((question) => (
              <div key={question.id} className="lesson-question" data-answered={question.id in phase.answers}>
                <span>{question.caption}</span>
                <div role="group" aria-label={question.caption}>
                  {Array.from({ length: question.options }, (_, index) => index + 1).map((option) => (
                    <button
                      key={option}
                      type="button"
                      className="btn"
                      aria-pressed={phase.answers[question.id] === option}
                      onClick={() => {
                        dispatch({ type: "answer", questionId: question.id, value: option });
                      }}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </section>
        ) : null}

        {headphonesGate && engine !== null ? <HeadphonesGate context={engine.context} onPassed={headphonesPassed} /> : null}

        {phase.kind === "result" || phase.kind === "void" ? (
          <ResultCard
            phase={phase}
            saveStatus={saveStatus}
            onRetrySave={onRetrySave}
            definition={definition}
            learnerId={learner.learnerId}
            missionTags={learner.missionTags}
            attemptToday={state.attempts}
            recentLines={recentLines}
            onRetry={() => {
              dispatch({ type: "start-check" });
            }}
            onPractice={() => {
              dispatch({ type: "practice-again" });
            }}
            onDeclineReview={() => {
              dispatch({ type: "review-declined" });
            }}
            onOpenLesson={onOpenLesson}
          />
        ) : null}

        {engine === null ? (
          setup.kind === "failed" ? (
            <p className="lesson-problem" role="alert">
              {setup.message}
            </p>
          ) : null
        ) : (
          <Controller engine={engine} unlocks={unlocks} pulse={step?.control ?? null} captions={captions} />
        )}
      </div>
    </main>
  );
}

/** The URL when it is a web link; track metadata comes from manifests, so `javascript:` and the like never become links. */
function webLink(url: string | null): string | null {
  if (url === null || !URL.canParse(url)) return null;
  const { protocol } = new URL(url);
  return protocol === "https:" || protocol === "http:" ? url : null;
}

function TrackCredit({ track }: { readonly track: LessonTrack }) {
  const link = webLink(track.attribution.url);
  return (
    <span className="lesson-credit">
      {link === null ? (
        track.attribution.text
      ) : (
        <a href={link} target="_blank" rel="noopener noreferrer">
          {track.attribution.text}
        </a>
      )}
    </span>
  );
}

interface CaptionProps {
  readonly phase: LessonPhase;
  readonly definition: ReturnType<typeof lessonDefinition>;
  readonly setupStatus: string | null;
  readonly cueLine: RefObject<HTMLSpanElement | null>;
}

/** One line: what to do now. The concept just named sits before it, smaller. */
function Caption({ phase, definition, setupStatus, cueLine }: CaptionProps) {
  const wording = useWording();
  const say = (text: string | undefined) => (text === undefined ? undefined : inputWording(text, wording));
  switch (phase.kind) {
    case "loading":
      return <span>{setupStatus ?? "Getting the deck ready…"}</span>;
    case "unavailable":
      return <span>{phase.message}</span>;
    case "hook":
      return (
        <>
          {phase.named === null ? null : <span className="lesson-named">{phase.named}</span>}
          <span className="lesson-do">{say(definition.hook[phase.step]?.caption)}</span>
        </>
      );
    case "practice":
      return (
        <>
          {phase.named === null ? null : <span className="lesson-named">{phase.named}</span>}
          <span className="lesson-do">
            {phase.ready ? "Ready? This one counts." : say(definition.practice.caption)}
            <span className="lesson-hint">
              <kbd>Enter</kbd> {phase.ready ? "to go" : "for the Check"}
            </span>
          </span>
        </>
      );
    case "check":
      return (
        <span className="lesson-do" data-testid="check-cue">
          <span ref={cueLine} className="lesson-cue" data-checkpoint="false">
            {say(definition.checkCaption)}
          </span>
          <span className="lesson-hint">
            <kbd>Enter</kbd> restarts
          </span>
        </span>
      );
    case "answering":
      return <span className="lesson-do">{definition.questions.find((question) => !(question.id in phase.answers))?.caption ?? ""} (1–8)</span>;
    case "grading":
      return <span>Checking…</span>;
    case "result":
    case "void":
      return (
        <span className="lesson-do">
          {phase.kind === "result" && phase.result.outcome.kind === "passed" ? "Passed." : "Again?"}
          <span className="lesson-hint">
            <kbd>Enter</kbd> go · <kbd>P</kbd> practice
          </span>
        </span>
      );
  }
}

/** On a touchscreen there is no Enter key: the way into the Check (and to restart it) is a button. */
/** R without a keyboard: Ready, while practice or the Check uses it (gain-staging, cue-point). */
function TouchReady({ phase, session, definition }: { readonly phase: LessonPhase; readonly session: LessonSession; readonly definition: ReturnType<typeof lessonDefinition> }) {
  const used = useMemo(() => readyUsedIn(definition, session.track), [definition, session]);
  if (!(phase.kind === "practice" ? used.practice : phase.kind === "check" && used.check)) return null;
  return (
    <button
      type="button"
      className="btn btn-primary lesson-touch-go"
      onClick={() => {
        session.ready();
      }}
    >
      Ready
    </button>
  );
}

function TouchGo({ phase, dispatch }: { readonly phase: LessonPhase; readonly dispatch: (action: { type: "start-check" }) => void }) {
  if (phase.kind !== "practice" && phase.kind !== "check") return null;
  return (
    <button
      type="button"
      className={`btn lesson-touch-go${phase.kind === "practice" ? " btn-primary" : " btn-quiet"}`}
      onClick={() => {
        dispatch({ type: "start-check" });
      }}
    >
      {phase.kind === "practice" ? (phase.ready ? "Go" : "Start the Check") : "Restart"}
    </button>
  );
}
