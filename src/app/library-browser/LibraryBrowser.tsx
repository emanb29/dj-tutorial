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
//
// The mini player, where the picker gives a preview: each row's ▶ plays that track from where it says
// what it is (preview-start.ts), one at a time (preview-player.ts); the playing row shows a progress bar
// to tap and the time. BROWSE press (Space) on a row plays or pauses it; SHIFT + BROWSE turn (← / →)
// jumps 16 bars. Opening a file waits for play, so a row that is never played is never read.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import type { TrackPreview } from "@tracks";
import { PREVIEW_BUTTONS } from "../controller/flx4-keys.ts";
import { useControllerConnected } from "../controller/KeyHint.tsx";
import { FLX4_LOAD_EVENT, FLX4_PREVIEW_JUMP_EVENT, TYPING_NOTICE, type Flx4LoadDetail, type Flx4PreviewJumpDetail } from "../controller/focus-navigation.ts";
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
import { columnTemplate, COLUMN_GAP_PX, layoutFor, ROW_PADDING_PX, shownColumns } from "./layout.ts";
import { LibraryFilters } from "./LibraryFilters.tsx";
import { previewPlayer, type PreviewPlayer, type PreviewSnapshot } from "./preview-player.ts";
import { readBrowseState, writeBrowseState, type BrowseState } from "./remembered.ts";
import { VirtualList } from "./VirtualList.tsx";
import "./library-browser.css";

/** One row's height, px: two lines when narrow, one row of columns when they fit (layout.ts). */
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
  /** The row's preview for the mini player; null: none for this track. Without it, rows have no ▶. Reads nothing. */
  readonly preview?: (row: LibraryRow) => TrackPreview | null;
  /** The player previews go through: the app's one by default (tests give their own). */
  readonly player?: PreviewPlayer;
}

const pressed = (descending: boolean) => (descending ? "↓" : "↑");

export function LibraryBrowser({ picker, rows, onLoad, onLoadOffList, onRowFocus, actions, controllerHint, emptyText, navStart = false, preview, player: givenPlayer }: LibraryBrowserProps) {
  const [state, setState] = useState<BrowseState>(() => readBrowseState(picker));
  const [typing, setTyping] = useState(false);
  const [focusFirst, setFocusFirst] = useState(0);
  const section = useRef<HTMLElement>(null);
  const browseBySelect = useRef<HTMLSelectElement>(null);
  const controllerConnected = useControllerConnected();
  const { filter, sort, browseBy } = state;
  const [widthPx, setWidthPx] = useState(0);
  const [actionsPx, setActionsPx] = useState(0);
  const [scrollbarPx, setScrollbarPx] = useState(0);
  const [player] = useState(() => givenPlayer ?? previewPlayer());
  const [owner] = useState(() => Symbol(picker));
  const playerState = useSyncExternalStore(player.subscribe, player.snapshot);
  const previewing = playerState.owner === owner ? playerState : null;

  // The layout follows the browser's own width (a card on a wide screen can be narrow), so measure it.
  useLayoutEffect(() => {
    const element = section.current;
    if (element === null) return;
    const measure = () => {
      setWidthPx(element.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    writeBrowseState(picker, state);
  }, [picker, state]);

  const shown = useMemo(() => sortRows(filterRows(rows, filter), sort), [rows, filter, sort]);
  const facets = useMemo(() => (browseBy === null ? null : facetValues(rows, filter, browseBy)), [rows, filter, browseBy]);
  const byKey = useMemo(() => new Map(shown.map((row) => [row.key, row])), [shown]);
  const columns = useMemo(() => shownColumns(rows), [rows]);
  const layout = layoutFor(widthPx - scrollbarPx, columns, actionsPx);
  const sortChoices = columns.includes(sort.column) ? columns : [...columns, sort.column];
  const layoutStyle = { "--lb-columns": columnTemplate(columns, actionsPx), "--lb-gap": `${String(COLUMN_GAP_PX)}px`, "--lb-inset": `${String(ROW_PADDING_PX)}px`, "--lb-scrollbar": `${String(scrollbarPx)}px` } as CSSProperties;

  // The row's buttons (+ Add, → A, → B) are the picker's: their width is read off a drawn row. The
  // list's scrollbar narrows the rows and not the header, so the header makes room for it too.
  // React skips the render when a measure is unchanged.
  useLayoutEffect(() => {
    const drawn = section.current?.querySelector<HTMLElement>("li[data-library] .lb-actions");
    setActionsPx(drawn == null ? 0 : Math.ceil(drawn.getBoundingClientRect().width));
    const scroller = section.current?.querySelector<HTMLElement>(".lb-scroll");
    setScrollbarPx(scroller == null ? 0 : Math.max(0, scroller.offsetWidth - scroller.clientWidth - 2));
  }, [shown, browseBy, widthPx]);

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

  const togglePreview = (row: LibraryRow) => {
    const source = preview?.(row) ?? null;
    if (source !== null) void player.toggle(owner, row.key, source);
  };

  // SHIFT + BROWSE turn jumps this browser's playing preview; leaving the page stops it.
  useEffect(() => {
    const onJump = (event: Event) => {
      if (player.snapshot().owner !== owner) return;
      if (player.jump((event as CustomEvent<Flx4PreviewJumpDetail>).detail.step)) event.preventDefault();
    };
    window.addEventListener(FLX4_PREVIEW_JUMP_EVENT, onJump);
    return () => {
      window.removeEventListener(FLX4_PREVIEW_JUMP_EVENT, onJump);
      player.stopIfOwner(owner);
    };
  }, [player, owner]);
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
      data-layout={layout}
      style={layoutStyle}
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
            {sortChoices.map((column) => (
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
      {preview === undefined ? null : <PreviewHint controller={controllerConnected} />}
      {previewing?.problem == null ? null : (
        <p className="lb-note lb-preview-problem" role="alert">
          {previewing.problem}
        </p>
      )}
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
          {/* Two lines have no columns to head: the Sort list sorts there. */}
          {layout === "wide" ? (
            <div className="lb-head" data-nav-skip>
              {columns.map((column) => (
                <button
                  key={column}
                  type="button"
                  tabIndex={-1}
                  className="lb-col"
                  data-column={column}
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
          ) : null}
          <VirtualList<LibraryRow>
            items={shown}
            rowHeight={ROW_HEIGHT}
            label="Tracks"
            navStart={navStart}
            focusFirstSignal={focusFirst}
            itemKey={(row) => row.key}
            rowProps={(row) => {
              const status = previewing?.key === row.key ? previewing.status : undefined;
              return { "aria-label": row.title, className: status === undefined ? "lb-row" : "lb-row lb-previewing", "data-library": row.key, "data-preview": status };
            }}
            {...(onRowFocus === undefined ? {} : { onRowFocus })}
            {...(preview === undefined ? {} : { onRowPress: togglePreview })}
            onRowKey={(row, event) => {
              if (event.key === "Enter") {
                onLoad(row, event.shiftKey ? "B" : "A");
                return true;
              }
              if (preview === undefined) return false;
              if (event.key === " ") {
                togglePreview(row);
                return true;
              }
              const by = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
              return by !== 0 && previewing?.key === row.key && player.jump(by);
            }}
            render={(row) => (
              <TrackCells
                row={row}
                columns={columns}
                actions={actions?.(row) ?? null}
                previewButton={
                  preview === undefined ? null : (
                    <PreviewButton
                      title={row.title}
                      status={previewing?.key === row.key ? previewing.status : "idle"}
                      available={preview(row) !== null}
                      onPress={() => {
                        togglePreview(row);
                      }}
                    />
                  )
                }
                player={
                  previewing?.key === row.key ? (
                    <MiniPlayer
                      title={row.title}
                      state={previewing}
                      onSeek={(sec) => {
                        player.seek(sec);
                      }}
                    />
                  ) : null
                }
              />
            )}
          />
        </>
      )}
    </section>
  );
}

const CELLS: Readonly<Record<SortColumn, (row: LibraryRow) => ReactNode>> = {
  title: (row) => row.title,
  artist: (row) => row.artist ?? "Unknown artist",
  album: (row) => row.album ?? "",
  genre: (row) => row.genre ?? "",
  bpm: (row) => bpmText(row.bpm),
  key: (row) => keyText(row.camelot),
  length: (row) => lengthText(row.lengthSec),
  rating: (row) => (row.rating === null ? "" : <span aria-label={`${String(row.rating)} stars`}>{"★".repeat(row.rating)}</span>),
  playCount: (row) => (row.playCount === null ? "" : `${row.playCount.toLocaleString()} plays`),
  gridReady: (row) => (row.gridReady ? <span aria-label="Grid ready">▦ grid</span> : ""),
};

/** The row's cells, one per shown column, in the header's order; ▶ and the picker's buttons last; the mini player while it previews. */
function TrackCells({ row, columns, actions, previewButton, player }: { readonly row: LibraryRow; readonly columns: readonly SortColumn[]; readonly actions: ReactNode; readonly previewButton: ReactNode; readonly player: ReactNode }) {
  return (
    <>
      {columns.map((column) => (
        <span key={column} className={column === "title" ? "lb-col-title lb-title" : `lb-col-${column}`}>
          {CELLS[column](row)}
        </span>
      ))}
      {actions === null && previewButton === null ? null : (
        <span className="lb-actions">
          {previewButton}
          {actions}
        </span>
      )}
      {player}
    </>
  );
}

const PLAY = { glyph: "▶", label: (title: string) => `Play a preview of ${title}` };
const PREVIEW_BUTTON: Readonly<Record<PreviewSnapshot["status"], { readonly glyph: string; readonly label: (title: string) => string }>> = {
  idle: PLAY,
  paused: PLAY,
  failed: PLAY,
  opening: { glyph: "…", label: (title) => `Stop opening ${title}` },
  playing: { glyph: "❚❚", label: (title) => `Pause the preview of ${title}` },
};

/** ▶ / ❚❚ for the screen; the FLX4 and the keyboard have BROWSE press and Space on the row. */
function PreviewButton({ title, status, available, onPress }: { readonly title: string; readonly status: PreviewSnapshot["status"]; readonly available: boolean; readonly onPress: () => void }) {
  const shown = PREVIEW_BUTTON[status];
  return (
    <button
      type="button"
      className="btn lb-preview"
      tabIndex={-1}
      data-nav-skip
      aria-label={shown.label(title)}
      aria-pressed={status === "playing"}
      disabled={!available}
      {...(available ? {} : { title: "No preview for this track" })}
      onClick={onPress}
    >
      {shown.glyph}
    </button>
  );
}

/** The playing row's progress: tap or click the bar to seek; the time so far, of the whole. */
function MiniPlayer({ title, state, onSeek }: { readonly title: string; readonly state: PreviewSnapshot; readonly onSeek: (sec: number) => void }) {
  const duration = state.durationSec;
  const fraction = duration === null ? 0 : Math.min(1, state.positionSec / duration);
  const seek = (event: MouseEvent<HTMLDivElement>) => {
    if (duration === null) return;
    const box = event.currentTarget.getBoundingClientRect();
    onSeek(duration * Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)));
  };
  return (
    <div className="lb-player" data-testid="mini-player">
      <div
        className="lb-seek"
        role="slider"
        tabIndex={-1}
        data-nav-skip
        aria-label={`Where in ${title}`}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration ?? 0)}
        aria-valuenow={Math.round(state.positionSec)}
        aria-valuetext={`${lengthText(state.positionSec)} of ${lengthText(duration)}`}
        onClick={seek}
      >
        <span className="lb-seek-fill" style={{ width: `${String(fraction * 100)}%` }} />
      </div>
      <span className="lb-elapsed" data-testid="preview-elapsed">
        {state.status === "opening" ? "Opening…" : `${lengthText(state.positionSec)} / ${lengthText(duration)}`}
        {state.inHeadphones ? " · headphones" : ""}
      </span>
    </div>
  );
}

/** One line: how to preview from the FLX4 (named from the one table, flx4-keys.ts) or the keyboard. */
function PreviewHint({ controller }: { readonly controller: boolean }) {
  const { play, jump } = PREVIEW_BUTTONS;
  return (
    <p className="lb-note" data-testid="preview-hint">
      {controller ? (
        <>
          <kbd className="hw-key">{play.button}</kbd> on a track: preview · <kbd className="hw-key">{jump.button}</kbd>: jump 16 bars
        </>
      ) : (
        <>
          ▶ or <kbd>{play.key}</kbd> on a track: preview · <kbd>{jump.key}</kbd>: jump 16 bars
        </>
      )}
    </p>
  );
}
