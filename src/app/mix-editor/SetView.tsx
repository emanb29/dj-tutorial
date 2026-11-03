// The set view: track, Transition, track, and so on, each Transition with its recipe, a one-line
// summary, its Complexity rating chip, and Preview, Practise and Edit. Above it, the whole set as one
// strip (each track as long as it plays), so an hour-long set is one glance and one click per pair.
import { memo } from "react";
import type { MixPlan } from "@shared/mix-plan.ts";
import { deckOf } from "../mix-plans/deck-layout.ts";
import { transitionSummary } from "./editor-text.ts";
import type { ExecutionPlan } from "./execution-plan.ts";
import { RatingChip } from "./ExecutionStrip.tsx";
import type { PlanTrackData } from "./plan-tracks.ts";

export interface SetViewProps {
  readonly plan: MixPlan;
  readonly tracks: readonly (PlanTrackData | undefined)[];
  readonly executions: readonly ExecutionPlan[];
  readonly selected: number | null;
  readonly previewing: number | null;
  readonly readOnly: boolean;
  readonly onEdit: (index: number) => void;
  readonly onPreview: (index: number) => void;
  readonly onRemoveTrack: (index: number) => void;
  readonly onFind: (index: number, file: File) => void;
}

const minutes = (ms: number) => {
  const seconds = Math.round(ms / 1000);
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`;
};

/** The whole set as one strip; a pair's Transition is a mark at the outgoing track's end. */
export function SetOverview({ plan, selected, onEdit }: Pick<SetViewProps, "plan" | "selected" | "onEdit">) {
  const total = plan.tracks.reduce((sum, track) => sum + track.durationMs, 0) || 1;
  return (
    <div className="me-overview" role="group" aria-label="The whole set">
      {plan.tracks.map((track, index) => (
        <button
          key={`${track.contentHash}-${String(index)}`}
          type="button"
          tabIndex={-1}
          data-nav-skip
          className={`me-overview-track me-deck-${deckOf(index)}${selected === index || selected === index - 1 ? " me-overview-selected" : ""}`}
          style={{ flexGrow: track.durationMs / total }}
          title={`Track ${String(index + 1)}: ${track.title ?? track.fileName} (${minutes(track.durationMs)})`}
          disabled={index >= plan.transitions.length}
          onClick={() => {
            onEdit(Math.min(index, plan.transitions.length - 1));
          }}
        >
          {index + 1}
        </button>
      ))}
    </div>
  );
}

export const SetView = memo(function SetView(props: SetViewProps) {
  const { plan, tracks, executions, selected, previewing, readOnly } = props;
  return (
    <ol className="me-set" aria-label="Set">
      {plan.tracks.map((track, index) => {
        const here = tracks[index];
        const missing = here?.resolution.kind === "missing";
        const transition = plan.transitions[index];
        const execution = executions[index];
        const greyed = missing || tracks[index + 1]?.resolution.kind === "missing";
        return (
          <li key={`${track.contentHash}-${String(index)}`} className="me-set-item">
            <div className="me-set-track" data-found={missing ? "no" : "yes"}>
              <span className={`me-deck me-deck-${deckOf(index)}`}>{deckOf(index)}</span>
              <span className="me-set-title">
                <strong>{track.title ?? track.fileName}</strong>
                <span className="me-caption">
                  {track.artist ?? ""} · {minutes(track.durationMs)}
                  {here?.grid == null ? "" : ` · ${here.grid.bpm.toFixed(1)} BPM`}
                  {here === undefined ? " · finding…" : ""}
                </span>
              </span>
              {here?.resolution.kind === "missing" ? (
                <label className="btn btn-primary me-file">
                  {here.resolution.caption}
                  <input
                    type="file"
                    accept="audio/*"
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = "";
                      if (file !== undefined) props.onFind(index, file);
                    }}
                  />
                </label>
              ) : null}
              {readOnly ? null : (
                <button type="button" className="btn btn-quiet me-small" disabled={plan.tracks.length <= 2} onClick={() => {
                    props.onRemoveTrack(index);
                  }} aria-label={`Remove track ${String(index + 1)}`}>
                  ✕
                </button>
              )}
            </div>
            {transition === undefined || execution === undefined ? null : (
              <div className={`me-set-transition${selected === index ? " me-set-selected" : ""}${greyed ? " me-greyed" : ""}`} data-transition={index} aria-current={selected === index ? "true" : undefined}>
                <span className="me-set-summary">↓ {transitionSummary(transition)}</span>
                <RatingChip rating={execution.complexity.rating} />
                <span className="me-set-actions">
                  <button type="button" className="btn btn-quiet me-small" disabled={greyed || here?.grid == null} aria-label={`${previewing === index ? "Stop" : "Preview"} Transition ${String(index + 1)}`} onClick={() => {
                      props.onPreview(index);
                    }}>
                    {previewing === index ? "■" : "▶"}
                  </button>
                  <button type="button" className="btn btn-quiet me-small" disabled title="Practising a Transition comes in a later version">
                    Practise
                  </button>
                  {readOnly ? null : (
                    <button type="button" className="btn btn-quiet me-small" aria-label={`Edit Transition ${String(index + 1)}`} onClick={() => {
                        props.onEdit(index);
                      }}>
                      Edit
                    </button>
                  )}
                </span>
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
});
