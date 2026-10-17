// The result card after a Check: passed or not, each criterion in plain words, the Coach's one line
// (in a slot of fixed height, filled within 1.2 s and never rewritten), at most one tip or a Review
// suggestion, and the unlock when the Lesson is passed for the first time.
import { useEffect, useState, type RefObject } from "react";
import { checkLineRequest, describeCriterion, LESSONS, type BuiltLessonId, type LessonDefinition, type LessonPhase } from "@lessons";
import { lessonById } from "@shared/catalogue.ts";
import { coachLine } from "./api-client.ts";

const VOID_WORDS = {
  contextSuspended: "the sound stopped",
  tabHidden: "the tab was hidden",
  gridUntrusted: "this track's beat grid is too uneven to grade",
  abandoned: "it was left early",
  recordingFailed: "it could not be recorded",
} as const;

interface ResultCardProps {
  readonly phase: Extract<LessonPhase, { kind: "result" } | { kind: "void" }>;
  readonly definition: LessonDefinition;
  readonly learnerId: string;
  readonly attemptToday: number;
  /** The last lines shown this session, so the Coach does not repeat itself. Owned by the player. */
  readonly recentLines: RefObject<string[]>;
  readonly onRetry: () => void;
  readonly onPractice: () => void;
  readonly onDeclineReview: () => void;
  readonly onOpenLesson: (lessonId: BuiltLessonId) => void;
}

export function ResultCard(props: ResultCardProps) {
  const { phase, onRetry, onPractice } = props;
  if (phase.kind === "void") {
    return (
      <section className="result-card void" aria-label="Result">
        <h2>Didn't count</h2>
        <p>
          Not graded: {VOID_WORDS[phase.reason]}.{phase.message === null ? "" : ` ${phase.message}`}
        </p>
        <Actions onRetry={onRetry} onPractice={onPractice} />
      </section>
    );
  }
  return <GradedCard {...props} phase={phase} />;
}

function Actions({ onRetry, onPractice }: { readonly onRetry: () => void; readonly onPractice: () => void }) {
  return (
    <div className="result-actions">
      <button type="button" onClick={onRetry}>
        Go again <kbd>Enter</kbd>
      </button>
      <button type="button" onClick={onPractice}>
        Practice <kbd>P</kbd>
      </button>
    </div>
  );
}

function GradedCard({ phase, definition, learnerId, attemptToday, recentLines, onRetry, onPractice, onDeclineReview, onOpenLesson }: ResultCardProps & { readonly phase: Extract<LessonPhase, { kind: "result" }> }) {
  const { result, review, tip, firstPass } = phase;
  const passed = result.outcome.kind === "passed";
  const line = useCoachLine(phase, definition, learnerId, attemptToday, recentLines);
  const shown = result.criteria.filter((criterion) => criterion.status !== "notApplicable");
  const next = LESSONS[LESSONS.findIndex((lesson) => lesson.id === definition.id) + 1];

  return (
    <section className={`result-card ${passed ? "passed" : "failed"}`} aria-label="Result" data-outcome={result.outcome.kind}>
      <h2>{passed ? "Passed" : "Not yet"}</h2>
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
      {tip === null ? null : <p className="coach-tip">Tip: {tip}</p>}
      {review === null ? null : (
        <div className="review-offer">
          <span>
            Want a quick replay of <em>{lessonById(review.lessonId).title}</em>? That's where it's taught.
          </span>
          <button type="button" onClick={onPractice}>
            Replay
          </button>
          <button type="button" onClick={onDeclineReview}>
            Not now
          </button>
        </div>
      )}
      {firstPass && next !== undefined ? (
        <div className="unlock-badge" role="status">
          Unlocked: <strong>{next.title}</strong>
          {next.unlocks.length > 0 ? <span> (new on the controller: {next.unlocks.join(", ")})</span> : null}
          <button
            type="button"
            onClick={() => {
              onOpenLesson(next.id);
            }}
          >
            Next Lesson →
          </button>
        </div>
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
  attemptToday: number,
  recent: RefObject<string[]>,
): string | null {
  const [line, setLine] = useState<{ attemptId: string; text: string } | null>(null);
  const { result } = phase;

  useEffect(() => {
    const abort = new AbortController();
    const request = checkLineRequest(result, {
      requestId: crypto.randomUUID(),
      lessonTitle: definition.title,
      attemptToday,
      recentLines: recent.current,
    });
    void coachLine(learnerId, request, abort.signal).then((text) => {
      if (abort.signal.aborted) return;
      recent.current = [...recent.current, text].slice(-5);
      setLine({ attemptId: result.attemptId, text });
    });
    return () => {
      abort.abort();
    };
  }, [result, definition, learnerId, attemptToday, recent]);

  return line?.attemptId === result.attemptId ? line.text : null;
}
