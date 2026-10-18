import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { curriculumRequest, isBuiltLesson, placementCurriculumRequest, withCurriculum, withPlacement, type BuiltLessonId, type CourseLessonId } from "@lessons";
import type { CheckResult } from "@shared/check-result.ts";
import type { PlacementResult } from "@shared/placement.ts";
import { DEFAULT_LEARNER_ID, emptyLearnerRecord, LearnerIdSchema, type LearnerId, type LearnerRecord } from "@shared/learner.ts";
import { midiConnection } from "@midi";
import { HealthIndicator } from "./HealthIndicator.tsx";
import { loadLearner, requestCurriculum, saveLearner } from "./lesson/api-client.ts";
import { LessonList } from "./lesson/LessonList.tsx";
import type { TrackPreference } from "./lesson/track-loader.ts";
import { sysexChosen } from "./midi-sysex.ts";
import { SaveQueue, type SaveStatus } from "./save-queue.ts";

// The dev playground and the Lesson player load the audio engine and the controller: separate chunks.
const Playground = lazy(() => import("./playground/Playground.tsx").then((module) => ({ default: module.Playground })));
const LessonPlayer = lazy(() => import("./lesson/LessonPlayer.tsx").then((module) => ({ default: module.LessonPlayer })));
// The Originals player is its own small page, and its own chunk.
const Placement = lazy(() => import("./placement/Placement.tsx").then((module) => ({ default: module.Placement })));
// Lesson 20, the set: its own player (set builder, recording), and its own chunk.
const FinalMixPlayer = lazy(() => import("./final-mix/FinalMixPlayer.tsx").then((module) => ({ default: module.FinalMixPlayer })));
const ControllerPage = lazy(() => import("./controller-page/ControllerPage.tsx").then((module) => ({ default: module.ControllerPage })));
const OriginalsPlayer = lazy(() => import("./originals/OriginalsPlayer.tsx").then((module) => ({ default: module.OriginalsPlayer })));

export const PLAYGROUND_PATH = "/playground";
/** The player for the generator's Originals: it needs no Learner. */
export const ORIGINALS_PAGE_PATH = "/originals";

export function isOriginalsPage(pathname: string): boolean {
  return pathname.replace(/\/$/, "") === ORIGINALS_PAGE_PATH;
}

/**
 * The playground is a developer tool: on the dev server (including the owner's tunnel) it is always
 * there; in a production build it needs an explicit `?playground` flag (the end-to-end tests use it).
 */
export function playgroundEnabled(location: { pathname: string; search: string }, devServer: boolean): boolean {
  if (location.pathname.replace(/\/$/, "") !== PLAYGROUND_PATH) return false;
  return devServer || new URLSearchParams(location.search).has("playground");
}
const LESSON_PATH = /^\/lesson\/([a-z-]+)$/;
/** Lesson 20 has its own player. */
const FINAL_MIX_PATH = "/lesson/final-mix";
/** The hardware page: the DDJ-FLX4's connection, a MIDI monitor, a controls checklist and the sound output. */
export const CONTROLLER_PAGE_PATH = "/controller";
/** Re-taking Placement, from the Lesson list. A first run (no profile yet) shows it at "/". */
export const PLACEMENT_PATH = "/placement";

/**
 * URL options, all optional:
 *   ?learner=ID        a Learner other than the default (lower-case letters, digits, dashes)
 *   ?track=synthetic   skip the Originals and starter pack; use the synthetic practice groove
 */
function urlOptions(search: string): { learnerId: LearnerId; trackPreference: TrackPreference } {
  const params = new URLSearchParams(search);
  const learner = LearnerIdSchema.safeParse(params.get("learner") ?? DEFAULT_LEARNER_ID);
  return {
    learnerId: learner.success ? learner.data : DEFAULT_LEARNER_ID,
    trackPreference: params.get("track") === "synthetic" ? "synthetic" : "auto",
  };
}

function lessonInPath(pathname: string): BuiltLessonId | null {
  const id = LESSON_PATH.exec(pathname.replace(/\/$/, ""))?.[1];
  return id !== undefined && isBuiltLesson(id) ? id : null;
}

type LearnerState = { kind: "loading" } | { kind: "ready"; record: LearnerRecord; offline: string | null };

export function App() {
  const [path, setPath] = useState(() => window.location.pathname);
  const [options] = useState(() => urlOptions(window.location.search));
  const [learner, setLearner] = useState<LearnerState>({ kind: "loading" });
  /** A Learner the server has never seen takes Placement first (at "/"). */
  const [firstRun, setFirstRun] = useState(false);
  /** The record as last set, for answers that arrive after a render (the Curriculum re-plan). */
  const latestRecord = useRef<LearnerRecord | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: "saved" });
  // One owner for saving: grading and the Curriculum re-plan both save through it, in order.
  const [saves] = useState(() => new SaveQueue(saveLearner, setSaveStatus));

  useEffect(() => {
    const onPop = () => {
      setPath(window.location.pathname);
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
    };
  }, []);

  // A controller allowed on an earlier visit connects by itself; the first time, the Controller page asks.
  useEffect(() => {
    void midiConnection().connectIfAllowed({ sysex: sysexChosen() });
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    void loadLearner(options.learnerId, abort.signal).then((loaded) => {
      if (abort.signal.aborted) return;
      const record = loaded.ok ? loaded.value.record : emptyLearnerRecord(options.learnerId);
      if (!loaded.ok) console.warn(`[app] ${loaded.problem.message}`);
      // No profile on the server yet: Placement first. Offline, the list (progress is not kept anyway).
      if (loaded.ok && !loaded.value.found) setFirstRun(true);
      latestRecord.current = record;
      setLearner({ kind: "ready", record, offline: loaded.ok ? null : loaded.problem.message });
    });
    return () => {
      abort.abort();
    };
  }, [options.learnerId]);

  // Navigation keeps the query (learner, track) and the page's user activation, so audio can start.
  const navigate = useCallback((pathname: string) => {
    window.history.pushState(null, "", `${pathname}${window.location.search}`);
    setPath(pathname);
  }, []);
  const openLesson = useCallback((lessonId: CourseLessonId) => {
    navigate(`/lesson/${lessonId}`);
  }, [navigate]);
  const exit = useCallback(() => {
    navigate("/");
  }, [navigate]);
  /** Keeps a new record and saves it (one save at a time; the newest wins). */
  const changeLearner = useCallback(
    (record: LearnerRecord) => {
      latestRecord.current = record;
      setLearner((current) => ({ kind: "ready", record, offline: current.kind === "ready" ? current.offline : null }));
      saves.save(record);
    },
    [saves],
  );
  const retrySave = useCallback(() => {
    saves.retry();
  }, [saves]);
  // In the App, not the Lesson: the answer may come after the Learner has left the Lesson.
  const replanCurriculum = useCallback(
    (result: CheckResult) => {
      const record = latestRecord.current;
      if (record === null) return;
      void requestCurriculum(record.learnerId, curriculumRequest(record, result, crypto.randomUUID())).then((answer) => {
        const current = latestRecord.current;
        if (answer === null || current?.learnerId !== record.learnerId) return;
        changeLearner(withCurriculum(current, answer));
      });
    },
    [changeLearner],
  );

  // Placement's end: write the record, then (once it is on the server) ask the Coach in the background.
  // The deterministic Curriculum is already in the record, so Start never waits (placement-design §7).
  const finishPlacement = useCallback(
    (result: PlacementResult, graded: readonly CheckResult[]) => {
      const record = latestRecord.current;
      if (record === null) return;
      const placed = withPlacement(record, result, graded);
      if (!placed.ok) {
        console.warn("[placement] the record refused the Placement result", placed.issues);
        return;
      }
      changeLearner(placed.record);
      const request = placementCurriculumRequest({ mission: result.mission, profileAfter: placed.record.skillProfile, graded }, crypto.randomUUID());
      void saves.settled().then(async (saved) => {
        if (!saved) return;
        const answer = await requestCurriculum(record.learnerId, request);
        const current = latestRecord.current;
        if (answer === null || current?.learnerId !== record.learnerId) return;
        changeLearner(withCurriculum(current, answer));
      });
    },
    [changeLearner, saves],
  );
  const placementDone = useCallback(
    (lessonId: BuiltLessonId | null) => {
      setFirstRun(false);
      navigate(lessonId === null ? "/" : `/lesson/${lessonId}`);
    },
    [navigate],
  );
  const retakePlacement = useCallback(() => {
    navigate(PLACEMENT_PATH);
  }, [navigate]);

  if (playgroundEnabled({ pathname: path, search: window.location.search }, import.meta.env.DEV)) {
    return (
      <Suspense fallback={null}>
        <Playground />
      </Suspense>
    );
  }

  if (isOriginalsPage(path)) {
    return (
      <Suspense fallback={<p className="lesson-loading">Opening the Originals…</p>}>
        <OriginalsPlayer />
      </Suspense>
    );
  }

  if (path.replace(/\/$/, "") === CONTROLLER_PAGE_PATH) {
    return (
      <Suspense fallback={<p className="lesson-loading">Opening the Controller page…</p>}>
        <ControllerPage onBack={exit} />
      </Suspense>
    );
  }

  const placementRun = path.replace(/\/$/, "") === PLACEMENT_PATH ? "retake" : path === "/" && firstRun ? "first" : null;
  if (placementRun !== null && learner.kind === "ready") {
    return (
      <Suspense fallback={<p className="lesson-loading">Opening Placement…</p>}>
        <Placement
          key={placementRun}
          learner={learner.record}
          run={placementRun}
          trackPreference={options.trackPreference}
          onLearnerChange={changeLearner}
          onFinish={finishPlacement}
          onDone={placementDone}
        />
      </Suspense>
    );
  }

  if (path.replace(/\/$/, "") === FINAL_MIX_PATH && learner.kind === "ready") {
    return (
      <Suspense fallback={<p className="lesson-loading">Opening your set…</p>}>
        <FinalMixPlayer learner={learner.record} onLearnerChange={changeLearner} saveStatus={saveStatus} trackPreference={options.trackPreference} onExit={exit} />
      </Suspense>
    );
  }

  const lessonId = lessonInPath(path);
  if (lessonId !== null && learner.kind === "ready") {
    return (
      <Suspense fallback={<p className="lesson-loading">Opening the Lesson…</p>}>
        <LessonPlayer
          key={lessonId}
          lessonId={lessonId}
          learner={learner.record}
          onLearnerChange={changeLearner}
          saveStatus={saveStatus}
          onRetrySave={retrySave}
          onSkipGroupPassed={replanCurriculum}
          trackPreference={options.trackPreference}
          onExit={exit}
          onOpenLesson={openLesson}
        />
      </Suspense>
    );
  }

  return (
    <main className="home">
      <header className="home-head">
        <h1>Learn to DJ</h1>
        <a
          className="home-controller-link"
          href={CONTROLLER_PAGE_PATH}
          onClick={(event) => {
            event.preventDefault();
            navigate(CONTROLLER_PAGE_PATH);
          }}
        >
          Controller
        </a>
        <HealthIndicator />
      </header>
      {learner.kind === "ready" ? <LessonList learner={learner.record} offline={learner.offline} onStart={openLesson} onRetakePlacement={retakePlacement} /> : <p>Loading your progress…</p>}
    </main>
  );
}
