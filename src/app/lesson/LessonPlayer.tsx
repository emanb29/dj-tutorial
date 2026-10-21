// One Lesson, end to end: the controller fills the screen, one caption line sits above it, a compact
// strip gives live feedback, and the result card follows each Check. Hook → practice → Check → result
// → Check again is one loop driven by the pure runtime; Enter always goes (back) into the Check.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type RefObject } from "react";
import { createAudioEngine, describeError, outputLine, type AudioEngine } from "@audio";
import { applyCheckResult, CUE_PLACEMENT_TOLERANCE_MS } from "@checks";
import {
  COVERED_DISPLAYS,
  cueMissHint,
  cueRepLine,
  cueTargetLine,
  initialLessonState,
  gradedLine,
  lessonDefinition,
  lineFacts,
  peakDbfsOf,
  readyUsedIn,
  skipGroupsPassed,
  lessonReducer,
  lessonUnlocks,
  unlocksAfter,
  withoutMasterTempo,
  type BuiltLessonId,
  type ControlId,
  type DeckId,
  type LessonPhase,
  type CheckQuestion,
  type ListeningClip,
  type LessonTrack,
  type Observation,
} from "@lessons";
import type { LessonId } from "@shared/attempt.ts";
import type { CheckResult, VoidAttempt } from "@shared/check-result.ts";
import { withHeadphonesChecked, withRekordboxChoice, withSkillProfile, type LearnerRecord } from "@shared/learner.ts";
import { Controller } from "../controller/Controller.tsx";
import type { ControllerCaption } from "../controller/context.tsx";
import { KeyHint, useControllerConnected } from "../controller/KeyHint.tsx";
import { announceTapJudged, useTapOnHardware } from "../controller/tap-feedback.ts";
import { inputWording, useWording } from "../controller/wording.ts";
import { currentOutputPlan } from "../audio-output.ts";
import { anyTimingStored, markTimingCheckOffered, timingCheckOffered, timingCorrectionMs } from "../timing-offset.ts";
import type { SaveStatus } from "../save-queue.ts";
import { FeedbackStrip, type TapMark } from "./FeedbackStrip.tsx";
import { needsHeadphonesCheck } from "./headphones-check.ts";
import { HeadphonesGate } from "./HeadphonesGate.tsx";
import { lessonKey } from "./lesson-keys.ts";
import { LessonSession } from "./lesson-session.ts";
import { PhraseCounter } from "./PhraseCounter.tsx";
import { PhrasePlayButton, PhrasePreviewBar } from "./PhrasePreview.tsx";
import { NO_DRILL_STATUS, type DrillStatus } from "./practice-drill.ts";
import { lessonCardFor } from "../rekordbox/rekordbox-steps.ts";
import { practiceSetUp } from "./practice-set-up.ts";
import { ResultCard } from "./ResultCard.tsx";
import { SetUpStep, useSetUpCaption } from "./SetUpStep.tsx";
import { loadLessonTrack, type TrackPreference } from "./track-loader.ts";
import "./lesson.css";
import "./lesson-extras.css";

export interface LessonHandle {
  readonly engine: AudioEngine;
  readonly track: LessonTrack;
  readonly phase: () => LessonPhase["kind"];
  /** The track on a deck now: the Lesson track, a cue-point slice, or the partner on B. */
  readonly deckTrack: (deck: DeckId) => LessonTrack | null;
  /** The listening clip playing for a question now (tempo-fader), if any. */
  readonly clip?: () => ListeningClip | null;
  /** Whether a set-up step (practice's or the Check's) waits for R now. */
  readonly settingUp?: () => boolean;
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

type Setup = { kind: "loading"; status: string } | { kind: "ready"; session: LessonSession } | { kind: "failed"; message: string };

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

const NOTHING_CONCEALED: ReadonlySet<ControlId> = new Set();
/** A listening clip's deck controls that would tell (or change) what the clip is asking about. */
const CLIP_CONCEALED = ["master-tempo", "tempo", "tempo-range", "sync"] as const;

/** What answer key `value` (1, 2, …) records for a question: its choice's value, or the number itself. */
export function answerValue(question: CheckQuestion, key: number): number | null {
  if (question.choices === undefined) return key <= question.options ? key : null;
  return question.choices[key - 1]?.value ?? null;
}

function tapMark(observation: Observation): TapMark | null {
  if (observation.kind === "tap") return { offsetMs: observation.offsetMs, good: observation.onBeat };
  if (observation.kind === "cue-set") return { offsetMs: observation.offsetMs, good: observation.onDownbeat && Math.abs(observation.offsetMs) <= CUE_PLACEMENT_TOLERANCE_MS };
  return null;
}

export function LessonPlayer({ lessonId, learner, onLearnerChange, saveStatus, onRetrySave, onSkipGroupPassed, trackPreference, onExit, onOpenLesson }: LessonPlayerProps) {
  const listed = useMemo(() => lessonDefinition(lessonId), [lessonId]);
  // Where Master Tempo cannot load, a Lesson that needs it runs without it (withoutMasterTempo): known
  // once the engine is up, before the hook starts.
  const [masterTempoMissing, setMasterTempoMissing] = useState(false);
  const definition = useMemo(() => (masterTempoMissing ? withoutMasterTempo(listed) : listed), [listed, masterTempoMissing]);
  // Asked once per Learner, before the first headphone-cue Lesson; read at mount only.
  const [headphonesGate, setHeadphonesGate] = useState(() => needsHeadphonesCheck(definition, learner));
  const reducer = useMemo(() => lessonReducer(definition), [definition]);
  const [state, dispatch] = useReducer(reducer, lessonId, initialLessonState);
  const [setup, setSetup] = useState<Setup>({ kind: "loading", status: "Getting the deck ready…" });
  const [audioRunning, setAudioRunning] = useState(true);
  const [taps, setTaps] = useState<readonly TapMark[]>([]);
  const [drill, setDrill] = useState<DrillStatus>(NO_DRILL_STATUS);
  const learnerRef = useRef(learner);
  const phaseRef = useRef(state.phase);
  const cueLine = useRef<HTMLSpanElement>(null);
  const recentLines = useRef<string[]>([]);
  const marginsRef = useRef(state.margins);
  const { phase, margins } = state;
  const wording = useWording();
  const tapOnHardware = useTapOnHardware();
  const controllerConnected = useControllerConnected();
  // The first tap Lesson offers the Controller page's Timing check, once per browser (read at mount only).
  const [timingOffer, setTimingOffer] = useState(() => listed.unlocks.includes("tap") && !timingCheckOffered() && !anyTimingStored());
  useEffect(() => {
    if (timingOffer) markTimingCheckOffered();
  }, [timingOffer]);
  useEffect(() => {
    learnerRef.current = learner;
    phaseRef.current = phase;
    marginsRef.current = margins;
  }, [learner, phase, margins]);

  // The engine, once per Lesson visit.
  const [engine, setEngine] = useState<AudioEngine | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    const cancelled = () => abort.signal.aborted;
    let created: AudioEngine | null = null;
    // Closed by whichever comes last: the cleanup, or a start that finishes after the cleanup ran
    // (StrictMode's first run, or Esc while it starts). Otherwise its AudioContext would leak.
    const closeEngine = () => {
      created?.close().catch((error: unknown) => {
        console.warn("[lesson] the audio engine did not close cleanly", error);
      });
      created = null;
    };
    void (async () => {
      try {
        // The Learner's output (Controller page): split cue by default, cue in the left ear and master
        // in the right; or through the FLX4, or two devices. Master Tempo (time-stretching) loads only
        // where it is taught or already on the controller.
        const masterTempo = listed.masterTempo === true || unlocksAfter(passedLessons(learnerRef.current)).has("B.master-tempo");
        const plan = await currentOutputPlan();
        if (cancelled()) return;
        // The Learner's input latency through this output (the Controller page's Timing check), taken off their inputs.
        created = await createAudioEngine({ masterTempo, output: { plan, headphones: listed.headphones === true }, inputCorrectionMs: timingCorrectionMs(plan.kind) });
        if (cancelled()) closeEngine();
        else setEngine(created);
      } catch (error) {
        if (cancelled()) return;
        const message = `The deck could not start: ${error instanceof Error ? error.message : String(error)}. Reload to try again.`;
        setSetup({ kind: "failed", message });
        dispatch({ type: "track-failed", message });
      }
    })();
    return () => {
      abort.abort();
      setEngine(null);
      closeEngine();
    };
  }, [listed]);

  // The track and the session: picked when the Lesson opens, and again on each `roll` ("Different
  // track", or the Check again after a result). One run (hook → practice → Check) keeps its track.
  const [roll, setRoll] = useState(0);
  // A roll from the result card: the Check starts once the new track is on the deck.
  const checkAfterRoll = useRef(false);
  useEffect(() => {
    if (engine === null) return;
    const abort = new AbortController();
    const cancelled = () => abort.signal.aborted;
    let session: LessonSession | null = null;
    const observed = (observation: Observation) => {
      dispatch({ type: "observed", observation });
      const mark = tapMark(observation);
      if (mark !== null) setTaps((marks) => [...marks, mark].slice(-TAP_MARKS_KEPT));
      if (observation.kind === "tap") announceTapJudged(observation.onBeat);
    };
    setSetup({ kind: "loading", status: roll === 0 ? "Getting the deck ready…" : "Finding a different track…" });
    void (async () => {
      try {
        const ready = await loadLessonTrack(listed, {
          preference: trackPreference,
          signal: abort.signal,
          sampleRate: engine.context.sampleRate,
          onStatus: (status) => {
            if (!abort.signal.aborted) setSetup({ kind: "loading", status });
          },
        });
        if (cancelled()) return;
        const peakOf = (audio: AudioBuffer) => peakDbfsOf(Array.from({ length: audio.numberOfChannels }, (_, channel) => audio.getChannelData(channel)));
        const partner = ready.track.partner === undefined || ready.partnerAudio === undefined ? undefined : { ...ready.track.partner, peakDbfs: peakOf(ready.partnerAudio) };
        const track: LessonTrack = { ...ready.track, peakDbfs: peakOf(ready.audio), ...(partner === undefined ? {} : { partner }) };
        const withDeckB = LessonSession.usesDeckB(listed, track);
        for (const deck of withDeckB ? (["A", "B"] as const) : (["A"] as const)) {
          const onDeck = deck === "B" && partner !== undefined ? partner : track;
          const audio = deck === "B" && ready.partnerAudio !== undefined ? ready.partnerAudio : ready.audio;
          const loaded = await engine.load(deck, audio, { trackId: onDeck.trackId, grid: onDeck.grid });
          if (!loaded.ok) throw new Error(`deck ${deck} refused the track: ${describeError(loaded.error)}`);
        }
        if (cancelled()) return;
        const availability = engine.deckState("B").masterTempoAvailability;
        const missing = listed.masterTempo === true && !availability.available;
        if (!availability.available && missing) console.warn(`[lesson] Master Tempo is unavailable (${availability.reason}); ${listed.id} runs without its clips`);
        const created = new LessonSession(
          engine,
          missing ? withoutMasterTempo(listed) : listed,
          track,
          ready.audio,
          learnerRef.current.learnerId,
          {
            observed,
            audioEnded: () => {
              dispatch({ type: "audio-ended" });
            },
            drillStatus: setDrill,
            checkFailed: (message) => {
              dispatch({ type: "check-failed", message });
            },
          },
          withDeckB,
        );
        session = created;
        window.learnToDjLesson = { engine, track, phase: () => phaseRef.current.kind, deckTrack: (deck) => created.deckTrack(deck), clip: () => created.playingClip(), settingUp: () => created.setUpPending() !== null };
        setMasterTempoMissing(missing);
        setSetup({ kind: "ready", session: created });
        if (checkAfterRoll.current) {
          checkAfterRoll.current = false;
          dispatch({ type: "start-check" });
        }
      } catch (error) {
        if (abort.signal.aborted) return;
        const message = `The deck could not start: ${error instanceof Error ? error.message : String(error)}. Reload to try again.`;
        setSetup({ kind: "failed", message });
        dispatch({ type: "track-failed", message });
      }
    })();
    return () => {
      abort.abort();
      session?.close();
      delete window.learnToDjLesson;
    };
  }, [engine, listed, trackPreference, roll]);

  // Only Originals rotate: the starter pack and the synthetic groove are single fallbacks.
  const rerollable = trackPreference === "auto" && setup.kind === "ready" && setup.session.track.source === "original";
  const differentTrack = useCallback(() => {
    setRoll((count) => count + 1);
  }, []);
  /** The Check again after a result: on a different track when there is one to choose from. */
  const checkAgain = useCallback(() => {
    if (setup.kind === "loading") return;
    if (!rerollable) {
      dispatch({ type: "start-check" });
      return;
    }
    checkAfterRoll.current = true;
    setRoll((count) => count + 1);
  }, [setup.kind, rerollable]);

  const session = setup.kind === "ready" ? setup.session : null;
  // Practice's set-up step says what to set up in the caption line, as the Check's does.
  const setUpCaption = useSetUpCaption(session);

  // The ear check is for split cue; with the FLX4 or two devices, the cue has its own output.
  const outputHasOwnCue = engine?.output != null && engine.output.kind !== "split-cue";
  useEffect(() => {
    if (outputHasOwnCue) setHeadphonesGate(false);
  }, [outputHasOwnCue]);
  const whereSoundGoes = engine?.output == null ? null : outputLine(engine.output, definition.headphones === true);

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
  // A by-ear drill (Lessons 14–16) starts its own rounds from the set-up, and its last hook step shows a reveal a re-cue would cut off.
  const setUp = practiceSetUp(phase.kind, session?.deckTrack("B") != null && definition.drill === undefined);
  const attempt = phase.kind === "check" ? phase.attempt : null;
  useEffect(() => {
    if (session !== null && setUp !== null) session.preparePractice(setUp);
  }, [session, setUp]);
  useEffect(() => {
    if (session === null || attempt === null) return;
    setTaps([]);
    session.startCheck(passedLessons(learnerRef.current));
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
        const text = inputWording(cue?.caption ?? definition.checkCaption, wording, tapOnHardware, controllerConnected);
        // Written only on change: the checkpoint tick's animation restarts when its attribute flips.
        if (node.textContent !== text) node.textContent = text;
        const checkpoint = String(cue?.checkpoint === true);
        if (node.dataset["checkpoint"] !== checkpoint) node.dataset["checkpoint"] = checkpoint;
        const countdown = String(cue?.countdown === true);
        if (node.dataset["countdown"] !== countdown) node.dataset["countdown"] = countdown;
      }
      frame = requestAnimationFrame(draw);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [session, attempt, definition, wording, tapOnHardware, controllerConnected]);

  // Lesson keys: Enter = into the Check (again), P = practice, Escape = back to the list, 1–8 = answers.
  const answering = phase.kind === "answering" ? phase.answers : null;
  // The question asked now plays its listening clip (tempo-fader), on a loop until it is answered.
  const asking = answering === null ? null : (definition.questions.find((question) => !(question.id in answering))?.id ?? null);
  useEffect(() => {
    if (session !== null && asking !== null) session.playClip(asking);
  }, [session, asking]);
  // Choosing an answer stops a phrase preview.
  useEffect(() => {
    if (answering !== null) session?.stopPreview();
  }, [session, answering]);
  // While a clip plays, its deck's tempo controls are held locked and unlit: MASTER TEMPO lit (or a
  // press to compare) would give the answer away.
  const clipDeck = session === null || asking === null ? null : (session.clipFor(asking)?.deck ?? null);
  const concealed = useMemo<ReadonlySet<ControlId>>(
    () => {
      const clip = clipDeck === null ? [] : CLIP_CONCEALED.map((part) => `${clipDeck}.${part}` as const);
      // SYNC locked off, the BPM display and phase meter covered (by-ear Lessons); a drill shows the
      // displays between its rounds.
      const locked = (definition.locks ?? []).filter((control) => !(drill.reveal && COVERED_DISPLAYS.includes(control)));
      const all = [...clip, ...locked];
      return all.length === 0 ? NOTHING_CONCEALED : new Set<ControlId>(all);
    },
    [clipDeck, definition, drill.reveal],
  );
  // After a result, the Check again is a new run: on a different track.
  const afterRun = phase.kind === "result" || phase.kind === "void";
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return;
      // A held Enter still must not reach a focused button as a click.
      if (event.code === "Enter") event.preventDefault();
      const key = lessonKey(event, { answering: answering !== null, previewing: session?.previewingPhrase() != null });
      if (key === null) return;
      // Handled here: the FLX4's navigation (ControllerNavigation) then does nothing more with it.
      event.preventDefault();
      switch (key.kind) {
        case "check":
          if (afterRun) checkAgain();
          else dispatch({ type: "start-check" });
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
          const value = question === undefined ? null : answerValue(question, key.value);
          if (question !== undefined && value !== null) dispatch({ type: "answer", questionId: question.id, value });
          break;
        }
        case "preview":
          session?.previewPhrase(key.value);
          break;
        case "preview-focused": {
          const chip = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>("[data-phrase]") : null;
          const phrase = Number(chip?.dataset["phrase"]);
          if (Number.isInteger(phrase)) session?.previewPhrase(phrase);
          break;
        }
        case "stop-preview":
          session?.stopPreview();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [answering, afterRun, checkAgain, definition, onExit, session]);

  // The controller: earlier Lessons' controls, plus this Lesson's as the hook reaches them.
  const before = useMemo(() => passedLessons(learner).filter((id) => id !== lessonId), [learner, lessonId]);
  // What the Check grades, standing criteria too, announced before and during it (passed Lessons as grading reads them).
  const graded = useMemo(() => gradedLine(definition, passedLessons(learner)), [definition, learner]);
  const hookStep = phase.kind === "hook" ? phase.step : null;
  const unlocks = useMemo(() => lessonUnlocks(definition, before, hookStep), [before, hookStep, definition]);
  const step = hookStep === null ? undefined : definition.hook[hookStep];
  const captions = useMemo<readonly ControllerCaption[]>(() => (step === undefined ? NO_CAPTIONS : [{ control: step.control, text: step.caption }]), [step]);
  // Lesson 6 practice: after two misses the same way, which way to fix it.
  const cueHint = phase.kind === "practice" && phase.cueLadder !== null ? cueMissHint(phase.cueLadder) : null;

  return (
    <main className="lesson" data-phase={phase.kind} data-input={wording}>
      <header className="lesson-bar">
        <button type="button" className="btn btn-quiet lesson-back" onClick={onExit} data-nav-back>
          ← Lessons <KeyHint k="Esc" />
        </button>
        <h1>{definition.title}</h1>
        {audioRunning ? null : (
          <span className="lesson-audio-off">
            {wording === "touch" ? "Tap to start the sound" : "Click or press a key to start the sound"}
            {/* Browsers wake audio only for a click, a tap or a key: a MIDI press is none of them. */}
            {controllerConnected ? " (once: the browser won't let the FLX4 start it)" : null}
          </span>
        )}
        {timingOffer ? (
          <span className="lesson-timing-offer">
            <a href="/controller#timing-check">Timing check (20 s)</a> fits tap grading to your setup
            <button
              type="button"
              className="btn btn-quiet"
              aria-label="Not now"
              onClick={() => {
                setTimingOffer(false);
              }}
            >
              ✕
            </button>
          </span>
        ) : null}
        {setup.kind === "ready" ? <TrackCredit track={setup.session.track} /> : null}
        {trackPreference === "auto" && (inPractice || phase.kind === "check") && (rerollable || setup.kind === "loading") ? (
          <button
            type="button"
            className="btn btn-quiet lesson-reroll"
            disabled={phase.kind === "check" || setup.kind === "loading"}
            title={phase.kind === "check" ? "After the Check" : "Same Lesson, another track"}
            onClick={differentTrack}
          >
            Different track
          </button>
        ) : null}
      </header>

      <div className="lesson-stage">
        <p className="lesson-caption" role="status" aria-live="polite" aria-label="Lesson caption">
          <Caption
            phase={phase}
            definition={definition}
            graded={graded}
            practiceCaption={setUpCaption ?? (session === null ? definition.practice.caption : (definition.practiceCaptionFor?.(session.track) ?? definition.practice.caption))}
            setupStatus={setup.kind === "loading" ? setup.status : headphonesGate ? "Headphones check first" : null}
            cueLine={cueLine}
          />
          {session !== null && inPractice && definition.phraseCount === true ? <PhraseCounter session={session} /> : null}
        </p>
        {wording === "touch" ? <TouchGo phase={phase} dispatch={dispatch} /> : null}
        {wording === "touch" && session !== null ? <TouchReady phase={phase} session={session} definition={definition} /> : null}
        {session === null ? null : (
          <FeedbackStrip
            session={session}
            taps={taps}
            showBeat={phase.kind !== "check"}
            practice={phase.kind === "practice" ? phase : null}
            line={inPractice ? (drill.line === null ? cueLadderLine(phase) : inputWording(drill.line, wording, tapOnHardware, controllerConnected)) : null}
            hint={cueHint === null ? null : inputWording(cueHint, wording, tapOnHardware, controllerConnected)}
          />
        )}
      </div>

      <div className="lesson-board">
        {phase.kind === "answering" ? (
          <section className="lesson-questions lesson-overlay" aria-label="Questions" data-nav-start>
            {definition.questions.map((question) => (
              <div key={question.id} className="lesson-question" data-answered={question.id in phase.answers}>
                <span>{question.caption}</span>
                <div role="group" aria-label={question.caption}>
                  {question.previews === "phrases" && session !== null ? (
                    <PhraseChips question={question} chosen={phase.answers[question.id]} session={session} dispatch={dispatch} />
                  ) : (question.choices ?? Array.from({ length: question.options }, (_, index) => ({ label: String(index + 1), value: index + 1 }))).map((choice) => (
                    <button
                      key={choice.value}
                      type="button"
                      className="btn"
                      aria-pressed={phase.answers[question.id] === choice.value}
                      onClick={() => {
                        dispatch({ type: "answer", questionId: question.id, value: choice.value });
                      }}
                    >
                      {choice.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {session !== null && definition.questions.some((question) => question.previews === "phrases") ? <PhrasePreviewBar session={session} /> : null}
          </section>
        ) : null}

        {session === null ? null : <SetUpStep session={session} />}

        {headphonesGate && engine !== null && !outputHasOwnCue ? <HeadphonesGate context={engine.context} onPassed={headphonesPassed} /> : null}

        {phase.kind === "result" || phase.kind === "void" ? (
          <ResultCard
            phase={phase}
            previews={session}
            saveStatus={saveStatus}
            onRetrySave={onRetrySave}
            definition={definition}
            learnerId={learner.learnerId}
            missionTags={learner.missionTags}
            attemptToday={state.attempts}
            recentLines={recentLines}
            onRetry={checkAgain}
            onPractice={() => {
              dispatch({ type: "practice-again" });
            }}
            onDeclineReview={() => {
              dispatch({ type: "review-declined" });
            }}
            onOpenLesson={onOpenLesson}
            rekordboxCard={phase.kind === "result" ? lessonCardFor(lessonId, phase.result.outcome.kind === "passed", learner) : null}
            onRekordboxChoice={(card, choice) => {
              onLearnerChange(withRekordboxChoice(learnerRef.current, card, choice, new Date().toISOString()));
            }}
          />
        ) : null}

        {engine === null ? (
          setup.kind === "failed" ? (
            <p className="lesson-problem" role="alert">
              {setup.message}
            </p>
          ) : null
        ) : (
          <Controller engine={engine} unlocks={unlocks} pulse={step?.control ?? null} captions={captions} concealed={concealed} outputLine={whereSoundGoes} />
        )}
      </div>
    </main>
  );
}

/**
 * A question answered by phrase (phrases' breakdown and drop): a "Phrase N" chip per phrase, each with
 * its own ▶ that plays from just before the phrase, across the change into it. The chip of the phrase
 * heard now is lit (PhrasePreviewBar draws it). Hearing it is the skill: no waveform, no levels.
 */
function PhraseChips({ question, chosen, session, dispatch }: { readonly question: CheckQuestion; readonly chosen: number | undefined; readonly session: LessonSession; readonly dispatch: (action: { type: "answer"; questionId: string; value: number }) => void }) {
  return Array.from({ length: question.options }, (_, index) => index + 1).map((phrase) => (
    <span key={phrase} className="phrase-chip" data-chip={phrase} data-heard="false">
      <PhrasePlayButton session={session} phrase={phrase} />
      <button
        type="button"
        className="btn phrase-chip-pick"
        data-phrase={phrase}
        aria-pressed={chosen === phrase}
        onClick={() => {
          dispatch({ type: "answer", questionId: question.id, value: phrase });
        }}
      >
        Phrase {phrase}
      </button>
    </span>
  ));
}

/** The URL when it is a web link; track metadata comes from manifests, so `javascript:` and the like never become links. */
function webLink(url: string | null): string | null {
  if (url === null || !URL.canParse(url)) return null;
  const { protocol } = new URL(url);
  return protocol === "https:" || protocol === "http:" ? url : null;
}

/** One line: an Original's title and artist (a pair names B's title too); other sources' own credit. */
export function trackLine(track: LessonTrack): string {
  if (track.source !== "original") return track.attribution.text;
  const artist = track.artist === undefined ? "" : ` · ${track.artist}`;
  return track.partner === undefined ? `${track.title}${artist}` : `A: ${track.title} · B: ${track.partner.title}${artist}`;
}

function TrackCredit({ track }: { readonly track: LessonTrack }) {
  const link = webLink(track.attribution.url);
  const line = trackLine(track);
  return (
    <span className="lesson-credit" data-testid="track-credit" title={line}>
      {link === null ? (
        line
      ) : (
        <a href={link} target="_blank" rel="noopener noreferrer">
          {line}
        </a>
      )}
    </span>
  );
}

/** Lesson 6 practice: the last cue point's offset ("Cue: 34 ms late"), or null before the first. */
function cueLadderLine(phase: LessonPhase): string | null {
  if (phase.kind !== "practice" || phase.cueLadder?.last == null) return null;
  return cueRepLine(phase.cueLadder.last);
}

interface CaptionProps {
  readonly phase: LessonPhase;
  readonly definition: ReturnType<typeof lessonDefinition>;
  /** The practice caption on this track (tempo-fader names its target BPM). */
  readonly practiceCaption: string;
  readonly setupStatus: string | null;
  readonly cueLine: RefObject<HTMLSpanElement | null>;
  /** "Graded: …": every criterion the Check can fail on. */
  readonly graded: string;
}

/** One line: what to do now. The concept just named sits before it, smaller. */
function Caption({ phase, definition, practiceCaption, setupStatus, cueLine, graded }: CaptionProps) {
  const wording = useWording();
  const tapOnHardware = useTapOnHardware();
  const controllerConnected = useControllerConnected();
  const say = (text: string | undefined) => (text === undefined ? undefined : inputWording(text, wording, tapOnHardware, controllerConnected));
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
            {phase.ready ? "Ready? This one counts." : say(practiceCaption)}
            {phase.ready || phase.cueLadder === null ? null : (
              <span className="lesson-target" data-testid="cue-target">
                {cueTargetLine(phase.cueLadder)}
              </span>
            )}
            <span className="lesson-hint">
              <KeyHint k="Enter" /> {phase.ready ? "to go" : "for the Check"}
            </span>
            {phase.ready ? (
              <span className="lesson-graded" data-testid="graded-line">
                {graded}
              </span>
            ) : null}
          </span>
        </>
      );
    case "check":
      return (
        <span className="lesson-do" data-testid="check-cue">
          <span ref={cueLine} className="lesson-cue" data-checkpoint="false" data-countdown="false">
            {say(definition.checkCaption)}
          </span>
          <span className="lesson-hint">
            <KeyHint k="Enter" /> restarts
          </span>
          <span className="lesson-graded" data-testid="graded-line">
            {graded}
          </span>
        </span>
      );
    case "answering": {
      const question = definition.questions.find((candidate) => !(candidate.id in phase.answers));
      if (question === undefined) return <span className="lesson-do" />;
      const numbers = `1–${String(question.options)}`;
      const keys =
        question.previews === "phrases"
          ? `${numbers} choose · Shift + ${numbers} or P plays · P or Esc stops`
          : question.choices === undefined
            ? numbers
            : question.choices.map((choice, index) => `${String(index + 1)} ${choice.label}`).join(", ");
      return (
        <span className="lesson-do">
          {question.caption}
          {wording === "touch" ? null : <span className="lesson-hint">({keys})</span>}
          {controllerConnected ? <span className="lesson-hint">FLX4: turn BROWSE to an answer, press it</span> : null}
        </span>
      );
    }
    case "grading":
      return <span>Checking…</span>;
    case "result":
    case "void":
      return (
        <span className="lesson-do">
          {phase.kind === "result" && phase.result.outcome.kind === "passed" ? "Passed." : "Again?"}
          <span className="lesson-hint">
            <KeyHint k="Enter" /> go · <KeyHint k="P" /> practice
          </span>
        </span>
      );
  }
}

/** On a touchscreen there is no Enter key: the way into the Check (and to restart it) is a button. */
/** R without a keyboard: Ready, while practice or the Check uses it (gain-staging, cue-point). */
function TouchReady({ phase, session, definition }: { readonly phase: LessonPhase; readonly session: LessonSession; readonly definition: ReturnType<typeof lessonDefinition> }) {
  const used = useMemo(() => readyUsedIn(definition, session.track), [definition, session]);
  // The hook may ask for Ready too (tempo-by-ear's second step), where practice uses it.
  if (!(phase.kind === "practice" || phase.kind === "hook" ? used.practice : phase.kind === "check" && used.check)) return null;
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
