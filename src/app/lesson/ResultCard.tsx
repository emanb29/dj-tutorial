// The result card after a Check: passed or not, each criterion in plain words, the Coach's one line
// (in a slot of fixed height, filled within 1.2 s and never rewritten), at most one tip or a Review
// suggestion, and the unlock when the Lesson is passed for the first time.
import { useEffect, useRef, useState, type RefObject } from "react";
import { checkLineRequest, describeCriterion, LESSONS, type BuiltLessonId, type LessonDefinition, type LessonPhase } from "@lessons";
import { lessonById } from "@shared/catalogue.ts";
import { RECENT_LINES_MAX } from "@shared/coach-contract.ts";
import type { MissionTag } from "@shared/mission.ts";
import { inputWording, useWording } from "../controller/wording.ts";
import type { RekordboxCardChoice, RekordboxCardId } from "@shared/learner.ts";
import { RekordboxCard } from "../rekordbox/RekordboxCard.tsx";
import type { RekordboxCard as RekordboxCardContent } from "../rekordbox/rekordbox-steps.ts";
import type { SaveStatus } from "../save-queue.ts";
import { coachLine } from "./api-client.ts";
import { voidLine } from "./void-line.ts";

interface ResultCardProps {
  readonly phase: Extract<LessonPhase, { kind: "result" } | { kind: "void" }>;
  readonly definition: LessonDefinition;
  readonly learnerId: string;
  /** From the Learner's record (set by the Curriculum job); sent with the line request. */
  readonly missionTags: readonly MissionTag[];
  readonly attemptToday: number;
  /** A failed save shows "not saved — retry" instead of a silent pass and unlock. */
  readonly saveStatus: SaveStatus;
  readonly onRetrySave: () => void;
  /** The last lines shown this session, so the Coach does not repeat itself. Owned by the player. */
  readonly recentLines: RefObject<string[]>;
  readonly onRetry: () => void;
  readonly onPractice: () => void;
  readonly onDeclineReview: () => void;
  readonly onOpenLesson: (lessonId: BuiltLessonId) => void;
  /** The optional "Now try it in rekordbox" card for this Lesson, when passed and not yet done. */
  readonly rekordboxCard: RekordboxCardContent | null;
  readonly onRekordboxChoice: (card: RekordboxCardId, choice: RekordboxCardChoice["choice"]) => void;
}

export function ResultCard(props: ResultCardProps) {
  const { phase, onRetry, onPractice } = props;
  if (phase.kind === "void") {
    return (
      <section className="result-card void lesson-overlay" aria-label="Result">
        <h2>
          <span aria-hidden="true">–</span> Didn&apos;t count
        </h2>
        <p>{voidLine(phase.reason, phase.message)}</p>
        <Actions onRetry={onRetry} onPractice={onPractice} />
      </section>
    );
  }
  return <GradedCard {...props} phase={phase} />;
}

function Actions({ onRetry, onPractice }: { readonly onRetry: () => void; readonly onPractice: () => void }) {
  return (
    <div className="result-actions">
      <button type="button" className="btn btn-primary" onClick={onRetry}>
        Go again <kbd>Enter</kbd>
      </button>
      <button type="button" className="btn" onClick={onPractice}>
        Practice <kbd>P</kbd>
      </button>
    </div>
  );
}

function GradedCard({ phase, definition, learnerId, missionTags, attemptToday, recentLines, saveStatus, onRetrySave, onRetry, onPractice, onDeclineReview, onOpenLesson, rekordboxCard, onRekordboxChoice }: ResultCardProps & { readonly phase: Extract<LessonPhase, { kind: "result" }> }) {
  const { result, review, tip, firstPass } = phase;
  const passed = result.outcome.kind === "passed";
  const unsaved = saveStatus.kind === "failed";
  const line = useCoachLine(phase, definition, learnerId, missionTags, attemptToday, recentLines);
  const wording = useWording();
  const shown = result.criteria.filter((criterion) => criterion.status !== "notApplicable");
  // Hidden once answered here; "Not now" offers it again after a later pass.
  const [rekordboxAnswered, setRekordboxAnswered] = useState(false);
  const next = LESSONS[LESSONS.findIndex((lesson) => lesson.id === definition.id) + 1];

  return (
    <section className={`result-card lesson-overlay ${passed ? "passed" : "failed"}`} aria-label="Result" data-outcome={result.outcome.kind}>
      <h2>
        <span aria-hidden="true">{passed ? "✓" : "✗"}</span> {passed ? "Passed" : "Not yet"}
        {unsaved ? <span className="result-unsaved"> (not saved)</span> : null}
      </h2>
      {unsaved ? (
        <div className="save-problem" role="alert">
          <span>Not saved: {passed ? "this pass isn't stored yet." : "this attempt isn't stored yet."}</span>
          <button type="button" className="btn btn-primary" onClick={onRetrySave}>
            Retry save
          </button>
        </div>
      ) : null}
      <ul className="result-criteria">
        {shown.map((criterion) => (
          <li key={criterion.id} data-status={criterion.status}>
            <span aria-hidden="true">{criterion.status === "met" ? "✓" : "✗"}</span> {describeCriterion(criterion)}
          </li>
        ))}
      </ul>
      <p className="coach-line" aria-label="Coach" aria-live="polite">
        {line ?? " "}
      </p>
      {tip === null ? null : <p className="coach-tip">Tip: {inputWording(tip, wording)}</p>}
      {review === null ? null : (
        <div className="review-offer">
          <span>
            Want a quick replay of <em>{lessonById(review.lessonId).title}</em>? That's where it's taught.
          </span>
          <button type="button" className="btn btn-quiet" onClick={onPractice}>
            Replay
          </button>
          <button type="button" className="btn btn-quiet" onClick={onDeclineReview}>
            Not now
          </button>
        </div>
      )}
      {firstPass && next !== undefined && !unsaved ? (
        <div className="unlock-badge" role="status">
          Unlocked: <strong>{next.title}</strong>
          {next.unlocks.length > 0 ? <span> (new on the controller: {next.unlocks.join(", ")})</span> : null}
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => {
              onOpenLesson(next.id);
            }}
          >
            Next Lesson →
          </button>
        </div>
      ) : null}
      {passed && !unsaved && rekordboxCard !== null && !rekordboxAnswered ? (
        <RekordboxCard
          card={rekordboxCard}
          onChoose={(choice) => {
            setRekordboxAnswered(true);
            onRekordboxChoice(rekordboxCard.id, choice);
          }}
        />
      ) : null}
      <Actions onRetry={onRetry} onPractice={onPractice} />
    </section>
  );
}

/** The line for this result: shown once, never rewritten; a new result cancels the old request. */
function useCoachLine(
  phase: Extract<LessonPhase, { kind: "result" }>,
  definition: LessonDefinition,
  learnerId: string,
  missionTags: readonly MissionTag[],
  attemptToday: number,
  recent: RefObject<string[]>,
): string | null {
  const [line, setLine] = useState<{ attemptId: string; text: string } | null>(null);
  const { result, lineFacts } = phase;
  // Read when the request is built, not a dependency: a re-saved record must not ask for a new line.
  const tags = useRef(missionTags);
  useEffect(() => {
    tags.current = missionTags;
  }, [missionTags]);

  useEffect(() => {
    const abort = new AbortController();
    const request = checkLineRequest(result, {
      requestId: crypto.randomUUID(),
      lessonTitle: definition.title,
      attemptToday,
      recentLines: recent.current,
      facts: lineFacts,
      missionTags: tags.current,
    });
    void coachLine(learnerId, request, abort.signal).then((text) => {
      if (abort.signal.aborted) return;
      recent.current = [...recent.current, text].slice(-RECENT_LINES_MAX);
      setLine({ attemptId: result.attemptId, text });
    });
    return () => {
      abort.abort();
    };
  }, [result, lineFacts, definition, learnerId, attemptToday, recent]);

  return line?.attemptId === result.attemptId ? line.text : null;
}
