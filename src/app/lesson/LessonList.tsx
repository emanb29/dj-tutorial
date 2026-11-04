// The Lesson list, in two paths (docs/lesson-catalogue.md, "Two paths"): the recorded-mix path, with its
// first-mix and final-project milestones, then the optional live path. Rows come from course-list.ts.
import { hasPlacement, type CourseLessonId } from "@lessons";
import type { LearnerRecord } from "@shared/learner.ts";
import { ButtonHint, useControllerConnected } from "../controller/KeyHint.tsx";
import { courseSections, courseStart, type CourseRow, type CourseSection, type CourseStart, type LessonStanding } from "./course-list.ts";
import "./lesson-list.css";

const STANDING_WORDS: Readonly<Record<LessonStanding, string>> = {
  locked: "Locked",
  ready: "Ready",
  passed: "Passed",
  retained: "Retained",
  lapsed: "Passed, due a refresh",
};

interface LessonListProps {
  readonly learner: LearnerRecord;
  readonly offline: string | null;
  readonly onStart: (lessonId: CourseLessonId) => void;
  /** Placement again (placement-design §9): any time, it only adds credit. */
  readonly onRetakePlacement: () => void;
  /** "Grade a mix you recorded": outside practice, open from the start. */
  readonly onGradeMix: () => void;
  /** Freestyle: both decks and the library, no grading; open from the start. */
  readonly onFreestyle: () => void;
  /**
   * Mix plans: sets planned from the music folder; open from the start. Both milestones open it too:
   * the Mix Editor and Render join it there (catalogue "Early win").
   */
  readonly onMixPlans: () => void;
}

const isStart = (row: CourseRow, start: CourseStart) =>
  row.kind === "lesson" ? start.kind === "lesson" && start.lessonId === row.lessonId : start.kind === "milestone" && start.milestoneId === row.milestoneId;

function startWords(sections: readonly CourseSection[], start: CourseStart): string {
  const row = sections.flatMap((section) => section.rows).find((candidate) => isStart(candidate, start));
  if (row === undefined) return "";
  return row.kind === "lesson" ? `starts Lesson ${String(row.number)} (${row.title})` : `opens ${row.title}`;
}

export function LessonList({ learner, offline, onStart, onRetakePlacement, onGradeMix, onFreestyle, onMixPlans }: LessonListProps) {
  const sections = courseSections(learner);
  const start = courseStart(learner);
  const controllerConnected = useControllerConnected();
  return (
    <section className="lesson-list" aria-label="Lessons">
      {offline === null ? null : (
        <p className="lesson-problem" role="alert">
          {offline} Progress is kept for this visit only.
        </p>
      )}
      <p className="lesson-list-placement">
        <button type="button" className="btn btn-quiet" onClick={onRetakePlacement}>
          {hasPlacement(learner) ? "Re-take Placement" : "Show me what you can do"}
        </button>
        <button type="button" className="btn btn-quiet" onClick={onGradeMix}>
          Grade a mix you recorded
        </button>
        <button type="button" className="btn btn-quiet" onClick={onFreestyle}>
          Freestyle
        </button>
        <button type="button" className="btn btn-quiet" onClick={onMixPlans}>
          Mix plans
        </button>
      </p>
      {controllerConnected ? (
        <p className="lesson-list-flx4" data-testid="flx4-hint">
          FLX4: turn BROWSE to a Lesson, press it · <ButtonHint k="Enter" /> {startWords(sections, start)}
        </p>
      ) : null}
      {sections.map((section) => (
        <section key={section.path} className="lesson-path" data-path={section.path} aria-labelledby={`lesson-path-${section.path}`}>
          <h2 id={`lesson-path-${section.path}`} className="lesson-path-title">
            {section.title}
          </h2>
          <p className="lesson-path-caption">{section.caption}</p>
          <ol>
            {section.rows.map((row) => {
              const here = isStart(row, start);
              if (row.kind === "milestone") {
                return (
                  <li key={row.milestoneId} className="lesson-milestone" data-milestone={row.milestoneId} data-standing={row.standing} data-start={here || undefined}>
                    <span className="lesson-number" aria-hidden="true">
                      ★
                    </span>
                    <span className="lesson-title">{row.title}</span>
                    <span className="lesson-standing">{row.caption}</span>
                    {row.needs !== null ? (
                      <span className="lesson-needs">{row.needs}</span>
                    ) : (
                      <button type="button" data-nav-default={here || undefined} className="btn btn-primary" onClick={onMixPlans}>
                        Plan it
                      </button>
                    )}
                  </li>
                );
              }
              return (
                <li key={row.lessonId} data-lesson={row.lessonId} data-standing={row.standing} data-start={here || undefined}>
                  <span className="lesson-number">{row.number}</span>
                  <span className="lesson-title">{row.title}</span>
                  <span className="lesson-standing">{STANDING_WORDS[row.standing]}</span>
                  {row.needs !== null ? (
                    <span className="lesson-needs">{row.needs}</span>
                  ) : (
                    <button
                      type="button"
                      data-nav-default={here || undefined}
                      className={row.standing === "ready" ? "btn btn-primary" : "btn"}
                      onClick={() => {
                        onStart(row.lessonId);
                      }}
                    >
                      {row.standing === "ready" ? "Start" : "Play again"}
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </section>
  );
}
