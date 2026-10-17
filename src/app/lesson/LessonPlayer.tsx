// One Lesson, end to end: the controller fills the screen, one caption line sits above it, a compact
// strip gives live feedback, and the result card follows each Check. Hook → practice → Check → result
// → Check again is one loop driven by the pure runtime; Enter always goes (back) into the Check.
import { useEffect, useMemo, useReducer, useRef, useState, type RefObject } from "react";
import { createAudioEngine, type AudioEngine } from "@audio";
import { applyCheckResult } from "@checks";
import { initialLessonState, lessonDefinition, lineFacts, NO_LINE_FACTS, skipGroupsPassed, lessonReducer, unlocksAfter, type BuiltLessonId, type ControlId, type LessonPhase, type LessonTrack, type Observation } from "@lessons";
import type { LessonId } from "@shared/attempt.ts";
import type { CheckResult, VoidAttempt } from "@shared/check-result.ts";
import { withSkillProfile, type LearnerRecord } from "@shared/learner.ts";
import { Controller } from "../controller/Controller.tsx";
import type { ControllerCaption } from "../controller/context.tsx";
import { saveLearner } from "./api-client.ts";
import { FeedbackStrip, type TapMark } from "./FeedbackStrip.tsx";
import { lessonKey } from "./lesson-keys.ts";
import { LessonSession } from "./lesson-session.ts";
import { ResultCard } from "./ResultCard.tsx";
import { loadLessonTrack, type TrackPreference } from "./track-loader.ts";
import "./lesson.css";

export interface LessonHandle {
  readonly engine: AudioEngine;
  readonly track: LessonTrack;
  readonly phase: () => LessonPhase["kind"];
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
  readonly onLearnerChange: (record: LearnerRecord) => void;
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

export function LessonPlayer({ lessonId, learner, onLearnerChange, onSkipGroupPassed, trackPreference, onExit, onOpenLesson }: LessonPlayerProps) {
  const definition = useMemo(() => lessonDefinition(lessonId), [lessonId]);
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
      if (observation.kind === "tap") setTaps((marks) => [...marks, { offsetMs: observation.offsetMs, good: observation.onBeat }].slice(-TAP_MARKS_KEPT));
    };
    void (async () => {
      try {
        engine = await createAudioEngine({ masterTempo: false });
        const ready = await loadLessonTrack(definition, {
          preference: trackPreference,
          signal: abort.signal,
          onStatus: (status) => {
            if (!abort.signal.aborted) setSetup({ kind: "loading", status });
          },
        });
        if (cancelled()) return;
        const loaded = await engine.load("A", ready.audio, { trackId: ready.track.trackId, grid: ready.track.grid });
        if (!loaded.ok) throw new Error(`deck A refused the track (${loaded.error.kind})`);
        if (cancelled()) return;
        session = new LessonSession(engine, definition, ready.track, learnerRef.current.learnerId, {
          observed,
          audioEnded: () => {
            dispatch({ type: "audio-ended" });
          },
          checkFailed: (message) => {
            dispatch({ type: "check-failed", message });
          },
        });
        const running = engine;
        window.learnToDjLesson = { engine: running, track: ready.track, phase: () => phaseRef.current.kind };
        setSetup({ kind: "ready", engine: running, session });
        dispatch({ type: "track-ready" });
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
        dispatch({ type: "graded", outcome, reviewTriggers: [], firstPass: false, lineFacts: NO_LINE_FACTS });
        return;
      }
      const result = outcome;
      const update = applyCheckResult(before.skillProfile, result);
      const written = withSkillProfile(before, update.profile);
      if (!written.ok) {
        dispatch({ type: "grading-failed", message: `The Skill profile update is invalid (${written.issues.join("; ")}).` });
        return;
      }
      const { record } = written;
      const firstPass = before.skillProfile.lessons[lessonId]?.passedAt == null && update.profile.lessons[lessonId]?.passedAt != null;
      onLearnerChange(record);
      void saveLearner(record).then((saved) => {
        if (!saved.ok) console.warn(`[lesson] ${saved.problem.message}`);
      });
      if (skipGroupsPassed(before.skillProfile, record.skillProfile).length > 0) onSkipGroupPassed(result);
      const facts = lineFacts(result, { profileBefore: before.skillProfile, retentionChanges: update.retentionChanges, marginHistory: marginsRef.current });
      dispatch({ type: "graded", outcome: result, reviewTriggers: update.reviewTriggers, firstPass, lineFacts: facts });
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
        const text = cue?.caption ?? definition.checkCaption;
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
  }, [session, attempt, definition]);

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
  }, [answering, definition, onExit]);

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
    <main className="lesson" data-phase={phase.kind}>
      <header className="lesson-bar">
        <button type="button" className="btn btn-quiet lesson-back" onClick={onExit}>
          ← Lessons <kbd>Esc</kbd>
        </button>
        <h1>{definition.title}</h1>
        {audioRunning ? null : <span className="lesson-audio-off">Click or press a key to start the sound</span>}
        {setup.kind === "ready" ? <TrackCredit track={setup.session.track} /> : null}
      </header>

      <div className="lesson-stage">
        <p className="lesson-caption" role="status" aria-live="polite" aria-label="Lesson caption">
          <Caption phase={phase} definition={definition} setupStatus={setup.kind === "loading" ? setup.status : null} cueLine={cueLine} />
        </p>
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

        {phase.kind === "result" || phase.kind === "void" ? (
          <ResultCard
            phase={phase}
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
  switch (phase.kind) {
    case "loading":
      return <span>{setupStatus ?? "Getting the deck ready…"}</span>;
    case "unavailable":
      return <span>{phase.message}</span>;
    case "hook":
      return (
        <>
          {phase.named === null ? null : <span className="lesson-named">{phase.named}</span>}
          <span className="lesson-do">{definition.hook[phase.step]?.caption}</span>
        </>
      );
    case "practice":
      return (
        <>
          {phase.named === null ? null : <span className="lesson-named">{phase.named}</span>}
          <span className="lesson-do">
            {phase.ready ? "Ready? This one counts." : definition.practice.caption}
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
            {definition.checkCaption}
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
