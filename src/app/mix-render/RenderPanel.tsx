// The Render on the Mix plans page (ISS-190): render the open plan from the Learner's own files, see
// it progress (and cancel it), then play it and download it as WAV or MP3. Everything here works from
// the FLX4: the ring reaches each button and link, and LOAD A starts the Render (data-nav-default).
import { useEffect, useMemo, useRef, useState } from "react";
import { ButtonHint } from "../controller/KeyHint.tsx";
import type { MixPlanProblem } from "@shared/mix-plan-validate.ts";
import type { MixPlan, PlanGrid } from "@shared/mix-plan.ts";
import { mp3Bytes, renderExportPath, wavBytes, type RenderSession } from "@shared/mix-render.ts";
import { ApiRenderSink } from "./api.ts";
import { clock, RENDER_SAMPLE_RATE, renderMixPlan, type RenderFailure, type RenderResult } from "./render.ts";
import { setTimeline } from "./timeline.ts";
import "./render.css";

/** One plan track as this device has it: its file (null while missing) and its beat grid (null until known). */
export interface RenderableTrack {
  readonly file: { readonly name: string; readonly read: () => Promise<Blob> } | null;
  readonly grid: PlanGrid | null;
}

type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "running"; readonly fraction: number; readonly caption: string }
  | { readonly kind: "done"; readonly result: RenderResult; readonly session: RenderSession }
  | { readonly kind: "failed"; readonly failure: Exclude<RenderFailure, { kind: "cancelled" }> }
  | { readonly kind: "cancelled" };

/** Plan problems a Render plays through: a re-analysed grid is played as it is now. */
const PLAYABLE: ReadonlySet<MixPlanProblem["kind"]> = new Set(["grid-changed", "no-name"]);

const megabytes = (bytes: number) => `${String(Math.max(1, Math.round(bytes / 1024 / 1024)))} MB`;
const decibels = (value: number) => (value === Number.NEGATIVE_INFINITY ? "silent" : `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(1)}`);

/** What stops the plan from rendering now, each with what to do. */
function blockers(plan: MixPlan, tracks: readonly RenderableTrack[], problems: readonly MixPlanProblem[]): string[] {
  const missing = tracks.flatMap((track, index) => (track.file === null ? [`Find ${plan.tracks[index]?.fileName ?? `track ${String(index + 1)}`} above.`] : []));
  const ungridded = tracks.flatMap((track, index) => (track.file !== null && track.grid === null ? [`Track ${String(index + 1)} has no beat grid yet: it would not decode, or has no steady beat. Pick another file for it.`] : []));
  const planned = problems.filter((problem) => !PLAYABLE.has(problem.kind)).map((problem) => `${problem.message} ${problem.fix}`);
  return [...missing, ...ungridded, ...planned];
}

export function RenderPanel({ plan, tracks, problems }: { readonly plan: MixPlan; readonly tracks: readonly RenderableTrack[]; readonly problems: readonly MixPlanProblem[] }) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const running = useRef<{ readonly cancel: AbortController; readonly sink: ApiRenderSink } | null>(null);
  const blocked = useMemo(() => blockers(plan, tracks, problems), [plan, tracks, problems]);
  const grids = useMemo(() => {
    const known = tracks.flatMap((track) => (track.grid === null ? [] : [track.grid]));
    return known.length === tracks.length ? known : null;
  }, [tracks]);
  const estimate = useMemo(() => {
    if (grids === null) return null;
    const timed = setTimeline(plan, grids);
    return timed.ok ? Math.ceil(timed.timeline.durationSec * RENDER_SAMPLE_RATE) : null;
  }, [plan, grids]);

  // Leaving the page cancels a Render under way.
  useEffect(
    () => () => {
      running.current?.cancel.abort();
    },
    [],
  );

  const start = async () => {
    if (grids === null || blocked.length > 0) return;
    const sources = tracks.map((track, index) => {
      const { file } = track;
      if (file === null) throw new Error(`Track ${String(index + 1)} has no file: the Render button is disabled until every track is found.`);
      return file;
    });
    const sink = new ApiRenderSink({ name: plan.name, tracks: plan.tracks.map((track) => `${track.artist ?? "Unknown artist"} – ${track.title ?? track.fileName}`) });
    const cancel = new AbortController();
    running.current = { cancel, sink };
    setPhase({ kind: "running", fraction: 0, caption: "Starting" });
    const outcome = await renderMixPlan({
      plan,
      grids,
      sources,
      sink,
      signal: cancel.signal,
      onProgress: ({ fraction, caption }) => {
        setPhase({ kind: "running", fraction, caption });
      },
    });
    running.current = null;
    if (outcome.ok && sink.session !== null) {
      setPhase({ kind: "done", result: outcome.result, session: sink.session });
      return;
    }
    await sink.drop();
    if (outcome.ok) throw new Error("A finished Render has a server session: ApiRenderSink.begin sets it.");
    setPhase(outcome.failure.kind === "cancelled" ? { kind: "cancelled" } : { kind: "failed", failure: outcome.failure });
  };

  return (
    <section className="plans-panel render-panel" aria-label="Render">
      <h2>Render</h2>
      {phase.kind === "running" ? (
        <Running phase={phase} onCancel={() => running.current?.cancel.abort()} />
      ) : (
        <>
          {phase.kind === "done" ? <Done result={phase.result} session={phase.session} /> : null}
          {phase.kind === "failed" ? <Failed failure={phase.failure} /> : null}
          {phase.kind === "cancelled" ? <p role="status">Cancelled. Nothing was kept.</p> : null}
          {phase.kind === "idle" ? (
            <p className="plans-caption">
              Plays the whole set offline from your own files, exactly as planned, into one file
              {estimate === null ? "" : ` · ${clock(estimate / RENDER_SAMPLE_RATE)} · WAV ${megabytes(wavBytes(estimate))}, MP3 ${megabytes(mp3Bytes(estimate, RENDER_SAMPLE_RATE))}`}
            </p>
          ) : null}
          {blocked.length > 0 ? (
            <>
              <p className="plans-caption">To render, first:</p>
              <ul className="plans-problems" aria-label="Before rendering">
                {blocked.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </>
          ) : null}
          <div className="plans-actions">
            <button type="button" className="btn btn-primary" disabled={blocked.length > 0} onClick={() => void start()} data-nav-default>
              {phase.kind === "idle" ? "Render the set" : "Render again"} <ButtonHint k="Enter" />
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function Running({ phase, onCancel }: { readonly phase: Extract<Phase, { kind: "running" }>; readonly onCancel: () => void }) {
  return (
    <>
      <progress className="render-progress" max={1} value={phase.fraction} aria-label="Render progress" />
      <p role="status" className="render-status">
        {phase.caption} · {String(Math.floor(phase.fraction * 100))}%
      </p>
      <div className="plans-actions">
        <button type="button" className="btn btn-quiet" onClick={onCancel} data-nav-start>
          Cancel
        </button>
      </div>
    </>
  );
}

function Done({ result, session }: { readonly result: RenderResult; readonly session: RenderSession }) {
  const { levels, masterTempo } = result;
  const wav = session.formats.wav;
  const mp3 = session.formats.mp3;
  return (
    <div className="render-done">
      <p role="status">
        Rendered {clock(result.durationSec)} · peak {decibels(levels.peakDbfs)} dBFS · {decibels(levels.integratedLufs)} LUFS integrated · not normalised
      </p>
      {masterTempo.kind === "off" ? (
        <p className="plans-caption">
          Rendered without Master Tempo for track{masterTempo.tracks.length === 1 ? "" : "s"} {masterTempo.tracks.join(", ")}: the key shifts with tempo.
        </p>
      ) : masterTempo.kind === "kept" ? (
        <p className="plans-caption">Master Tempo on: every track keeps its key at the set's tempo.</p>
      ) : null}
      {levels.clippedSamples > 0 ? (
        <p className="lesson-problem" role="alert">
          {String(levels.clippedSamples)} samples clipped (peak above 0 dBFS). Lower the loudest tracks' levels in the plan, then render again.
        </p>
      ) : null}
      {wav.available ? <audio className="render-player" controls preload="none" src={renderExportPath(session.id, "wav")} aria-label="Play the Render" /> : null}
      <div className="plans-actions">
        {wav.available ? (
          <a className="btn btn-primary" href={renderExportPath(session.id, "wav")} download>
            Download WAV ({megabytes(wav.bytes)})
          </a>
        ) : (
          <p className="plans-caption">WAV: {wav.reason}</p>
        )}
        {mp3.available ? (
          <a className="btn btn-quiet" href={renderExportPath(session.id, "mp3")} download>
            Download MP3 ({megabytes(mp3.bytes)})
          </a>
        ) : (
          <p className="plans-caption">MP3: {mp3.reason}</p>
        )}
      </div>
    </div>
  );
}

function Failed({ failure }: { readonly failure: Exclude<RenderFailure, { kind: "cancelled" }> }) {
  if (failure.kind === "plan") {
    return (
      <ul className="plans-problems" role="alert" aria-label="Why it could not render">
        {failure.problems.map((problem) => (
          <li key={problem.message}>
            {problem.message} {problem.fix}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <p className="lesson-problem" role="alert">
      {failure.message} {failure.fix}
    </p>
  );
}
