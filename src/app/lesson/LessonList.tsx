// The minimal Lesson list: Lessons 1–3 with passed / retained state from the Skill profile.
// A Lesson opens once its prerequisites are passed; progress is never time-gated.
import { lessonRetention } from "@checks";
import { LESSONS, type BuiltLessonId } from "@lessons";
import { lessonById } from "@shared/catalogue.ts";
import type { LearnerRecord } from "@shared/learner.ts";

export type LessonStanding = "locked" | "ready" | "passed" | "retained" | "lapsed";

export function lessonStanding(learner: LearnerRecord, lessonId: BuiltLessonId): LessonStanding {
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
  readonly onStart: (lessonId: BuiltLessonId) => void;
}

export function LessonList({ learner, offline, onStart }: LessonListProps) {
  return (
    <section className="lesson-list" aria-label="Lessons">
      {offline === null ? null : (
        <p className="lesson-problem" role="alert">
          {offline} Progress is kept for this visit only.
        </p>
      )}
      <ol>
        {LESSONS.map((lesson, index) => {
          const standing = lessonStanding(learner, lesson.id);
          const prerequisites = lessonById(lesson.id).prerequisites.map((id) => lessonById(id).title);
          return (
            <li key={lesson.id} data-lesson={lesson.id} data-standing={standing}>
              <span className="lesson-number">{index + 1}</span>
              <span className="lesson-title">{lesson.title}</span>
              <span className="lesson-standing">{STANDING_WORDS[standing]}</span>
              {standing === "locked" ? (
                <span className="lesson-needs">Pass “{prerequisites.join("”, “")}” first</span>
              ) : (
                <button
                  type="button"
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
