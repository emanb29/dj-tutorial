// `/originals`: a small player for the generator's Originals. It polls the list while the tab is
// visible, so a track the composer just finished slides in at the top, and it plays through one
// plain <audio> element that lives outside the list, so a list update never interrupts playback.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ORIGINALS_PATH } from "@shared/originals.ts";
import "./originals.css";
import {
  fetchOriginals,
  filterByGenre,
  formatGenre,
  formatKey,
  formatTime,
  genresOf,
  mergeOriginals,
  stepFrom,
  type ListProblem,
  type OriginalRow,
} from "./originals-list.ts";

const POLL_MS = 20_000;
const SEEK_STEP_SEC = 10;

/** True on touch screens, where the page shows tap controls and no key hints. */
function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia("(pointer: coarse)");
      query.addEventListener("change", onChange);
      return () => {
        query.removeEventListener("change", onChange);
      };
    },
    () => window.matchMedia("(pointer: coarse)").matches,
  );
}

/** The list, refetched every POLL_MS while the tab is visible (and at once when it becomes visible). */
function usePolledOriginals(): { rows: readonly OriginalRow[] | null; problem: ListProblem | null } {
  const [rows, setRows] = useState<readonly OriginalRow[] | null>(null);
  const [problem, setProblem] = useState<ListProblem | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    const fetchFn = globalThis.fetch.bind(globalThis);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;

    const schedule = () => {
      clearTimeout(timer);
      if (document.visibilityState === "visible") timer = setTimeout(() => void poll(), POLL_MS);
    };
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      const result = await fetchOriginals(fetchFn, abort.signal);
      inFlight = false;
      if (abort.signal.aborted) return;
      if (result.ok) {
        setRows((previous) => mergeOriginals(previous, result.originals));
        setProblem(null);
      } else if (result.problem.kind !== "aborted") {
        console.warn(`[originals] ${result.problem.message} ${result.problem.fix}`);
        setProblem(result.problem);
      }
      schedule();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void poll();
      else clearTimeout(timer);
    };

    void poll();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      abort.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return { rows, problem };
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

function PlayIcon({ playing }: { playing: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      {playing ? <path d="M6 5h4v14H6zM14 5h4v14h-4z" fill="currentColor" /> : <path d="M7 4.5v15l12.5-7.5z" fill="currentColor" />}
    </svg>
  );
}

function SkipIcon({ direction }: { direction: "next" | "previous" }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" style={direction === "previous" ? { transform: "scaleX(-1)" } : undefined}>
      <path d="M5 5v14l10-7zM16 5h3v14h-3z" fill="currentColor" />
    </svg>
  );
}

export function OriginalsPlayer() {
  const { rows, problem } = usePolledOriginals();
  const coarse = useCoarsePointer();
  const [genre, setGenre] = useState<string | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playProblem, setPlayProblem] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement>(null);

  const allRows = useMemo(() => rows ?? [], [rows]);
  const genres = useMemo(() => genresOf(allRows), [allRows]);
  const visibleRows = useMemo(() => filterByGenre(allRows, genre), [allRows, genre]);
  const current = allRows.find((row) => row.original.id === currentId)?.original ?? null;
  // The handlers below read these through refs, so they stay stable across polls.
  const visibleRef = useRef(visibleRows);
  const currentRef = useRef(currentId);
  useEffect(() => {
    visibleRef.current = visibleRows;
    currentRef.current = currentId;
  });

  useEffect(() => {
    const previous = document.title;
    document.title = "Originals · Learn to DJ";
    return () => {
      document.title = previous;
    };
  }, []);

  const playTrack = useCallback((id: string) => {
    const element = audio.current;
    if (element === null) return;
    if (currentRef.current !== id) {
      element.src = `${ORIGINALS_PATH}/${encodeURIComponent(id)}/audio`;
      currentRef.current = id;
      setCurrentId(id);
      setElapsed(0);
      setDuration(0);
    }
    setPlayProblem(null);
    element.play().catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return; // A newer play() replaced it.
      setPlayProblem(`Track ${id} didn't start (${error instanceof Error ? error.message : String(error)}). Press play again.`);
    });
  }, []);

  const toggle = useCallback(
    (id?: string) => {
      const element = audio.current;
      const target = id ?? currentRef.current ?? stepFrom(visibleRef.current, null, 1);
      if (element === null || target === null) return;
      if (target === currentRef.current && !element.paused) element.pause();
      else playTrack(target);
    },
    [playTrack],
  );

  const step = useCallback(
    (direction: 1 | -1) => {
      const target = stepFrom(visibleRef.current, currentRef.current, direction);
      if (target !== null) playTrack(target);
    },
    [playTrack],
  );

  const seekBy = useCallback((seconds: number) => {
    const element = audio.current;
    if (element === null || currentRef.current === null || !Number.isFinite(element.duration)) return;
    element.currentTime = Math.min(Math.max(0, element.currentTime + seconds), element.duration);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      // A focused button already answers Space itself (and a row's button toggles that row).
      if (event.code === "Space" && event.target instanceof HTMLButtonElement) return;
      const actions: Record<string, () => void> = {
        Space: () => {
          toggle();
        },
        ArrowRight: () => {
          seekBy(SEEK_STEP_SEC);
        },
        ArrowLeft: () => {
          seekBy(-SEEK_STEP_SEC);
        },
        KeyJ: () => {
          step(1);
        },
        KeyK: () => {
          step(-1);
        },
      };
      const action = actions[event.code];
      if (action === undefined) return;
      event.preventDefault();
      action();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [toggle, seekBy, step]);

  const shownDuration = duration > 0 ? duration : (current?.durationSec ?? 0);
  const count = rows === null ? null : genre === null ? `${String(allRows.length)} tracks` : `${String(visibleRows.length)} of ${String(allRows.length)}`;

  return (
    <main className="originals" data-pointer={coarse ? "coarse" : "fine"}>
      <header className="originals-head">
        <h1>Originals</h1>
        {count !== null && (
          <p className="originals-count" aria-label="Track count">
            {count}
          </p>
        )}
      </header>
      {!coarse && (
        <p className="originals-keys" aria-label="Keyboard shortcuts">
          <kbd>Space</kbd> play/pause <kbd>←</kbd>
          <kbd>→</kbd> seek <kbd>J</kbd> next <kbd>K</kbd> previous
        </p>
      )}

      {problem !== null && (
        <p className="originals-problem" role="alert">
          {problem.message} <span className="originals-fix">{problem.fix}</span>
        </p>
      )}

      {genres.length > 1 && (
        <div className="originals-chips" role="group" aria-label="Filter by genre">
          {[null, ...genres].map((chip) => (
            <button
              key={chip ?? "all"}
              type="button"
              className="originals-chip"
              aria-pressed={genre === chip}
              onClick={() => {
                setGenre(chip);
              }}
            >
              {chip ?? "All"}
            </button>
          ))}
        </div>
      )}

      {rows === null && problem === null && <p className="originals-empty">Loading the Originals…</p>}
      {rows?.length === 0 && (
        <p className="originals-empty">No Originals yet. They appear here as the composer finishes them (the list checks every 20 s).</p>
      )}

      <ol className="originals-list" aria-label="Originals">
        {visibleRows.map(({ original, isNew }) => {
          const isCurrent = original.id === currentId;
          const key = formatKey(original);
          return (
            <li key={original.id} data-original={original.id} data-new={isNew || undefined} data-current={isCurrent || undefined}>
              <button
                type="button"
                className="originals-play"
                aria-label={`${isCurrent && playing ? "Pause" : "Play"} ${original.title}`}
                onClick={() => {
                  toggle(original.id);
                }}
              >
                <PlayIcon playing={isCurrent && playing} />
              </button>
              <div className="originals-text">
                <p className="originals-title">
                  <span className="originals-number">{original.id}</span>
                  {original.title}
                  {isNew && <span className="originals-new">new</span>}
                </p>
                {original.topic !== undefined && <p className="originals-topic">{original.topic}</p>}
                <p className="originals-facts">
                  <span>{formatGenre(original)}</span>
                  <span>{original.bpm} BPM</span>
                  {key !== null && <span>{key}</span>}
                  <span>{formatTime(original.durationSec)}</span>
                </p>
              </div>
            </li>
          );
        })}
      </ol>

      <section className="originals-now" aria-label="Now playing" data-active={current !== null || undefined}>
        <div className="originals-now-buttons">
          <button
            type="button"
            className="originals-skip"
            aria-label="Previous track"
            onClick={() => {
              step(-1);
            }}
          >
            <SkipIcon direction="previous" />
          </button>
          <button
            type="button"
            className="originals-play originals-play-main"
            aria-label={playing ? "Pause" : "Play"}
            onClick={() => {
              toggle();
            }}
          >
            <PlayIcon playing={playing} />
          </button>
          <button
            type="button"
            className="originals-skip"
            aria-label="Next track"
            onClick={() => {
              step(1);
            }}
          >
            <SkipIcon direction="next" />
          </button>
        </div>
        <div className="originals-now-track">
          <p className="originals-now-title">{current === null ? "Press play to start the newest track" : `${current.id} · ${current.title}`}</p>
          <div className="originals-seek">
            <span className="originals-time" aria-label="Elapsed">
              {formatTime(elapsed)}
            </span>
            <input
              type="range"
              aria-label="Seek"
              min={0}
              max={shownDuration > 0 ? shownDuration : 1}
              step={1}
              value={Math.min(elapsed, shownDuration)}
              disabled={current === null}
              onChange={(event) => {
                const element = audio.current;
                if (element !== null) element.currentTime = Number(event.target.value);
                setElapsed(Number(event.target.value));
              }}
            />
            <span className="originals-time" aria-label="Total">
              {formatTime(shownDuration)}
            </span>
          </div>
          {playProblem !== null && (
            <p className="originals-problem" role="alert">
              {playProblem}
            </p>
          )}
        </div>
      </section>

      <audio
        ref={audio}
        preload="none"
        onPlay={() => {
          setPlaying(true);
        }}
        onPause={() => {
          setPlaying(false);
        }}
        onTimeUpdate={(event) => {
          setElapsed(event.currentTarget.currentTime);
        }}
        onDurationChange={(event) => {
          const value = event.currentTarget.duration;
          setDuration(Number.isFinite(value) ? value : 0);
        }}
        onEnded={() => {
          step(1);
        }}
        onError={() => {
          const id = currentRef.current;
          if (id !== null) setPlayProblem(`Track ${id} couldn't be loaded. Check that its track.mp3 exists, then press play again.`);
        }}
      />
    </main>
  );
}
