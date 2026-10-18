// Lesson 20, "Your first set": build a set, warm up on its first transition, play it by ear while
// the master is recorded, then see the Check and keep the recording as the final project. The Lesson
// player (src/app/lesson) runs Lessons 1–19, which each have one fixed track and plan; a set has the
// Learner's own tracks and its own session (set-session.ts).
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createAudioEngine, SplitCueMonitor, type AudioEngine } from "@audio";
import { applyCheckResult } from "@checks";
import { FINAL_MIX, finalMixMode, gradedLine, setEntry, setNotesText, type LessonTrack } from "@lessons";
import type { LessonId } from "@shared/attempt.ts";
import type { CheckResult } from "@shared/check-result.ts";
import { withFinalProject, withRekordboxChoice, withSkillProfile, type FinalProject, type RekordboxCardChoice, type LearnerRecord } from "@shared/learner.ts";
import { ALL_CONTROL_IDS, Controller, inputWording, useWording, type ControlId } from "../controller/index.ts";
import type { TrackPreference } from "../lesson/track-loader.ts";
import type { SaveStatus } from "../save-queue.ts";
import { keepFinalProjectAudio } from "./api.ts";
import { listLibrary, type Library, type LibraryItem } from "./library.ts";
import { SetBuilder, type PickedTrack } from "./SetBuilder.tsx";
import { FinalProjectDownloads } from "./FinalProjectDownloads.tsx";
import { RekordboxCard } from "../rekordbox/RekordboxCard.tsx";
import { lessonCardFor } from "../rekordbox/rekordbox-steps.ts";
import { SetResult, type KeepStatus } from "./SetResult.tsx";
import { SetSession, type GradedSet } from "./set-session.ts";
import "../lesson/lesson.css";
import "./final-mix.css";

export interface FinalMixPlayerProps {
  readonly learner: LearnerRecord;
  readonly onLearnerChange: (record: LearnerRecord) => void;
  readonly saveStatus: SaveStatus;
  readonly trackPreference: TrackPreference;
  readonly onExit: () => void;
}

type Phase =
  | { readonly kind: "starting"; readonly status: string }
  | { readonly kind: "build" }
  | { readonly kind: "loading" }
  | { readonly kind: "warm-up" }
  | { readonly kind: "set" }
  | { readonly kind: "grading"; readonly timedOut: boolean }
  | { readonly kind: "result"; readonly graded: GradedSet }
  | { readonly kind: "failed"; readonly message: string };

/** Everything after Lesson 20 is on the controller (catalogue §1), minus the exam's covered aids and the Lesson tap key. */
const SET_UNLOCKS: ReadonlySet<ControlId> = new Set(ALL_CONTROL_IDS.filter((id) => id !== "tap" && !FINAL_MIX.lockedOff.includes(id)));

/** What end-to-end tests read, like the Lesson player's handle (window.learnToDjLesson). */
interface SetHandle {
  readonly engine: AudioEngine;
  readonly track: LessonTrack;
  readonly phase: () => string;
  readonly deckTrack: (deck: "A" | "B") => LessonTrack | null;
}

function passedLessons(learner: LearnerRecord): LessonId[] {
  return Object.values(learner.skillProfile.lessons).flatMap((record) => (record.passedAt != null ? [record.lessonId] : []));
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

export function FinalMixPlayer({ learner, onLearnerChange, trackPreference, onExit }: FinalMixPlayerProps) {
  const [phase, setPhase] = useState<Phase>({ kind: "starting", status: "Getting the decks ready…" });
  const [engine, setEngine] = useState<AudioEngine | null>(null);
  const [library, setLibrary] = useState<Library | null>(null);
  const [items, setItems] = useState<readonly LibraryItem[]>([]);
  const [picked, setPicked] = useState<readonly PickedTrack[]>([]);
  const [preparing, setPreparing] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [session, setSession] = useState<SetSession | null>(null);
  const [keep, setKeep] = useState<KeepStatus>({ kind: "idle" });
  /** The attempt whose rekordbox card was answered here, so it hides until the next result. */
  const [rekordboxAnsweredFor, setRekordboxAnsweredFor] = useState<string | null>(null);
  const [warmStep, setWarmStep] = useState(0);
  const learnerRef = useRef(learner);
  const phaseRef = useRef(phase.kind);
  const abort = useRef(new AbortController());
  const wording = useWording();
  useEffect(() => {
    learnerRef.current = learner;
    phaseRef.current = phase.kind;
  }, [learner, phase.kind]);

  // The engine and the library, once per visit.
  useEffect(() => {
    const controller = new AbortController();
    abort.current = controller;
    let created: AudioEngine | null = null;
    let closed = false;
    // A function, not the flag: it changes across the awaits below.
    const cancelled = () => controller.signal.aborted;
    const close = () => {
      if (created === null || closed) return;
      closed = true;
      created.close().catch((error: unknown) => {
        console.warn("[set] the audio engine did not close cleanly", error);
      });
    };
    void (async () => {
      try {
        created = await createAudioEngine({ masterTempo: true, monitor: new SplitCueMonitor() });
        if (cancelled()) return;
        setPhase({ kind: "starting", status: "Opening your library…" });
        const listed = await listLibrary(trackPreference, created.context.sampleRate, controller.signal);
        if (cancelled()) return;
        setEngine(created);
        setLibrary(listed);
        setItems(listed.items);
        setPhase({ kind: "build" });
      } catch (error) {
        if (!cancelled()) setPhase({ kind: "failed", message: `The decks could not start: ${error instanceof Error ? error.message : String(error)}. Reload to try again.` });
      } finally {
        if (cancelled()) close();
      }
    })();
    return () => {
      controller.abort();
      close();
    };
  }, [trackPreference]);

  // Audio starts only after a gesture.
  useEffect(() => {
    const context = engine?.context;
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
  }, [engine]);

  useEffect(() => () => session?.close(), [session]);

  const tick = useSyncExternalStore(
    useCallback((listener: () => void) => session?.subscribe(listener) ?? (() => undefined), [session]),
    () => (session === null ? "none" : `${session.current().kind}:${String(session.playedTracks().length)}:${String(session.isLoading())}`),
  );

  // End-to-end tests read the engine and the tracks on the decks.
  useEffect(() => {
    if (engine === null || session === null) return;
    const deckTrack = (deck: "A" | "B") => {
      const played = session.playedTracks().findLast((track) => track.deck === deck);
      return played === undefined ? null : played.entry.candidate.track;
    };
    const first = session.playedTracks()[0]?.entry.candidate.track;
    if (first === undefined) return;
    const handle: SetHandle = { engine, track: first, phase: () => phaseRef.current, deckTrack };
    (window as { learnToDjLesson?: unknown }).learnToDjLesson = handle;
    return () => {
      delete (window as { learnToDjLesson?: unknown }).learnToDjLesson;
    };
  }, [engine, session, tick]);

  const addItem = useCallback(
    (item: LibraryItem) => {
      if (engine === null) return;
      setProblem(null);
      setPreparing(`Getting "${item.title}" ready…`);
      void item.prepare({ sampleRate: engine.context.sampleRate, signal: abort.current.signal, onStatus: setPreparing }).then((result) => {
        setPreparing(null);
        if (!result.ok) {
          setProblem(result.message);
          return;
        }
        setPicked((current) => [...current, { key: item.key, entry: setEntry(result.prepared.candidate), prepared: result.prepared }]);
      });
    },
    [engine],
  );

  const loadSet = useCallback(() => {
    if (engine === null) return;
    const created = new SetSession(engine, picked.map(({ entry, prepared }) => ({ entry, prepared })), learnerRef.current.learnerId, () => {
      setPhase((current) => (current.kind === "set" ? { kind: "grading", timedOut: true } : current));
    });
    setPhase({ kind: "loading" });
    setWarmStep(0);
    void created.warmUp(abort.current.signal).then(
      () => {
        setSession(created);
        setPhase({ kind: "warm-up" });
      },
      (error: unknown) => {
        created.close();
        setProblem(`The set could not load: ${error instanceof Error ? error.message : String(error)}`);
        setPhase({ kind: "build" });
      },
    );
  }, [engine, picked]);

  // The warm-up captions follow what the Learner does: Play A, CUE B, Play B.
  useEffect(() => {
    if (engine === null || phase.kind !== "warm-up") return;
    return engine.on("command", (event) => {
      if (event.rejected !== null || event.device === "engine") return;
      const { command } = event;
      setWarmStep((step) => {
        if (step === 0 && command.control === "play" && command.deck === "A") return 1;
        if (step === 1 && command.control === "headphone-cue" && command.deck === "B") return 2;
        if (step === 2 && command.control === "play" && command.deck === "B") return 3;
        return step;
      });
    });
  }, [engine, phase.kind]);

  const startSet = useCallback(() => {
    if (session === null) return;
    const started = session.startSet();
    if (!started.ok) {
      setProblem(started.message);
      return;
    }
    setPhase({ kind: "set" });
  }, [session]);

  const endSet = useCallback(() => {
    setPhase((current) => (current.kind === "set" ? { kind: "grading", timedOut: false } : current));
  }, []);

  // Grading: stop both recordings, run the Check, write the Skill profile.
  const gradingTimedOut = phase.kind === "grading" ? phase.timedOut : null;
  useEffect(() => {
    if (gradingTimedOut === null || session === null) return;
    const before = learnerRef.current;
    void session.end({ passedLessons: passedLessons(before), mode: finalMixMode(before.skillProfile), timedOut: gradingTimedOut }).then((graded) => {
      if ("error" in graded) {
        setPhase({ kind: "failed", message: graded.error });
        return;
      }
      if (graded.outcome.outcome.kind !== "void") {
        const update = applyCheckResult(before.skillProfile, graded.outcome as CheckResult);
        const written = withSkillProfile(before, update.profile);
        if (written.ok) onLearnerChange(written.record);
        else console.warn("[set] the Skill profile refused the graded set", written.issues);
      }
      setKeep({ kind: "idle" });
      // The recorded set, for end-to-end tests that explain a failed Check.
      (window as { learnToDjSet?: unknown }).learnToDjSet = { attempt: graded.attempt, transitions: graded.transitions };
      setPhase({ kind: "result", graded });
    });
  }, [gradingTimedOut, session, onLearnerChange]);

  // Keys: Enter starts the set from the warm-up; Escape leaves.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return;
      if (event.code === "Escape") onExit();
      if (event.code === "Enter" && phaseRef.current === "warm-up") {
        event.preventDefault();
        startSet();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [onExit, startSet]);

  const result = phase.kind === "result" ? phase.graded : null;
  const titles = useMemo(
    () => new Map((result?.played ?? []).map(({ entry }) => [entry.candidate.track.trackId, entry.candidate.track.title] as const)),
    [result],
  );
  const notes = useMemo(() => {
    if (result === null) return "";
    const title = (id: string) => titles.get(id) ?? id;
    return setNotesText({
      title: "My set, made with learn-to-dj",
      recordedAt: result.attempt.startedAt,
      tracks: result.played.map(({ entry }) => ({ title: entry.candidate.track.title, artist: entry.candidate.artist, bpm: entry.candidate.track.grid.bpm, credit: entry.candidate.track.attribution.text })),
      transitions: result.transitions.map((transition) => ({ ...transition, from: title(transition.fromTrackId), to: title(transition.toTrackId) })),
      result: result.outcome.outcome.kind === "void" ? { outcome: { kind: "failed", failedCriteria: [] } } : (result.outcome as CheckResult),
    });
  }, [result, titles]);

  const rekordboxCard = phase.kind === "result" ? lessonCardFor("final-mix", phase.graded.outcome.outcome.kind === "passed", learner) : null;
  const answeredAttempt = phase.kind === "result" ? phase.graded.outcome.attemptId : null;
  const answerRekordbox = useCallback(
    (choice: RekordboxCardChoice["choice"]) => {
      setRekordboxAnsweredFor(answeredAttempt);
      onLearnerChange(withRekordboxChoice(learnerRef.current, "final-mix", choice, new Date().toISOString()));
    },
    [answeredAttempt, onLearnerChange],
  );

  const keepProject = useCallback(() => {
    if (result?.recording == null) return;
    const { recording, outcome } = result;
    setKeep({ kind: "saving" });
    const title = (id: string) => titles.get(id) ?? id;
    void keepFinalProjectAudio(learnerRef.current.learnerId, recording).then((kept) => {
      if (!kept.ok) {
        setKeep({ kind: "failed", message: kept.message });
        return;
      }
      const passed = outcome.outcome.kind === "passed";
      const project: FinalProject = {
        attemptId: outcome.attemptId,
        recordedAt: outcome.startedAt,
        mode: outcome.mode,
        outcome: passed ? "passed" : "failed",
        band: outcome.outcome.kind === "passed" ? (outcome.outcome.bands?.overall ?? null) : null,
        durationSec: recording.durationSec,
        audio: { mimeType: recording.mimeType, bytes: recording.blob.size },
        tracks: result.played.map(({ entry }) => ({
          title: entry.candidate.track.title.slice(0, 300),
          artist: entry.candidate.artist.slice(0, 300),
          bpm: entry.candidate.track.grid.bpm,
          credit: entry.candidate.track.attribution.text.slice(0, 300),
          shareable: entry.candidate.shareable,
        })),
        transitions: result.transitions.map((transition) => ({
          number: transition.number,
          from: title(transition.fromTrackId).slice(0, 300),
          to: title(transition.toTrackId).slice(0, 300),
          kind: transition.kind,
          met: transition.met,
          phraseBeats: transition.phraseBeats,
          levelDb: transition.levelDb,
          phaseHold: transition.phaseHold,
        })),
      };
      const written = withFinalProject(learnerRef.current, project);
      if (!written.ok) {
        setKeep({ kind: "failed", message: `The final project's notes were refused: ${written.issues.join("; ")}` });
        return;
      }
      onLearnerChange(written.record);
      setKeep({ kind: "kept" });
    });
  }, [result, titles, onLearnerChange]);

  const again = useCallback(() => {
    session?.close();
    setSession(null);
    setPhase({ kind: "build" });
  }, [session]);

  const caption = (() => {
    switch (phase.kind) {
      case "starting":
        return phase.status;
      case "build":
        return "Build your set: 3 or more tracks of one genre";
      case "loading":
        return "Loading tracks 1 and 2…";
      case "warm-up":
        return FINAL_MIX.warmUp[warmStep]?.caption ?? "Warmed up. Cue track 1 where you want to start, then start the set (Enter)";
      case "set":
        return FINAL_MIX.checkCaption;
      case "grading":
        return "Checking your set…";
      case "result":
        return "Your set";
      case "failed":
        return phase.message;
    }
  })();

  const onStage = phase.kind === "warm-up" || phase.kind === "set";
  // "Graded: …": every criterion the set can fail on, before it starts and while it runs.
  const graded = useMemo(() => gradedLine({ id: FINAL_MIX.id }, passedLessons(learner)), [learner]);
  const next = session?.nextTrack() ?? null;
  return (
    <main className="lesson final-mix" data-phase={phase.kind} data-input={wording}>
      <header className="lesson-bar">
        <button type="button" className="btn btn-quiet lesson-back" onClick={onExit}>
          ← Lessons <kbd>Esc</kbd>
        </button>
        <h1>{FINAL_MIX.title}</h1>
      </header>

      <div className="lesson-stage">
        <p className="lesson-caption" role="status" aria-live="polite" aria-label="Lesson caption">
          <span className="lesson-do">
            {inputWording(caption, wording)}
            {onStage ? (
              <span className="lesson-graded" data-testid="graded-line">
                {graded}
              </span>
            ) : null}
          </span>
        </p>
        {phase.kind === "warm-up" ? (
          <button type="button" className="btn btn-primary set-go" onClick={startSet}>
            Start the set
          </button>
        ) : null}
        {phase.kind === "set" && session !== null ? (
          <div className="set-controls" data-tick={tick}>
            {next === null ? (
              <span className="set-next">Last track playing</span>
            ) : (
              <button
                type="button"
                className="btn set-go"
                disabled={!session.canLoadNext()}
                onClick={() => {
                  void session.loadNext(abort.current.signal).then((loaded) => {
                    setProblem(loaded.ok ? null : loaded.message);
                  });
                }}
              >
                {session.isLoading() ? "Loading…" : `Load "${next.entry.candidate.track.title}" onto deck ${session.freeDeck()}`}
              </button>
            )}
            <button type="button" className="btn btn-primary set-go" onClick={endSet}>
              End set
            </button>
          </div>
        ) : null}
        {problem !== null && phase.kind !== "build" ? (
          <p className="lesson-problem" role="alert">
            {problem}
          </p>
        ) : null}
      </div>

      <div className="lesson-board">
        {phase.kind === "build" && learner.finalProject !== undefined ? (
          <section className="set-kept" aria-label="Your final project">
            <h2>Your final project</h2>
            <FinalProjectDownloads learnerId={learner.learnerId} project={learner.finalProject} />
          </section>
        ) : null}
        {phase.kind === "build" && library !== null ? (
          <SetBuilder
            library={{ ...library, items }}
            picked={picked}
            preparing={preparing}
            problem={problem}
            onAdd={addItem}
            onFiles={(files) => {
              const added = library.addFiles(files);
              setItems((current) => [...added, ...current.filter((item) => !added.some((each) => each.key === item.key))]);
            }}
            onChange={setPicked}
            onStart={loadSet}
          />
        ) : null}
        {phase.kind === "result" ? (
          <SetResult
            outcome={phase.graded.outcome}
            transitions={phase.graded.transitions}
            titles={titles}
            recording={phase.graded.recording}
            recordingProblem={phase.graded.recordingProblem}
            notes={notes}
            label={phase.graded.outcome.mode === "cold" ? "Final project" : "Rehearsal"}
            keep={keep}
            onKeep={keepProject}
            downloads={learner.finalProject === undefined ? null : <FinalProjectDownloads learnerId={learner.learnerId} project={learner.finalProject} />}
            onAgain={again}
            onExit={onExit}
          />
        ) : null}
        {phase.kind === "result" && rekordboxCard !== null && rekordboxAnsweredFor !== phase.graded.outcome.attemptId ? (
          <RekordboxCard card={rekordboxCard} onChoose={answerRekordbox} />
        ) : null}
        {onStage && engine !== null ? <Controller engine={engine} unlocks={SET_UNLOCKS} pulse={phase.kind === "warm-up" ? (FINAL_MIX.warmUp[warmStep]?.control ?? null) : null} /> : null}
      </div>
    </main>
  );
}
