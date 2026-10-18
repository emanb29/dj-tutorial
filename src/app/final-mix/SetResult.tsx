// After a set: the Check (criteria in plain words, the LCME bands of a passed set, each transition's
// results) and the recording: play it back, download it with its notes, keep it as the final project.
import { useEffect, useMemo } from "react";
import { fileExtensionOf, type FinishedRecording } from "@audio";
import type { TransitionReport } from "@checks";
import { describeCriterion, describeSetCriterion } from "@lessons";
import type { CheckResult, VoidAttempt } from "@shared/check-result.ts";

export type KeepStatus = { readonly kind: "idle" } | { readonly kind: "saving" } | { readonly kind: "kept" } | { readonly kind: "failed"; readonly message: string };

interface SetResultProps {
  readonly outcome: CheckResult | VoidAttempt;
  readonly transitions: readonly TransitionReport[];
  /** Track titles by track id. */
  readonly titles: ReadonlyMap<string, string>;
  readonly recording: FinishedRecording | null;
  readonly recordingProblem: string | null;
  readonly notes: string;
  /** "Final project" for a cold re-pass, "Rehearsal" for the first set. */
  readonly label: string;
  readonly keep: KeepStatus;
  readonly onKeep: () => void;
  readonly onAgain: () => void;
  readonly onExit: () => void;
}

const minutes = (seconds: number) => `${String(Math.floor(seconds / 60))}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;
const KIND_WORDS = { cut: "Cut", blend: "Blend", unclassified: "Neither cut nor blend" } as const;

function useObjectUrl(blob: Blob | null): string | null {
  const url = useMemo(() => (blob === null ? null : URL.createObjectURL(blob)), [blob]);
  useEffect(
    () => () => {
      if (url !== null) URL.revokeObjectURL(url);
    },
    [url],
  );
  return url;
}

export function SetResult({ outcome, transitions, titles, recording, recordingProblem, notes, label, keep, onKeep, onAgain, onExit }: SetResultProps) {
  const audioUrl = useObjectUrl(recording?.blob ?? null);
  const notesBlob = useMemo(() => new Blob([notes], { type: "text/plain" }), [notes]);
  const notesUrl = useObjectUrl(notesBlob);
  const day = new Date().toISOString().slice(0, 10);
  const graded = outcome.outcome.kind === "void" ? null : (outcome as CheckResult);
  const passed = outcome.outcome.kind === "passed";
  const bands = outcome.outcome.kind === "passed" ? outcome.outcome.bands : undefined;
  const title = (trackId: string) => titles.get(trackId) ?? trackId;

  return (
    <section className={`set-result ${passed ? "passed" : "failed"}`} aria-label="Result" data-outcome={outcome.outcome.kind}>
      <h2>
        {label}: {outcome.outcome.kind === "void" ? "not graded" : passed ? "passed" : "not yet"}
      </h2>
      {outcome.outcome.kind === "void" ? <p>The set was interrupted ({outcome.outcome.reason}), so it does not count. Play it again.</p> : null}
      {bands === undefined ? null : (
        <p className="set-bands" aria-label="Bands">
          Overall <strong>{bands.overall}</strong> · Beat-syncing {bands.beatSyncing} · Balance {bands.balance} · Phrasing {bands.phrasing}
        </p>
      )}
      {graded === null ? null : (
        <ul className="result-criteria">
          {graded.criteria
            .filter((criterion) => criterion.severity !== "report")
            .map((criterion) => (
              <li key={criterion.id} data-status={criterion.status} data-severity={criterion.severity}>
                {describeSetCriterion(criterion) ?? describeCriterion(criterion)}
                {criterion.severity === "warn" && criterion.status === "notMet" ? " (a tip, not a fail)" : null}
              </li>
            ))}
        </ul>
      )}
      {transitions.length === 0 ? null : (
        <table className="set-transitions" aria-label="Transitions">
          <thead>
            <tr>
              <th>#</th>
              <th>From → to</th>
              <th>Kind</th>
              <th>Phrase</th>
              <th>Levels</th>
              <th>In phase</th>
            </tr>
          </thead>
          <tbody>
            {transitions.map((transition) => (
              <tr key={transition.number} data-met={transition.met}>
                <td>{transition.number}</td>
                <td>
                  {title(transition.fromTrackId)} → {title(transition.toTrackId)}
                </td>
                <td>{KIND_WORDS[transition.kind]}</td>
                <td>{transition.phraseBeats === null ? "–" : `${transition.phraseBeats.toFixed(2)} beats`}</td>
                <td>{transition.levelDb === null ? "–" : `${transition.levelDb.toFixed(1)} dB`}</td>
                <td>{transition.phaseHold === null ? "–" : `${String(Math.round(transition.phaseHold * 100))}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="set-recording" aria-label="Recording">
        {recording === null || audioUrl === null ? (
          <p>No recording: {recordingProblem ?? "the browser did not record the set"}.</p>
        ) : (
          <>
            <audio controls src={audioUrl} aria-label="Your set" />
            <p>
              {minutes(recording.durationSec)} recorded{recording.truncated ? " (the end was cut off: the recording hit its size limit)" : ""}.
            </p>
            <div className="result-actions">
              <a className="btn" href={audioUrl} download={`learn-to-dj-set-${day}.${fileExtensionOf(recording.mimeType)}`}>
                Download the mix
              </a>
              {notesUrl === null ? null : (
                <a className="btn" href={notesUrl} download={`learn-to-dj-set-${day}.txt`}>
                  Download the track list
                </a>
              )}
              <button type="button" className="btn btn-primary" disabled={keep.kind === "saving" || keep.kind === "kept"} onClick={onKeep}>
                {keep.kind === "kept" ? "Kept as your final project" : keep.kind === "saving" ? "Keeping…" : "Keep as my final project"}
              </button>
            </div>
            {keep.kind === "failed" ? (
              <p className="lesson-problem" role="alert">
                {keep.message}
              </p>
            ) : null}
          </>
        )}
      </div>
      <div className="result-actions">
        <button type="button" className="btn" onClick={onAgain}>
          Build another set
        </button>
        <button type="button" className="btn btn-quiet" onClick={onExit}>
          Back to the Lessons
        </button>
      </div>
    </section>
  );
}
