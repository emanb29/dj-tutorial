import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { curriculumRequest, isBuiltLesson, withCurriculum, type BuiltLessonId } from "@lessons";
import type { CheckResult } from "@shared/check-result.ts";
import { DEFAULT_LEARNER_ID, emptyLearnerRecord, LearnerIdSchema, type LearnerId, type LearnerRecord } from "@shared/learner.ts";
import { HealthIndicator } from "./HealthIndicator.tsx";
import { loadLearner, requestCurriculum, saveLearner } from "./lesson/api-client.ts";
import { LessonList } from "./lesson/LessonList.tsx";
import type { TrackPreference } from "./lesson/track-loader.ts";

// The dev playground and the Lesson player load the audio engine and the controller: separate chunks.
const Playground = lazy(() => import("./playground/Playground.tsx").then((module) => ({ default: module.Playground })));
const LessonPlayer = lazy(() => import("./lesson/LessonPlayer.tsx").then((module) => ({ default: module.LessonPlayer })));
// The Originals player is its own small page, and its own chunk.
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
  /** The record as last set, for answers that arrive after a render (the Curriculum re-plan). */
  const latestRecord = useRef<LearnerRecord | null>(null);

  useEffect(() => {
    const onPop = () => {
      setPath(window.location.pathname);
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
    };
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    void loadLearner(options.learnerId, abort.signal).then((loaded) => {
      if (abort.signal.aborted) return;
      const record = loaded.ok ? loaded.value : emptyLearnerRecord(options.learnerId);
      if (!loaded.ok) console.warn(`[app] ${loaded.problem.message}`);
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
  const openLesson = useCallback((lessonId: BuiltLessonId) => {
    navigate(`/lesson/${lessonId}`);
  }, [navigate]);
  const exit = useCallback(() => {
    navigate("/");
  }, [navigate]);
  const changeLearner = useCallback((record: LearnerRecord) => {
    latestRecord.current = record;
    setLearner((current) => ({ kind: "ready", record, offline: current.kind === "ready" ? current.offline : null }));
  }, []);
  // In the App, not the Lesson: the answer may come after the Learner has left the Lesson.
  const replanCurriculum = useCallback(
    (result: CheckResult) => {
      const record = latestRecord.current;
      if (record === null) return;
      void requestCurriculum(record.learnerId, curriculumRequest(record, result, crypto.randomUUID())).then((answer) => {
        const current = latestRecord.current;
        if (answer === null || current?.learnerId !== record.learnerId) return;
        const next = withCurriculum(current, answer);
        changeLearner(next);
        void saveLearner(next).then((saved) => {
          if (!saved.ok) console.warn(`[app] ${saved.problem.message}`);
        });
      });
    },
    [changeLearner],
  );

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

  const lessonId = lessonInPath(path);
  if (lessonId !== null && learner.kind === "ready") {
    return (
      <Suspense fallback={<p className="lesson-loading">Opening the Lesson…</p>}>
        <LessonPlayer
          key={lessonId}
          lessonId={lessonId}
          learner={learner.record}
          onLearnerChange={changeLearner}
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
        <HealthIndicator />
      </header>
      {learner.kind === "ready" ? <LessonList learner={learner.record} offline={learner.offline} onStart={openLesson} /> : <p>Loading your progress…</p>}
    </main>
  );
}
