// The library browser's filters, folded away until wanted. Every value is a list or a checkbox, never a
// text box, so BROWSE sets them all: press on a list, turn to change it, press again to finish.
import { useEffect, useMemo, useRef } from "react";
import { CAMELOT_KEYS, facetValues, keyText, narrowed, type BpmFilter, type LibraryFilter, type LibraryRow } from "./browse.ts";

const BPMS = Array.from({ length: 141 }, (_, index) => 60 + index);
/** ± %: the tempo fader's ranges (6, 10, 16) and the tighter steps a blend wants. */
const PERCENTS = [1, 2, 3, 4, 6, 8, 10, 16];
const LENGTHS_SEC = [60, 120, 180, 240, 300, 360, 420, 480, 600, 900];
const ANY = "";

const minutes = (seconds: number) => `${String(seconds / 60)} min`;
const numberOrNull = (value: string) => (value === ANY ? null : Number(value));

interface LibraryFiltersProps {
  readonly rows: readonly LibraryRow[];
  readonly filter: LibraryFilter;
  readonly onChange: (filter: LibraryFilter) => void;
}

/** The BPM a "± %" filter starts from: the middle of the library's tempos, or 124. */
function typicalBpm(rows: readonly LibraryRow[]): number {
  const known = rows.flatMap((row) => (row.bpm === null ? [] : [row.bpm])).toSorted((a, b) => a - b);
  const middle = known[Math.floor(known.length / 2)];
  return middle === undefined ? 124 : Math.min(200, Math.max(60, Math.round(middle)));
}

export function LibraryFilters({ rows, filter, onChange }: LibraryFiltersProps) {
  const genres = useMemo(() => facetValues(rows, filter, "genre").values, [rows, filter]);
  const artists = useMemo(() => facetValues(rows, filter, "artist").values, [rows, filter]);
  const set = (next: Partial<LibraryFilter>) => {
    onChange({ ...filter, ...next });
  };
  const setBpm = (bpm: BpmFilter) => {
    set({ bpm });
  };
  // Open at first when a remembered filter narrows the list, so the Learner sees why; theirs after that.
  const details = useRef<HTMLDetailsElement>(null);
  const openAtFirst = useRef(narrowed(filter));
  useEffect(() => {
    if (openAtFirst.current && details.current !== null) details.current.open = true;
  }, []);
  const on = [filter.bpm.kind !== "any", filter.key !== null, filter.genre !== null, filter.artist !== null, filter.length.minSec !== null || filter.length.maxSec !== null, filter.gridReadyOnly].filter(Boolean).length;

  return (
    <details ref={details} className="lb-filters">
      <summary>Filters{on === 0 ? "" : ` · ${String(on)} on`}</summary>
      <div className="lb-filter-grid">
        <label className="lb-field">
          BPM
          <select
            aria-label="BPM filter"
            value={filter.bpm.kind}
            onChange={(event) => {
              const kind = event.currentTarget.value;
              setBpm(kind === "range" ? { kind, min: null, max: null } : kind === "near" ? { kind, bpm: typicalBpm(rows), percent: 6 } : { kind: "any" });
            }}
          >
            <option value="any">Any</option>
            <option value="range">From … to …</option>
            <option value="near">± % of a BPM</option>
          </select>
        </label>
        {filter.bpm.kind === "range" ? (
          <BpmRange bpm={filter.bpm} onChange={setBpm} />
        ) : filter.bpm.kind === "near" ? (
          <BpmNear bpm={filter.bpm} onChange={setBpm} />
        ) : null}
        <label className="lb-field">
          Key
          <select
            aria-label="Key filter"
            value={filter.key?.camelot ?? ANY}
            onChange={(event) => {
              const camelot = event.currentTarget.value;
              set({ key: camelot === ANY ? null : { camelot, compatible: filter.key?.compatible ?? false } });
            }}
          >
            <option value={ANY}>Any</option>
            {CAMELOT_KEYS.map((camelot) => (
              <option key={camelot} value={camelot}>
                {keyText(camelot)}
              </option>
            ))}
          </select>
        </label>
        <label className="lb-check">
          <input
            type="checkbox"
            checked={filter.key?.compatible ?? false}
            disabled={filter.key === null}
            onChange={(event) => {
              if (filter.key !== null) set({ key: { ...filter.key, compatible: event.currentTarget.checked } });
            }}
          />
          and the keys that mix with it
        </label>
        <FacetSelect label="Genre" value={filter.genre} values={genres} onChange={(genre) => { set({ genre }); }} />
        <FacetSelect label="Artist" value={filter.artist} values={artists} onChange={(artist) => { set({ artist }); }} />
        <LengthSelect label="Longer than" value={filter.length.minSec} onChange={(minSec) => { set({ length: { ...filter.length, minSec } }); }} />
        <LengthSelect label="Shorter than" value={filter.length.maxSec} onChange={(maxSec) => { set({ length: { ...filter.length, maxSec } }); }} />
        <label className="lb-check">
          <input
            type="checkbox"
            checked={filter.gridReadyOnly}
            onChange={(event) => {
              set({ gridReadyOnly: event.currentTarget.checked });
            }}
          />
          Grid ready only
        </label>
      </div>
    </details>
  );
}

function BpmRange({ bpm, onChange }: { readonly bpm: Extract<BpmFilter, { kind: "range" }>; readonly onChange: (bpm: BpmFilter) => void }) {
  return (
    <>
      <label className="lb-field">
        From
        <select aria-label="Lowest BPM" value={bpm.min === null ? ANY : String(bpm.min)} onChange={(event) => { onChange({ ...bpm, min: numberOrNull(event.currentTarget.value) }); }}>
          <option value={ANY}>Any</option>
          {BPMS.map((each) => (
            <option key={each} value={each}>
              {each}
            </option>
          ))}
        </select>
      </label>
      <label className="lb-field">
        To
        <select aria-label="Highest BPM" value={bpm.max === null ? ANY : String(bpm.max)} onChange={(event) => { onChange({ ...bpm, max: numberOrNull(event.currentTarget.value) }); }}>
          <option value={ANY}>Any</option>
          {BPMS.map((each) => (
            <option key={each} value={each}>
              {each}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

function BpmNear({ bpm, onChange }: { readonly bpm: Extract<BpmFilter, { kind: "near" }>; readonly onChange: (bpm: BpmFilter) => void }) {
  return (
    <>
      <label className="lb-field">
        Of
        <select aria-label="BPM to mix with" value={String(Math.round(bpm.bpm))} onChange={(event) => { onChange({ ...bpm, bpm: Number(event.currentTarget.value) }); }}>
          {BPMS.map((each) => (
            <option key={each} value={each}>
              {each} BPM
            </option>
          ))}
        </select>
      </label>
      <label className="lb-field">
        ±
        <select aria-label="How far from it" value={String(bpm.percent)} onChange={(event) => { onChange({ ...bpm, percent: Number(event.currentTarget.value) }); }}>
          {PERCENTS.map((each) => (
            <option key={each} value={each}>
              {each} %
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

function FacetSelect({ label, value, values, onChange }: { readonly label: string; readonly value: string | null; readonly values: readonly { readonly value: string; readonly count: number }[]; readonly onChange: (value: string | null) => void }) {
  // A picked value stays listed even when the rest of the filter leaves it no tracks.
  const listed = value === null || values.some((each) => each.value.toLowerCase() === value.toLowerCase()) ? values : [{ value, count: 0 }, ...values];
  return (
    <label className="lb-field">
      {label}
      <select aria-label={`${label} filter`} value={listed.find((each) => each.value.toLowerCase() === value?.toLowerCase())?.value ?? ANY} onChange={(event) => { onChange(event.currentTarget.value === ANY ? null : event.currentTarget.value); }}>
        <option value={ANY}>Any</option>
        {listed.map((each) => (
          <option key={each.value} value={each.value}>
            {each.value} ({each.count.toLocaleString()})
          </option>
        ))}
      </select>
    </label>
  );
}

function LengthSelect({ label, value, onChange }: { readonly label: string; readonly value: number | null; readonly onChange: (value: number | null) => void }) {
  return (
    <label className="lb-field">
      {label}
      <select aria-label={label} value={value === null ? ANY : String(value)} onChange={(event) => { onChange(numberOrNull(event.currentTarget.value)); }}>
        <option value={ANY}>Any</option>
        {LENGTHS_SEC.map((each) => (
          <option key={each} value={each}>
            {minutes(each)}
          </option>
        ))}
      </select>
    </label>
  );
}
