// The minimal Lesson list: Lessons 1–3 with passed / retained state from the Skill profile.
// A Lesson opens once its prerequisites are passed; progress is never time-gated.
import { lessonRetention } from "@checks";
import { COURSE, hasPlacement, startLesson, type CourseLessonId } from "@lessons";
import { catalogueIndex, lessonById } from "@shared/catalogue.ts";
import { withRekordboxChoice, type LearnerRecord } from "@shared/learner.ts";
import { RekordboxCard } from "../rekordbox/RekordboxCard.tsx";
import { LIBRARY_CARD, showLibraryCard } from "../rekordbox/rekordbox-steps.ts";
import "./lesson-list.css";

export type LessonStanding = "locked" | "ready" | "passed" | "retained" | "lapsed";

export function lessonStanding(learner: LearnerRecord, lessonId: CourseLessonId): LessonStanding {
  const profile = learner.skillProfile;
  if (profile.lessons[lessonId]?.passedAt != null) {
    const retention = lessonRetention(profile, lessonId);
    return retention === "retained" || retention === "lapsed" ? retention : "passed";
  }
  const open = lessonById(lessonId).prerequisites.every((id) => profile.lessons[id]?.passedAt != null);
  return open ? "ready" : "locked";
}

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
  /** Keeps and saves a changed record (the rekordbox library card's answer). */
  readonly onLearnerChange: (record: LearnerRecord) => void;
}

export function LessonList({ learner, offline, onStart, onRetakePlacement, onLearnerChange }: LessonListProps) {
  const startHere = startLesson(learner.skillProfile);
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
      </p>
      {showLibraryCard(learner) ? (
        <RekordboxCard
          card={LIBRARY_CARD}
          onChoose={(choice) => {
            onLearnerChange(withRekordboxChoice(learner, "library", choice, new Date().toISOString()));
          }}
        />
      ) : null}
      <ol>
        {COURSE.map((lesson) => {
          const standing = lessonStanding(learner, lesson.id);
          const prerequisites = lessonById(lesson.id).prerequisites.map((id) => lessonById(id).title);
          return (
            <li key={lesson.id} data-lesson={lesson.id} data-standing={standing} data-start={lesson.id === startHere || undefined}>
              <span className="lesson-number">{catalogueIndex(lesson.id) + 1}</span>
              <span className="lesson-title">{lesson.title}</span>
              <span className="lesson-standing">{STANDING_WORDS[standing]}</span>
              {standing === "locked" ? (
                <span className="lesson-needs">Pass “{prerequisites.join("”, “")}” first</span>
              ) : (
                <button
                  type="button"
                  className={standing === "ready" ? "btn btn-primary" : "btn"}
                  onClick={() => {
                    onStart(lesson.id);
                  }}
                >
                  {standing === "ready" ? "Start" : "Play again"}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
