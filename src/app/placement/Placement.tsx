// Placement end to end (docs/placement-design.md): the Mission, then the skip-group tasks hardest
// first with narrowing on failure, a plain ✓ / "Not yet" card after each, and the Summary with Start.
// The pure rules (which task next, what is credited) are in src/lessons/placement.ts; this component
// owns the clock, the track and the screens.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ancestorsOf,
  applyPlacement,
  creditedLessons,
  describeCriterion,
  isBuiltLesson,
  nextStep,
  placementTask,
  placementTrackProblems,
  startLesson,
  withTaskOutcome,
  type BuiltLessonId,
  type PlacementTask,
  type TaskOutcome,
} from "@lessons";
import { LESSON_IDS, catalogueIndex, lessonById, type LessonId } from "@shared/catalogue.ts";
import type { CheckResult, CriterionResult } from "@shared/check-result.ts";
import type { LearnerRecord } from "@shared/learner.ts";
import { MISSION_MAX_CHARS } from "@shared/mission.ts";
import type { PlacementEndReason, PlacementResult, PlacementTaskRecord } from "@shared/placement.ts";
import { useWording } from "../controller/wording.ts";
import { loadLessonTrack, type ReadyTrack, type TrackPreference } from "../lesson/track-loader.ts";
import { placementKey } from "./placement-keys.ts";
import { PlacementTaskRun } from "./PlacementTaskRun.tsx";
import "../lesson/lesson.css";
import "../lesson/lesson-extras.css";
import "./placement.css";

/** K2's footnote, verbatim (coach-design K2, placement-design §2). */
export const MISSION_FOOTNOTE = "* Sent to Anthropic's API so the Coach can tailor your optional Lessons. Nothing else you type, and no audio, leaves this device.";

export interface PlacementProps {
  readonly learner: LearnerRecord;
  readonly run: PlacementResult["run"];
  readonly trackPreference: TrackPreference;
  readonly onLearnerChange: (record: LearnerRecord) => void;
  /** The finished run and its graded attempts: the app writes the record and asks the Coach. */
  readonly onFinish: (result: PlacementResult, graded: readonly CheckResult[]) => void;
  /** Start: the Lesson to open, or null for the Lesson list. */
  readonly onDone: (lessonId: BuiltLessonId | null) => void;
}

type Screen =
  | { readonly kind: "mission" }
  /** `number`: the task's place in this run, from 1. */
  | { readonly kind: "task"; readonly task: PlacementTask; readonly voidRuns: 0 | 1; readonly run: number; readonly number: number }
  | { readonly kind: "card"; readonly record: PlacementTaskRecord; readonly check: CheckResult | null; readonly passLine: string; readonly number: number }
  | { readonly kind: "summary"; readonly result: PlacementResult; readonly graded: readonly CheckResult[] };

const nowIso = () => new Date().toISOString();

/** The criterion with the worst margin among those that blocked the pass. */
function worstCriterion(check: CheckResult): CriterionResult | null {
  const failed = check.criteria.filter((criterion) => criterion.status === "notMet" && criterion.severity === "fail");
  return [...failed].sort((a, b) => (a.margin ?? Number.NEGATIVE_INFINITY) - (b.margin ?? Number.NEGATIVE_INFINITY))[0] ?? null;
}

export function Placement({ learner, run, trackPreference, onLearnerChange, onFinish, onDone }: PlacementProps) {
  const [screen, setScreen] = useState<Screen>({ kind: "mission" });
  const [mission, setMission] = useState(learner.mission);
  // The profile before this Placement: Lessons already passed count as credited and are never re-tested.
  const [profileBefore] = useState(() => learner.skillProfile);
  const result = useRef<PlacementResult | null>(null);
  const graded = useRef<CheckResult[]>([]);
  const startedMs = useRef(0);
  const wording = useWording();

  // One track for the whole run, per sample rate (every engine on a device shares one).
  const abort = useMemo(() => new AbortController(), []);
  useEffect(() => () => {
    abort.abort();
  }, [abort]);
  const tracks = useRef(new Map<number, Promise<ReadyTrack>>());
  const loadTrack = useCallback(
    (sampleRate: number) => {
      const cached = tracks.current.get(sampleRate);
      if (cached !== undefined) return cached;
      // Every task must run on it: the phrases task needs a named drop, the mixing tasks 6 phrases.
      const definition = { ...placementTask("phrases"), trackProblems: placementTrackProblems };
      const loading = loadLessonTrack(definition, { preference: trackPreference, signal: abort.signal, sampleRate, onStatus: () => undefined });
      tracks.current.set(sampleRate, loading);
      return loading;
    },
    [abort, trackPreference],
  );

  const finish = useCallback(
    (reason: PlacementEndReason) => {
      const current = result.current;
      if (current === null) return;
      const final: PlacementResult = { ...current, endedAt: nowIso(), endReason: reason };
      result.current = final;
      onFinish(final, graded.current);
      setScreen({ kind: "summary", result: final, graded: graded.current });
    },
    [onFinish],
  );

  const goOn = useCallback(
    (runNumber: number) => {
      const current = result.current;
      if (current === null) return;
      const step = nextStep(current, profileBefore, (performance.now() - startedMs.current) / 1000);
      if (step.kind === "end") finish(step.reason);
      else setScreen({ kind: "task", task: step.task, voidRuns: 0, run: runNumber + 1, number: current.tasks.length + 1 });
    },
    [finish, profileBefore],
  );

  const begin = useCallback(
    (skip: boolean) => {
      const at = nowIso();
      result.current = {
        schemaVersion: 1,
        placementId: crypto.randomUUID(),
        learnerId: learner.learnerId,
        run,
        startedAt: at,
        endedAt: at,
        endReason: "noTaskLeft",
        mission: mission.trim().slice(0, MISSION_MAX_CHARS),
        tasks: [],
      };
      startedMs.current = performance.now();
      if (skip) finish("skippedAtMission");
      else goOn(0);
    },
    [finish, goOn, learner.learnerId, mission, run],
  );

  const runNumber = screen.kind === "task" ? screen.run : 0;
  const onOutcome = useCallback(
    (outcome: TaskOutcome) => {
      if (screen.kind !== "task" || result.current === null) return;
      const next = withTaskOutcome(result.current, screen.task, outcome, screen.voidRuns);
      if (next.rerun) {
        // A void (a hidden tab, a suspended context): the same task once more, without a card.
        setScreen({ ...screen, voidRuns: 1, run: screen.run + 1 });
        return;
      }
      result.current = next.result;
      const record = next.result.tasks.at(-1);
      if (outcome.kind === "graded") graded.current = [...graded.current, outcome.result];
      if (record !== undefined && outcome.kind === "graded") setScreen({ kind: "card", record, check: outcome.result, passLine: placementTask(screen.task.lessonId).passLine, number: screen.number });
      else goOn(screen.run);
    },
    [goOn, screen],
  );

  const skipRest = useCallback(() => {
    finish("skippedRest");
  }, [finish]);

  const startDestination = useMemo(() => {
    if (screen.kind !== "summary") return null;
    return startLesson(applyPlacement(profileBefore, screen.result, screen.graded));
  }, [screen, profileBefore]);
  const start = useCallback(() => {
    onDone(startDestination !== null && isBuiltLesson(startDestination) ? startDestination : null);
  }, [onDone, startDestination]);

  // Placement keys on every screen; the mission's text box handles its own Enter and Esc.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (screen.kind === "mission") return;
      const key = placementKey(event, screen.kind === "task" ? "task" : screen.kind);
      if (key === null) return;
      if (key.kind === "skip" && screen.kind !== "summary") {
        event.preventDefault();
        skipRest();
      } else if (key.kind === "notYet" && screen.kind === "task") onOutcome({ kind: "notYet" });
      else if (key.kind === "next" && screen.kind === "card") {
        event.preventDefault();
        goOn(runNumber);
      } else if (key.kind === "go" && screen.kind === "summary") {
        event.preventDefault();
        start();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [screen, skipRest, onOutcome, goOn, runNumber, start]);

  if (screen.kind === "mission") {
    return <MissionScreen mission={mission} onMission={setMission} onGo={() => { begin(false); }} onSkip={() => { begin(true); }} retake={run === "retake"} />;
  }

  if (screen.kind === "summary") {
    const credited = creditedLessons(screen.result);
    return <SummaryScreen credited={credited} startAt={startDestination ?? "deck-basics"} onStart={start} onList={() => { onDone(null); }} />;
  }

  return (
    <main className="lesson placement" data-phase={screen.kind} data-task={screen.kind === "task" ? screen.task.lessonId : undefined} data-input={wording}>
      <header className="lesson-bar">
        <button type="button" className="btn btn-quiet lesson-back" onClick={skipRest}>
          Skip the rest <kbd>Esc</kbd>
        </button>
        <h1>
          Show me what you can do <span className="placement-count">{String(screen.number)}</span>
        </h1>
        {screen.kind === "task" ? (
          <button
            type="button"
            className="btn placement-not-yet"
            onClick={() => {
              onOutcome({ kind: "notYet" });
            }}
          >
            Not yet <kbd>N</kbd>
          </button>
        ) : null}
      </header>
      {screen.kind === "task" ? (
        <PlacementTaskRun
          key={`${screen.task.lessonId}-${String(screen.run)}`}
          definition={placementTask(screen.task.lessonId)}
          learner={learner}
          passedLessons={passedFor(screen.task.lessonId, profileBefore)}
          loadTrack={loadTrack}
          onLearnerChange={onLearnerChange}
          onOutcome={onOutcome}
        />
      ) : (
        <TaskCard
          record={screen.record}
          check={screen.check}
          passLine={screen.passLine}
          onNext={() => {
            goOn(runNumber);
          }}
        />
      )}
    </main>
  );
}

/** Standing criteria apply as if every credited ancestor were passed, plus everything passed before (§4.1). */
function passedFor(lessonId: LessonId, profileBefore: LearnerRecord["skillProfile"]): LessonId[] {
  const passed = new Set([...ancestorsOf(lessonId), ...LESSON_IDS.filter((id) => profileBefore.lessons[id]?.passedAt != null)]);
  return LESSON_IDS.filter((id) => passed.has(id) && id !== lessonId);
}

interface MissionScreenProps {
  readonly mission: string;
  readonly onMission: (mission: string) => void;
  readonly onGo: () => void;
  readonly onSkip: () => void;
  readonly retake: boolean;
}

function MissionScreen({ mission, onMission, onGo, onSkip, retake }: MissionScreenProps) {
  return (
    <main className="placement-page placement-mission">
      <h1>{retake ? "Show me again" : "Learn to DJ"}</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onGo();
        }}
      >
        <label htmlFor="mission">
          Why do you want to DJ?<sup>*</sup>
        </label>
        <input
          id="mission"
          type="text"
          autoFocus
          maxLength={MISSION_MAX_CHARS}
          placeholder="e.g. post my own mixes to SoundCloud"
          value={mission}
          onChange={(event) => {
            onMission(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onSkip();
            }
          }}
        />
        <p className="placement-footnote">{MISSION_FOOTNOTE}</p>
        <div className="placement-actions">
          <button type="submit" className="btn btn-primary">
            Show me what you can do <kbd>Enter</kbd>
          </button>
          <button type="button" className="btn btn-quiet" onClick={onSkip}>
            Start at Lesson 1 <kbd>Esc</kbd>
          </button>
        </div>
      </form>
    </main>
  );
}


function TaskCard({ record, check, passLine, onNext }: { readonly record: PlacementTaskRecord; readonly check: CheckResult | null; readonly passLine: string; readonly onNext: () => void }) {
  const passed = record.outcome === "passed";
  const worst = check === null || passed ? null : worstCriterion(check);
  const wording = useWording();
  return (
    <div className="lesson-board">
      <section
        className={`result-card placement-card ${passed ? "passed" : "failed"}`}
        aria-label="Result"
        data-outcome={record.outcome}
        onClick={onNext}
      >
        <h2>{passed ? "✓" : "Not yet"}</h2>
        <p>{passed ? passLine : "That one's in the Lessons"}</p>
        {worst === null ? null : <p className="placement-worst">{describeCriterion(worst)}</p>}
        <button type="button" className="btn btn-primary" autoFocus onClick={onNext}>
          Next {wording === "touch" ? null : <kbd>any key</kbd>}
        </button>
      </section>
    </div>
  );
}

interface SummaryScreenProps {
  readonly credited: readonly LessonId[];
  readonly startAt: LessonId;
  readonly onStart: () => void;
  readonly onList: () => void;
}

function SummaryScreen({ credited, startAt, onStart, onList }: SummaryScreenProps) {
  const number = catalogueIndex(startAt) + 1;
  const built = isBuiltLesson(startAt);
  return (
    <main className="placement-page placement-summary" aria-label="Placement summary">
      <h1>{credited.length === 0 ? "Start from the top" : `${String(credited.length)} ${credited.length === 1 ? "Lesson" : "Lessons"} done already`}</h1>
      {credited.length === 0 ? null : (
        <ul className="placement-credited" aria-label="Credited">
          {credited.map((id) => (
            <li key={id}>✓ {lessonById(id).title}</li>
          ))}
        </ul>
      )}
      <p className="placement-start" data-start={startAt}>
        Next: Lesson {number} · {lessonById(startAt).title}
        {built ? null : <span className="placement-soon"> (coming soon)</span>}
      </p>
      <div className="placement-actions">
        <button type="button" className="btn btn-primary" autoFocus onClick={onStart}>
          {built ? `Start Lesson ${String(number)}` : "See your Lessons"} <kbd>Enter</kbd>
        </button>
        {built ? (
          <button type="button" className="btn btn-quiet" onClick={onList}>
            All Lessons
          </button>
        ) : null}
      </div>
    </main>
  );
}
