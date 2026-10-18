// One Placement task (placement-design §4): the music is already playing when it appears, one caption
// line sits above the controller, and the attempt is the whole task. The Lesson session records and
// grades it; this component owns the engine, the headphones check and the questions, and reports the
// outcome (graded or void) to the Placement.
import { useEffect, useMemo, useRef, useState } from "react";
import { createAudioEngine, describeError, outputLine, type AudioEngine } from "@audio";
import { peakDbfsOf, readyUsedIn, type ControlId, type LessonTrack, type PlacementTaskDefinition, type TaskOutcome } from "@lessons";
import type { LessonId } from "@shared/attempt.ts";
import type { CheckResult, VoidAttempt } from "@shared/check-result.ts";
import { withHeadphonesChecked, type LearnerRecord } from "@shared/learner.ts";
import { currentOutputPlan } from "../audio-output.ts";
import { Controller } from "../controller/Controller.tsx";
import { inputWording, useWording } from "../controller/wording.ts";
import { needsHeadphonesCheck } from "../lesson/headphones-check.ts";
import { HeadphonesGate } from "../lesson/HeadphonesGate.tsx";
import type { LessonHandle } from "../lesson/LessonPlayer.tsx";
import { LessonSession } from "../lesson/lesson-session.ts";
import type { ReadyTrack } from "../lesson/track-loader.ts";
import { placementKey } from "./placement-keys.ts";

type RunPhase = "loading" | "headphones" | "check" | "answering" | "grading" | "failed";

export interface PlacementTaskRunProps {
  readonly definition: PlacementTaskDefinition;
  readonly learner: LearnerRecord;
  /** Lessons counted as passed for the standing criteria: every ancestor, and earlier passes. */
  readonly passedLessons: readonly LessonId[];
  /** The Placement's one track, decoded or synthesised at this sample rate. */
  readonly loadTrack: (sampleRate: number) => Promise<ReadyTrack>;
  readonly onLearnerChange: (record: LearnerRecord) => void;
  readonly onOutcome: (outcome: TaskOutcome) => void;
}

export function PlacementTaskRun({ definition, learner, passedLessons, loadTrack, onLearnerChange, onOutcome }: PlacementTaskRunProps) {
  const [phase, setPhase] = useState<RunPhase>("loading");
  const [setup, setSetup] = useState<{ engine: AudioEngine; session: LessonSession } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Readonly<Record<string, number>>>({});
  const [headphonesGate] = useState(() => needsHeadphonesCheck(definition, learner));
  const learnerRef = useRef(learner);
  const phaseRef = useRef(phase);
  const outcomeRef = useRef(onOutcome);
  const cueLine = useRef<HTMLSpanElement>(null);
  const wording = useWording();
  useEffect(() => {
    learnerRef.current = learner;
    phaseRef.current = phase;
    outcomeRef.current = onOutcome;
  }, [learner, phase, onOutcome]);

  // The engine, the track on its decks, and the session: once per task run.
  useEffect(() => {
    const abort = new AbortController();
    // A function, not the flag itself: the flag changes across the awaits below.
    const cancelled = () => abort.signal.aborted;
    let engine: AudioEngine | null = null;
    let session: LessonSession | null = null;
    void (async () => {
      try {
        const plan = await currentOutputPlan();
        if (cancelled()) return;
        engine = await createAudioEngine({ masterTempo: false, output: { plan, headphones: definition.headphones === true } });
        const ready = await loadTrack(engine.context.sampleRate);
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
            observed: () => undefined,
            audioEnded: () => {
              setPhase(definition.questions.length > 0 ? "answering" : "grading");
            },
            checkFailed: (message) => {
              console.warn(`[placement] ${message}`);
              outcomeRef.current({ kind: "void" });
            },
          },
          withDeckB,
          definition.grading,
        );
        session = created;
        const running = engine;
        window.learnToDjLesson = { engine: running, track, phase: () => handlePhase(phaseRef.current), deckTrack: (deck) => created.deckTrack(deck) } satisfies LessonHandle;
        setSetup({ engine: running, session: created });
      } catch (error) {
        if (cancelled()) return;
        setProblem(`The deck could not start: ${error instanceof Error ? error.message : String(error)}. Press Not yet to go on.`);
        setPhase("failed");
      }
    })();
    return () => {
      abort.abort();
      session?.close();
      delete window.learnToDjLesson;
      engine?.close().catch((error: unknown) => {
        console.warn("[placement] the audio engine did not close cleanly", error);
      });
    };
  }, [definition, loadTrack]);

  // Browsers start audio only after a gesture: the press that started this task was one.
  useEffect(() => {
    const context = setup?.engine.context;
    if (!(context instanceof AudioContext)) return;
    const resume = () => {
      if (context.state !== "running") void context.resume();
    };
    resume();
    window.addEventListener("pointerdown", resume, { capture: true });
    window.addEventListener("keydown", resume, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", resume, { capture: true });
      window.removeEventListener("keydown", resume, { capture: true });
    };
  }, [setup]);

  // The attempt starts with the music, once the deck is ready (and the headphones check passed).
  const [gateOpen, setGateOpen] = useState(headphonesGate);
  useEffect(() => {
    if (setup === null) return;
    // The ear check is for split cue; with the FLX4 or two devices, the cue has its own output.
    const ownCue = setup.engine.output !== null && setup.engine.output.kind !== "split-cue";
    if (gateOpen && !ownCue) {
      setPhase("headphones");
      return;
    }
    setPhase("check");
    setup.session.startCheck();
  }, [setup, gateOpen]);

  // Grading: the same runCheck as a Lesson Check, in Placement mode and short form.
  useEffect(() => {
    if (phase !== "grading" || setup === null) return;
    let cancelled = false;
    void setup.session.grade(answers, passedLessons).then((graded) => {
      if (cancelled) return;
      if (!graded.ok) {
        console.warn(`[placement] ${graded.message}`);
        outcomeRef.current({ kind: "void" });
        return;
      }
      const { outcome } = graded;
      if (!isGraded(outcome)) console.warn(`[placement] the attempt was void (${outcome.outcome.reason}); it is not counted`);
      outcomeRef.current(isGraded(outcome) ? { kind: "graded", result: outcome } : { kind: "void", attempt: outcome });
    });
    return () => {
      cancelled = true;
    };
  }, [phase, setup, answers, passedLessons]);

  // The live caption follows the deck's position (the task's own line when the plan has none).
  useEffect(() => {
    if (setup === null || phase !== "check") return;
    let frame = requestAnimationFrame(function draw() {
      const node = cueLine.current;
      if (node !== null) {
        const text = inputWording(setup.session.checkCue()?.caption ?? definition.caption, wording);
        if (node.textContent !== text) node.textContent = text;
      }
      frame = requestAnimationFrame(draw);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [setup, phase, definition, wording]);

  const question = definition.questions.find((candidate) => !(candidate.id in answers));
  const answer = (value: number) => {
    if (question === undefined || value > question.options) return;
    const next = { ...answers, [question.id]: value };
    setAnswers(next);
    if (definition.questions.every((candidate) => candidate.id in next)) setPhase("grading");
  };

  // R = Ready (the cue-point task), 1–4 = answers. N and Esc are the Placement's.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const key = placementKey(event, phase === "answering" ? "answering" : "task");
      if (key?.kind === "ready") setup?.session.ready();
      if (key?.kind === "answer") answer(key.value);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  });

  const unlocks = useMemo<ReadonlySet<ControlId>>(() => new Set(definition.controls), [definition]);
  const readyButton = setup !== null && phase === "check" && wording === "touch" && readyUsedIn(definition, setup.session.track).check;

  return (
    <>
      <div className="lesson-stage">
        <p className="lesson-caption" role="status" aria-live="polite" aria-label="Placement caption">
          {phase === "check" ? (
            <span className="lesson-do" data-testid="check-cue">
              <span ref={cueLine} className="lesson-cue" data-checkpoint="false">
                {inputWording(definition.caption, wording)}
              </span>
            </span>
          ) : (
            <span className="lesson-do">{captionFor(phase, definition, question?.caption, problem)}</span>
          )}
        </p>
        {readyButton ? (
          <button
            type="button"
            className="btn btn-primary lesson-touch-go"
            onClick={() => {
              setup.session.ready();
            }}
          >
            Ready
          </button>
        ) : null}
      </div>
      <div className="lesson-board">
        {phase === "answering" && question !== undefined ? (
          <section className="lesson-questions lesson-overlay" aria-label="Questions">
            <div className="lesson-question">
              <span>{question.caption}</span>
              <div role="group" aria-label={question.caption}>
                {Array.from({ length: question.options }, (_, index) => index + 1).map((option) => (
                  <button
                    key={option}
                    type="button"
                    className="btn"
                    onClick={() => {
                      answer(option);
                    }}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>
          </section>
        ) : null}
        {phase === "headphones" && setup !== null ? (
          <HeadphonesGate
            context={setup.engine.context}
            onPassed={() => {
              onLearnerChange(withHeadphonesChecked(learnerRef.current, new Date().toISOString()));
              setGateOpen(false);
            }}
          />
        ) : null}
        {setup === null ? null : (
          <Controller engine={setup.engine} unlocks={unlocks} outputLine={setup.engine.output === null ? null : outputLine(setup.engine.output, definition.headphones === true)} />
        )}
      </div>
    </>
  );
}

function isGraded(outcome: CheckResult | VoidAttempt): outcome is CheckResult {
  return outcome.outcome.kind !== "void";
}

function captionFor(phase: RunPhase, definition: PlacementTaskDefinition, question: string | undefined, problem: string | null): string {
  switch (phase) {
    case "loading":
      return "Getting the decks ready…";
    case "headphones":
      return "Headphones check first";
    case "answering":
      return `${question ?? ""} (1–4)`;
    case "grading":
      return "Checking…";
    case "failed":
      return problem ?? "The deck could not start.";
    case "check":
      return definition.caption;
  }
}

/** The phase as the Lesson handle names it, for the end-to-end tests. */
function handlePhase(phase: RunPhase): ReturnType<LessonHandle["phase"]> {
  if (phase === "headphones") return "loading";
  return phase === "failed" ? "unavailable" : phase;
}
