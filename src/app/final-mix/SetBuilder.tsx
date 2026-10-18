// The set builder: pick 3+ tracks of one genre from the library (BPM and key shown), put them in
// order, tag a genre where the source has none, and nudge a file's phrase anchor by whole bars (track
// prep, check-design §5.4). Tempo gaps over ±2% and key clashes are warnings; only the set rules block.
import { useState } from "react";
import { SET_GENRES, SET_RULES, setProblems, warningText, type SetEntry } from "@lessons";
import type { Library, LibraryItem, PreparedTrack } from "./library.ts";

export interface PickedTrack {
  readonly key: string;
  readonly entry: SetEntry;
  readonly prepared: PreparedTrack;
}

interface SetBuilderProps {
  readonly library: Library;
  readonly picked: readonly PickedTrack[];
  readonly preparing: string | null;
  readonly problem: string | null;
  readonly onAdd: (item: LibraryItem) => void;
  readonly onFiles: (files: FileList) => void;
  readonly onChange: (picked: readonly PickedTrack[]) => void;
  readonly onStart: () => void;
}

const bpmText = (bpm: number | null) => (bpm === null ? "BPM ?" : `${bpm.toFixed(1)} BPM`);

export function SetBuilder({ library, picked, preparing, problem, onAdd, onFiles, onChange, onStart }: SetBuilderProps) {
  const [filter, setFilter] = useState("");
  const entries = picked.map((track) => track.entry);
  const { blocking, warnings } = setProblems(entries);
  const inSet = new Set(picked.map((track) => track.key));
  const shown = library.items.filter((item) => `${item.title} ${item.artist} ${item.genre ?? ""}`.toLowerCase().includes(filter.trim().toLowerCase()));
  const move = (index: number, by: number) => {
    const next = [...picked];
    const [moved] = next.splice(index, 1);
    if (moved === undefined) return;
    next.splice(Math.max(0, Math.min(next.length, index + by)), 0, moved);
    onChange(next);
  };
  const update = (index: number, entry: Partial<SetEntry>) => {
    onChange(picked.map((track, at) => (at === index ? { ...track, entry: { ...track.entry, ...entry } } : track)));
  };

  return (
    <div className="set-builder">
      <section className="set-picked" aria-label="Your set">
        <h2>Your set</h2>
        <p className="set-hint">
          {SET_RULES.minTracks}+ tracks, one genre, tempos within 2% of track 1. A blend and a cut, all by ear.
        </p>
        {picked.length === 0 ? <p className="set-empty">Add tracks from the library.</p> : null}
        <ol>
          {picked.map((track, index) => {
            const { candidate } = track.entry;
            const tags = [...new Set([...(candidate.genre === null ? [] : [candidate.genre]), ...SET_GENRES])];
            return (
              <li key={track.key} data-track={candidate.track.trackId}>
                <span className="set-title">
                  {candidate.track.title}
                  <small>
                    {candidate.artist} · {bpmText(candidate.track.grid.bpm)} · {candidate.camelot ?? "key ?"}
                  </small>
                </span>
                <label className="set-genre">
                  Genre
                  <select
                    value={track.entry.genre ?? ""}
                    aria-label={`Genre of ${candidate.track.title}`}
                    onChange={(event) => {
                      update(index, { genre: event.target.value === "" ? null : event.target.value });
                    }}
                  >
                    <option value="">Pick…</option>
                    {tags.map((genre) => (
                      <option key={genre} value={genre}>
                        {genre}
                      </option>
                    ))}
                  </select>
                </label>
                {candidate.track.source === "original" || candidate.track.source === "synthetic" ? null : (
                  <label className="set-shift">
                    Phrase start: bar {1 + track.entry.phraseShiftBars}
                    <input
                      type="range"
                      min={0}
                      max={7}
                      step={1}
                      value={track.entry.phraseShiftBars}
                      aria-label={`Phrase start of ${candidate.track.title}, in bars`}
                      onChange={(event) => {
                        update(index, { phraseShiftBars: Number(event.target.value) });
                      }}
                    />
                  </label>
                )}
                <span className="set-row-actions">
                  <button type="button" className="btn" aria-label={`Move ${candidate.track.title} up`} disabled={index === 0} onClick={() => { move(index, -1); }}>
                    ↑
                  </button>
                  <button type="button" className="btn" aria-label={`Move ${candidate.track.title} down`} disabled={index === picked.length - 1} onClick={() => { move(index, 1); }}>
                    ↓
                  </button>
                  <button type="button" className="btn" aria-label={`Remove ${candidate.track.title}`} onClick={() => { onChange(picked.filter((_, at) => at !== index)); }}>
                    ✕
                  </button>
                </span>
              </li>
            );
          })}
        </ol>
        {warnings.length === 0 ? null : (
          <ul className="set-warnings" aria-label="Warnings">
            {warnings.map((warning) => (
              <li key={`${warning.kind}-${String(warning.index)}`} data-kind={warning.kind}>
                {warningText(warning, entries)}
              </li>
            ))}
          </ul>
        )}
        {problem === null ? null : (
          <p className="lesson-problem" role="alert">
            {problem}
          </p>
        )}
        <div className="set-start">
          {blocking.length === 0 ? null : (
            <ul className="set-blocking" aria-label="Before you start">
              {blocking.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
          <button type="button" className="btn btn-primary" disabled={blocking.length > 0 || preparing !== null} onClick={onStart}>
            Load the set
          </button>
        </div>
      </section>

      <section className="set-library" aria-label="Library">
        <h2>Library</h2>
        <div className="set-library-tools">
          <input type="search" placeholder="Search" aria-label="Search the library" value={filter} onChange={(event) => { setFilter(event.target.value); }} />
          {library.files === null ? null : (
            <label className="btn set-files">
              Add your files
              <input
                type="file"
                multiple
                accept="audio/*"
                onChange={(event) => {
                  if (event.target.files !== null) onFiles(event.target.files);
                  event.target.value = "";
                }}
              />
            </label>
          )}
        </div>
        {preparing === null ? null : (
          <p className="set-preparing" role="status">
            {preparing}
          </p>
        )}
        {shown.length === 0 ? <p className="set-empty">No tracks here yet. Add your own files.</p> : null}
        <ul>
          {shown.map((item) => (
            <li key={item.key} data-library={item.key}>
              <span className="set-title">
                {item.title}
                <small>
                  {item.artist} · {bpmText(item.bpm)} · {item.camelot ?? "key ?"} · {item.genre ?? "no genre"}
                </small>
              </span>
              <button
                type="button"
                className="btn"
                aria-label={`Add ${item.title}`}
                disabled={inSet.has(item.key) || preparing !== null || picked.length >= SET_RULES.maxTracks}
                onClick={() => {
                  onAdd(item);
                }}
              >
                {inSet.has(item.key) ? "Added" : "Add"}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
