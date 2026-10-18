// "Grade a mix you recorded" (ISS-96): the Learner picks one audio file of a mix they made elsewhere
// (rekordbox, any DJ software, their own tracks). It is decoded here, graded in the mix worker, shown
// on the same result card and Coach line as a Lesson, and kept in the record as outside practice.
import { useCallback, useEffect, useRef, useState } from "react";
import { gradeMix, type MixProgress, type MixReport, type MixStage } from "@analysis/mix/index.ts";
import { checkLineRequest, NO_LINE_FACTS } from "@lessons";
import type { CheckResult } from "@shared/check-result.ts";
import { withOutsidePractice, type LearnerRecord } from "@shared/learner.ts";
import { MIX_CHECK_IDS } from "@shared/outside-practice.ts";
import { coachLine } from "../lesson/api-client.ts";
import type { SaveStatus } from "../save-queue.ts";
import { decodeMix, fileProblemText } from "./decode.ts";
import { criterionCaption, MIX_LIMITS_CAPTION, mixCheckResult, mixCriterion, mixProblemText, outsidePracticeOf, transitionCaptions, transitionTitle } from "./mix-result.ts";
import "../lesson/lesson.css";
import "./mix-grade.css";

type Phase =
  | { readonly kind: "pick" }
  | { readonly kind: "working"; readonly stage: MixStage | "decoding"; readonly fraction: number }
  | { readonly kind: "problem"; readonly text: string }
  | { readonly kind: "graded"; readonly report: MixReport; readonly result: CheckResult; readonly saved: boolean };

const STAGE_WORDS: Readonly<Record<MixStage | "decoding", string>> = {
  decoding: "Opening the file…",
  preparing: "Getting ready…",
  beats: "Finding the beats…",
  transitions: "Finding the transitions…",
  checks: "Checking each transition…",
};

interface MixGradePageProps {
  readonly learner: LearnerRecord;
  readonly onLearnerChange: (record: LearnerRecord) => void;
  readonly saveStatus: SaveStatus;
  readonly onRetrySave: () => void;
  readonly onExit: () => void;
}

export function MixGradePage({ learner, onLearnerChange, saveStatus, onRetrySave, onExit }: MixGradePageProps) {
  const [phase, setPhase] = useState<Phase>({ kind: "pick" });
  const abort = useRef<AbortController | null>(null);
  // Read when a grading finishes, not a dependency: a re-saved record must not restart anything.
  const latest = useRef(learner);
  useEffect(() => {
    latest.current = learner;
  }, [learner]);
  useEffect(
    () => () => {
      abort.current?.abort();
    },
    [],
  );

  const grade = useCallback(
    async (file: File) => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      // A function, so the check after each await is not narrowed away.
      const stopped = () => controller.signal.aborted;
      const startedAt = new Date().toISOString();
      setPhase({ kind: "working", stage: "decoding", fraction: 0 });
      const decoded = await decodeMix(file, controller.signal);
      if (stopped()) return;
      if (!decoded.ok) {
        if (decoded.problem.kind !== "aborted") setPhase({ kind: "problem", text: fileProblemText(decoded.problem) });
        return;
      }
      const outcome = await gradeMix(decoded.audio, {
        signal: controller.signal,
        onProgress: (progress: MixProgress) => {
          setPhase({ kind: "working", stage: progress.stage, fraction: progress.fraction });
        },
      });
      if (stopped()) return;
      if (!outcome.ok) {
        if (outcome.error.kind !== "aborted") setPhase({ kind: "problem", text: mixProblemText(outcome.error) });
        return;
      }
      const { report } = outcome;
      if (report.transitions.length === 0) {
        setPhase({ kind: "problem", text: "Heard one track, no transitions. Pick a mix of two tracks or more." });
        return;
      }
      const record = latest.current;
      const id = crypto.randomUUID();
      const endedAt = new Date().toISOString();
      const result = mixCheckResult(report, { attemptId: id, learnerId: record.learnerId, startedAt, endedAt });
      const updated = withOutsidePractice(record, outsidePracticeOf(report, id, endedAt));
      if (updated.ok) onLearnerChange(updated.record);
      else console.warn("[mix] the record refused the graded mix", updated.issues);
      setPhase({ kind: "graded", report, result, saved: updated.ok });
    },
    [onLearnerChange],
  );

  return (
    <main className="mix-page">
      <header className="mix-head">
        <button type="button" className="btn btn-quiet" onClick={onExit}>
          ← Lessons
        </button>
        <h1>Grade a mix you recorded</h1>
      </header>
      {phase.kind === "graded" ? (
        <MixResult phase={phase} learner={learner} saveStatus={saveStatus} onRetrySave={onRetrySave} onAgain={() => {
            setPhase({ kind: "pick" });
          }} onExit={onExit} />
      ) : (
        <section className="mix-pick" aria-label="Pick a recording">
          <p className="mix-caption">Any DJ software · your own tracks</p>
          <p className="mix-caption mix-limits">{MIX_LIMITS_CAPTION}</p>
          {phase.kind === "working" ? (
            <div className="mix-working" role="status">
              <span>{STAGE_WORDS[phase.stage]}</span>
              <progress max={1} value={phase.fraction} aria-label="Grading" />
            </div>
          ) : (
            <label className="btn btn-primary mix-file">
              {phase.kind === "problem" ? "Pick another" : "Pick a recording"}
              <input
                type="file"
                accept="audio/*"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (file !== undefined) void grade(file);
                }}
              />
            </label>
          )}
          {phase.kind === "problem" ? (
            <p className="lesson-problem" role="alert">
              {phase.text}
            </p>
          ) : null}
        </section>
      )}
    </main>
  );
}

interface MixResultProps {
  readonly phase: Extract<Phase, { kind: "graded" }>;
  readonly learner: LearnerRecord;
  readonly saveStatus: SaveStatus;
  readonly onRetrySave: () => void;
  readonly onAgain: () => void;
  readonly onExit: () => void;
}

function MixResult({ phase, learner, saveStatus, onRetrySave, onAgain, onExit }: MixResultProps) {
  const { report, result, saved } = phase;
  const clean = result.outcome.kind === "passed";
  const line = useMixCoachLine(result, learner);
  const unsaved = !saved || saveStatus.kind === "failed";
  return (
    <section className={`result-card mix-result ${clean ? "passed" : "failed"}`} aria-label="Result" data-outcome={result.outcome.kind}>
      <h2>
        <span aria-hidden="true">{clean ? "✓" : "✗"}</span> {clean ? "Clean mix" : "Not yet"}
      </h2>
      <p className="mix-caption">
        {report.transitions.length === 1 ? "1 transition" : `${String(report.transitions.length)} transitions`} · {Math.round(report.durationSec / 60) || "<1"} min
      </p>
      <ul className="result-criteria">
        {MIX_CHECK_IDS.map((check) => {
          const criterion = mixCriterion(check, report);
          if (criterion.status === "notApplicable") return null;
          return (
            <li key={check} data-check={check} data-status={criterion.status}>
              <span aria-hidden="true">{criterion.status === "met" ? "✓" : "✗"}</span> {criterionCaption(check, report)}
            </li>
          );
        })}
      </ul>
      <p className="coach-line" aria-label="Coach" aria-live="polite">
        {line ?? " "}
      </p>
      {unsaved ? (
        <div className="save-problem" role="alert">
          <span>Not saved yet.</span>
          {saved ? (
            <button type="button" className="btn btn-primary" onClick={onRetrySave}>
              Retry save
            </button>
          ) : null}
        </div>
      ) : (
        <p className="mix-caption" role="status">
          Saved as outside practice
        </p>
      )}
      <ol className="mix-transitions" aria-label="Transitions">
        {report.transitions.map((transition) => (
          <li key={transition.number} data-kind={transition.kind}>
            <h3>
              {transition.number}. {transitionTitle(transition)}
            </h3>
            <ul>
              {transitionCaptions(transition).map((caption) => (
                <li key={caption.check} data-check={caption.check} data-status={caption.met === null ? "notApplicable" : caption.met ? "met" : "notMet"}>
                  <span aria-hidden="true">{caption.met === null ? "–" : caption.met ? "✓" : "✗"}</span> {caption.text}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
      <p className="mix-caption">Read from the sound alone</p>
      <div className="result-actions">
        <button type="button" className="btn btn-primary" onClick={onAgain}>
          Grade another
        </button>
        <button type="button" className="btn" onClick={onExit}>
          Back to the Lessons
        </button>
      </div>
    </section>
  );
}

/** The Coach's one line for this mix, as after a Lesson: asked once, never rewritten. */
function useMixCoachLine(result: CheckResult, learner: LearnerRecord): string | null {
  const [line, setLine] = useState<{ attemptId: string; text: string } | null>(null);
  const learnerAtStart = useRef(learner);
  useEffect(() => {
    const abort = new AbortController();
    const record = learnerAtStart.current;
    const today = new Date().toISOString().slice(0, 10);
    const request = checkLineRequest(result, {
      requestId: crypto.randomUUID(),
      lessonTitle: "Your recorded mix",
      attemptToday: (record.outsidePractice ?? []).filter((entry) => entry.gradedAt.startsWith(today)).length,
      recentLines: [],
      facts: NO_LINE_FACTS,
      missionTags: record.missionTags,
    });
    void coachLine(record.learnerId, request, abort.signal).then((text) => {
      if (!abort.signal.aborted) setLine({ attemptId: result.attemptId, text });
    });
    return () => {
      abort.abort();
    };
  }, [result]);
  return line?.attemptId === result.attemptId ? line.text : null;
}
