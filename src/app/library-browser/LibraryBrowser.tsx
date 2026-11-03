// The library browser (ISS-194): the Learner's music as a DJ library. Search, sort by any column,
// filter (BPM range or ± % of a BPM, key with its compatible keys, genre, artist, length, grid ready)
// and browse by artist, genre or key with track counts. Each picker's choice is remembered on this
// device (remembered.ts). Shared by the "your music" pickers: Mix plans, Freestyle and the set builder.
//
// Metadata only: it is handed rows (folder-rows.ts and the pickers' own), and never opens a file.
//
// From the FLX4 (src/app/controller/flx4-keys.ts): BROWSE turn moves the ring through the controls and
// the rows; BROWSE press opens a list (sort, browse by, a filter) or presses a button; LOAD A / LOAD B
// pick the track with the ring (the picker says what picking does); SHIFT + BROWSE leaves an open
// facet list. The keyboard: Tab or ↑ / ↓, Enter (A), Shift + Enter (B), Esc.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useControllerConnected } from "../controller/KeyHint.tsx";
import { FLX4_LOAD_EVENT, TYPING_NOTICE, type Flx4LoadDetail } from "../controller/focus-navigation.ts";
import {
  bpmText,
  COLUMN_NAMES,
  facetValues,
  FACET_NAMES,
  FACETS,
  filterRows,
  keyText,
  lengthText,
  narrowed,
  NO_FILTER,
  pickFacet,
  SORT_COLUMNS,
  sortRows,
  type Facet,
  type FacetValue,
  type LibraryRow,
  type SortColumn,
} from "./browse.ts";
import { LibraryFilters } from "./LibraryFilters.tsx";
import { readBrowseState, writeBrowseState, type BrowseState } from "./remembered.ts";
import { VirtualList } from "./VirtualList.tsx";
import "./library-browser.css";

/** One row's height, px: two lines at phone width, one row of columns on a wide screen (library-browser.css). */
export const ROW_HEIGHT = 56;

export type Deck = "A" | "B";

export interface LibraryBrowserProps {
  /** Which picker this is ("mix-plans", "freestyle"): its filter and sort are remembered under it. */
  readonly picker: string;
  readonly rows: readonly LibraryRow[];
  /** LOAD A / LOAD B, or Enter / Shift + Enter, on a row. */
  readonly onLoad: (row: LibraryRow, deck: Deck) => void;
  /** LOAD with the ring off the rows. Without it, LOAD is the page's Enter or R, as everywhere. */
  readonly onLoadOffList?: (deck: Deck) => void;
  /** The ring reached a row (Freestyle finds its grid first). */
  readonly onRowFocus?: (row: LibraryRow) => void;
  /** The row's buttons for the screen (+ Add, → A, → B): out of the ring's way, the FLX4 has LOAD. */
  readonly actions?: (row: LibraryRow) => ReactNode;
  /** What LOAD does here, shown while the FLX4 is connected. */
  readonly controllerHint: ReactNode;
  /** Shown when the picker has no tracks at all. */
  readonly emptyText: string;
  /** The ring starts on the first row when nothing has it (data-nav-start). */
  readonly navStart?: boolean;
}

const pressed = (descending: boolean) => (descending ? "↓" : "↑");

export function LibraryBrowser({ picker, rows, onLoad, onLoadOffList, onRowFocus, actions, controllerHint, emptyText, navStart = false }: LibraryBrowserProps) {
  const [state, setState] = useState<BrowseState>(() => readBrowseState(picker));
  const [typing, setTyping] = useState(false);
  const [focusFirst, setFocusFirst] = useState(0);
  const section = useRef<HTMLElement>(null);
  const browseBySelect = useRef<HTMLSelectElement>(null);
  const controllerConnected = useControllerConnected();
  const { filter, sort, browseBy } = state;

  useEffect(() => {
    writeBrowseState(picker, state);
  }, [picker, state]);

  const shown = useMemo(() => sortRows(filterRows(rows, filter), sort), [rows, filter, sort]);
  const facets = useMemo(() => (browseBy === null ? null : facetValues(rows, filter, browseBy)), [rows, filter, browseBy]);
  const byKey = useMemo(() => new Map(shown.map((row) => [row.key, row])), [shown]);

  const update = (next: Partial<BrowseState>) => {
    setState((now) => ({ ...now, ...next }));
  };
  const sortBy = (column: SortColumn) => {
    update({ sort: { column, descending: sort.column === column ? !sort.descending : false } });
  };

  // LOAD A / LOAD B from the FLX4: the track with the ring, before LOAD becomes a key.
  const latest = useRef({ byKey, onLoad, onLoadOffList });
  useEffect(() => {
    latest.current = { byKey, onLoad, onLoadOffList };
  });
  useEffect(() => {
    const onFlx4Load = (event: Event) => {
      const { deck } = (event as CustomEvent<Flx4LoadDetail>).detail;
      const active = document.activeElement;
      const rowElement = active instanceof HTMLElement && section.current?.contains(active) === true ? active.closest<HTMLElement>("[data-library]") : null;
      const row = rowElement === null ? undefined : latest.current.byKey.get(rowElement.dataset["library"] ?? "");
      if (row !== undefined) {
        event.preventDefault();
        latest.current.onLoad(row, deck);
        return;
      }
      if (latest.current.onLoadOffList !== undefined) {
        event.preventDefault();
        latest.current.onLoadOffList(deck);
      }
    };
    window.addEventListener(FLX4_LOAD_EVENT, onFlx4Load);
    return () => {
      window.removeEventListener(FLX4_LOAD_EVENT, onFlx4Load);
    };
  }, []);

  const closeFacets = () => {
    update({ browseBy: null });
    browseBySelect.current?.focus();
  };

  const pick = (facet: Facet, value: FacetValue | null) => {
    update({ filter: value === null ? { ...filter, ...(facet === "key" ? { key: null } : { [facet]: null }) } : pickFacet(filter, facet, value.value), browseBy: null });
    setFocusFirst((count) => count + 1);
  };

  return (
    <section
      ref={section}
      className="library-browser"
      aria-label="Library browser"
      data-picker={picker}
      onKeyDown={(event) => {
        // SHIFT + BROWSE (Esc) leaves an open facet list, before the page's own back.
        if (event.key === "Escape" && browseBy !== null) {
          event.preventDefault();
          event.stopPropagation();
          closeFacets();
        }
      }}
    >
      <div className="lb-tools">
        <input
          type="search"
          className="lb-search"
          aria-label="Search the library"
          placeholder="Search title, artist, genre"
          value={filter.search}
          maxLength={200}
          onFocus={() => {
            setTyping(true);
          }}
          onBlur={() => {
            setTyping(false);
          }}
          onChange={(event) => {
            update({ filter: { ...filter, search: event.currentTarget.value } });
          }}
        />
        <label className="lb-field">
          Browse by
          <select
            ref={browseBySelect}
            aria-label="Browse by"
            value={browseBy ?? "tracks"}
            onChange={(event) => {
              const value = event.currentTarget.value;
              update({ browseBy: FACETS.find((facet) => facet === value) ?? null });
            }}
          >
            <option value="tracks">All tracks</option>
            {FACETS.map((facet) => (
              <option key={facet} value={facet}>
                {FACET_NAMES[facet]}
              </option>
            ))}
          </select>
        </label>
        <label className="lb-field">
          Sort
          <select
            aria-label="Sort"
            value={sort.column}
            onChange={(event) => {
              const value = event.currentTarget.value;
              const column = SORT_COLUMNS.find((each) => each === value);
              if (column !== undefined) update({ sort: { ...sort, column } });
            }}
          >
            {SORT_COLUMNS.map((column) => (
              <option key={column} value={column}>
                {COLUMN_NAMES[column]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn btn-quiet"
          aria-label={sort.descending ? "Sorted high to low: sort low to high" : "Sorted low to high: sort high to low"}
          onClick={() => {
            update({ sort: { ...sort, descending: !sort.descending } });
          }}
        >
          {pressed(sort.descending)}
        </button>
        {/* Over what is below, not above it: showing and hiding it must not move a button under the pointer. */}
        {typing ? (
          <p className="lb-note lb-typing" role="status" data-testid="library-typing">
            {TYPING_NOTICE}
          </p>
        ) : null}
      </div>
      <LibraryFilters
        rows={rows}
        filter={filter}
        onChange={(next) => {
          update({ filter: next });
        }}
      />
      <p className="lb-note" data-testid="library-count">
        {shown.length === rows.length ? `${rows.length.toLocaleString()} tracks` : `${shown.length.toLocaleString()} of ${rows.length.toLocaleString()} tracks`}
        {narrowed(filter) || filter.search.trim() !== "" ? (
          <>
            {" · "}
            <button
              type="button"
              className="btn btn-quiet lb-clear"
              onClick={() => {
                update({ filter: NO_FILTER });
              }}
            >
              Clear filters
            </button>
          </>
        ) : null}
      </p>
      {controllerConnected ? (
        <p className="lb-note" data-testid="flx4-library-hint">
          {controllerHint}
        </p>
      ) : null}
      {browseBy !== null && facets !== null ? (
        <div className="lb-facets">
          <p className="lb-note">
            Pick a {FACET_NAMES[browseBy].toLowerCase()} · <kbd className="hw-key">SHIFT + BROWSE</kbd> or Esc: back to the tracks
            {facets.unknown > 0 ? ` · ${facets.unknown.toLocaleString()} tracks have none` : ""}
          </p>
          <VirtualList<FacetValue | null>
            items={[null, ...facets.values]}
            rowHeight={ROW_HEIGHT}
            label={`${FACET_NAMES[browseBy]}s`}
            itemKey={(value) => value?.value ?? ""}
            rowProps={(value) => ({ "aria-label": value === null ? `Every ${FACET_NAMES[browseBy].toLowerCase()}` : `${value.label}, ${String(value.count)} ${value.count === 1 ? "track" : "tracks"}`, className: "lb-row lb-facet", "data-facet": value?.value ?? "" })}
            onRowKey={(value, event) => {
              if (event.key !== "Enter" && event.key !== " ") return false;
              pick(browseBy, value);
              return true;
            }}
            onRowClick={(value) => {
              pick(browseBy, value);
            }}
            render={(value) => (
              <>
                <span className="lb-title">{value === null ? `Every ${FACET_NAMES[browseBy].toLowerCase()}` : value.label}</span>
                <span className="lb-count">{value === null ? "" : value.count.toLocaleString()}</span>
              </>
            )}
          />
        </div>
      ) : rows.length === 0 ? (
        <p className="lb-note">{emptyText}</p>
      ) : shown.length === 0 ? (
        <p className="lb-note">No tracks match. Clear a filter to see more.</p>
      ) : (
        <>
          <div className="lb-head" data-nav-skip>
            {SORT_COLUMNS.map((column) => (
              <button
                key={column}
                type="button"
                tabIndex={-1}
                className={`lb-col lb-col-${column}`}
                aria-sort={sort.column === column ? (sort.descending ? "descending" : "ascending") : "none"}
                onClick={() => {
                  sortBy(column);
                }}
              >
                {COLUMN_NAMES[column]}
                {sort.column === column ? ` ${pressed(sort.descending)}` : ""}
              </button>
            ))}
          </div>
          <VirtualList<LibraryRow>
            items={shown}
            rowHeight={ROW_HEIGHT}
            label="Tracks"
            navStart={navStart}
            focusFirstSignal={focusFirst}
            itemKey={(row) => row.key}
            rowProps={(row) => ({ "aria-label": row.title, className: "lb-row", "data-library": row.key })}
            {...(onRowFocus === undefined ? {} : { onRowFocus })}
            onRowKey={(row, event) => {
              if (event.key !== "Enter") return false;
              onLoad(row, event.shiftKey ? "B" : "A");
              return true;
            }}
            render={(row) => <TrackCells row={row} actions={actions?.(row) ?? null} />}
          />
        </>
      )}
    </section>
  );
}

function TrackCells({ row, actions }: { readonly row: LibraryRow; readonly actions: ReactNode }) {
  return (
    <>
      <span className="lb-col-title lb-title">{row.title}</span>
      <span className="lb-col-artist">{row.artist ?? "Unknown artist"}</span>
      <span className="lb-col-album">{row.album ?? ""}</span>
      <span className="lb-col-genre">{row.genre ?? ""}</span>
      <span className="lb-col-bpm">{bpmText(row.bpm)}</span>
      <span className="lb-col-key">{keyText(row.camelot)}</span>
      <span className="lb-col-length">{lengthText(row.lengthSec)}</span>
      <span className="lb-col-rating">{row.rating === null ? "" : <span aria-label={`${String(row.rating)} stars`}>{"★".repeat(row.rating)}</span>}</span>
      <span className="lb-col-playCount">{row.playCount === null ? "" : `${row.playCount.toLocaleString()} plays`}</span>
      <span className="lb-col-gridReady">{row.gridReady ? <span aria-label="Grid ready">▦ grid</span> : ""}</span>
      {actions === null ? null : <span className="lb-actions">{actions}</span>}
    </>
  );
}
