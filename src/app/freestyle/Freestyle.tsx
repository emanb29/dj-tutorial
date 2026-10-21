// Freestyle (/freestyle): a small rekordbox. Both decks, every control, the Learner's library (the
// Originals, the starter pack, their own files) and their sound output; no Lesson, no grading, nothing
// recorded. The DDJ-FLX4 works here as everywhere (the Controller wires it).
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createAudioEngine, outputLine, type AudioEngine } from "@audio";
import { midiConnection } from "@midi";
import type { DeckId } from "@shared/attempt.ts";
import { ALL_CONTROL_IDS, Controller, type ControlId } from "../controller/index.ts";
import { currentOutputPlan } from "../audio-output.ts";
import { listLibrary, type Library, type LibraryItem, type PreparedTrack } from "../final-mix/library.ts";
import type { TrackPreference } from "../lesson/track-loader.ts";
import { FreestyleSession } from "./freestyle-session.ts";
import "../lesson/lesson.css";
import "../final-mix/final-mix.css";
import "./freestyle.css";

export interface FreestyleProps {
  readonly trackPreference: TrackPreference;
  readonly onExit: () => void;
}

/** Everything on the controller, except TAP: a Lesson's ear-training input, which has nothing to time here. */
const FREESTYLE_UNLOCKS: ReadonlySet<ControlId> = new Set(ALL_CONTROL_IDS.filter((id) => id !== "tap"));
const DECKS: readonly DeckId[] = ["A", "B"];

type Status = { readonly kind: "starting"; readonly line: string } | { readonly kind: "ready" } | { readonly kind: "failed"; readonly message: string };

/** What end-to-end tests read, like the Lesson player's handle (window.learnToDjLesson). */
interface FreestyleHandle {
  readonly engine: AudioEngine;
  readonly deckTrack: (deck: DeckId) => string | null;
}

const bpmText = (bpm: number | null) => (bpm === null ? "BPM ?" : `${bpm.toFixed(1)} BPM`);

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

export function Freestyle({ trackPreference, onExit }: FreestyleProps) {
  const [status, setStatus] = useState<Status>({ kind: "starting", line: "Getting the decks ready…" });
  const [engine, setEngine] = useState<AudioEngine | null>(null);
  const [session, setSession] = useState<FreestyleSession | null>(null);
  const [library, setLibrary] = useState<Library | null>(null);
  const [items, setItems] = useState<readonly LibraryItem[]>([]);
  const [filter, setFilter] = useState("");
  const [preparing, setPreparing] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** Tracks already prepared (grid found), so loading one again skips the analysis. */
  const prepared = useRef(new Map<string, PreparedTrack>());
  const abort = useRef(new AbortController());

  // The engine and the library, once per visit.
  useEffect(() => {
    const controller = new AbortController();
    abort.current = controller;
    let created: AudioEngine | null = null;
    const cancelled = () => controller.signal.aborted;
    const close = () => {
      created?.close().catch((error: unknown) => {
        console.warn("[freestyle] the audio engine did not close cleanly", error);
      });
      created = null;
    };
    void (async () => {
      try {
        // The Learner's output (Controller page), as every Lesson plays it.
        const plan = await currentOutputPlan();
        if (cancelled()) return;
        created = await createAudioEngine({ masterTempo: true, output: { plan, headphones: true } });
        if (cancelled()) return;
        setStatus({ kind: "starting", line: "Opening your library…" });
        const listed = await listLibrary(trackPreference, created.context.sampleRate, controller.signal);
        if (cancelled()) return;
        setEngine(created);
        setSession(new FreestyleSession(created, { hardwareConnected: () => midiConnection().connected }));
        setLibrary(listed);
        setItems(listed.items);
        setStatus({ kind: "ready" });
      } catch (error) {
        if (!cancelled()) setStatus({ kind: "failed", message: `The decks could not start: ${error instanceof Error ? error.message : String(error)}. Reload to try again.` });
      } finally {
        if (cancelled()) close();
      }
    })();
    return () => {
      controller.abort();
      close();
    };
  }, [trackPreference]);

  // Audio starts only after a gesture.
  useEffect(() => {
    const context = engine?.context;
    if (!(context instanceof AudioContext)) return;
    const resume = () => {
      if (context.state !== "running") void context.resume();
    };
    resume();
    window.addEventListener("pointerdown", resume, { capture: true });
    window.addEventListener("keydown", resume, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", resume, { capture: true });
      window.removeEventListener("keydown", resume, { capture: true });
    };
  }, [engine]);

  const decks = useSyncExternalStore(
    useCallback((listener: () => void) => session?.subscribe(listener) ?? (() => undefined), [session]),
    () => session?.snapshot() ?? -1,
  );

  // The play state decides which deck can load: re-render when a deck starts or stops.
  const [, setPlayTick] = useState(0);
  useEffect(() => engine?.on("deck", () => { setPlayTick((tick) => tick + 1); }), [engine]);

  // End-to-end tests read the engine and what each deck holds.
  useEffect(() => {
    if (engine === null || session === null) return;
    const handle: FreestyleHandle = { engine, deckTrack: (deck) => session.track(deck)?.trackId ?? null };
    (window as { learnToDjLesson?: unknown }).learnToDjLesson = handle;
    return () => {
      delete (window as { learnToDjLesson?: unknown }).learnToDjLesson;
    };
  }, [engine, session]);

  // Escape leaves.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code === "Escape" && !isTyping(event.target)) onExit();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [onExit]);

  const loadOnto = useCallback(
    (item: LibraryItem, deck: DeckId) => {
      if (engine === null || session === null) return;
      setProblem(null);
      void (async () => {
        let ready = prepared.current.get(item.key);
        if (ready === undefined) {
          setPreparing(`Getting "${item.title}" ready…`);
          const result = await item.prepare({ sampleRate: engine.context.sampleRate, signal: abort.current.signal, onStatus: setPreparing });
          setPreparing(null);
          if (!result.ok) {
            setProblem(result.message);
            return;
          }
          ready = result.prepared;
          prepared.current.set(item.key, ready);
        }
        const loaded = await session.load(deck, ready, abort.current.signal);
        if (!loaded.ok) setProblem(loaded.message);
      })();
    },
    [engine, session],
  );

  const shown = items.filter((item) => `${item.title} ${item.artist} ${item.genre ?? ""}`.toLowerCase().includes(filter.trim().toLowerCase()));
  const caption = status.kind === "starting" ? status.line : status.kind === "failed" ? status.message : "Freestyle: load any track, mix as you like. Nothing is graded.";

  return (
    <main className="lesson final-mix freestyle" data-phase={status.kind}>
      <header className="lesson-bar">
        <button type="button" className="btn btn-quiet lesson-back" onClick={onExit}>
          ← Lessons <kbd>Esc</kbd>
        </button>
        <h1>Freestyle</h1>
      </header>

      <div className="lesson-stage">
        <p className="lesson-caption" role="status" aria-live="polite" aria-label="Lesson caption">
          <span className="lesson-do">{caption}</span>
        </p>
        {session === null ? null : (
          <ul className="freestyle-decks" aria-label="On the decks" data-decks={decks}>
            {DECKS.map((deck) => {
              const track = session.track(deck);
              return (
                <li key={deck} data-deck={deck}>
                  <strong>{deck}</strong>{" "}
                  {session.isLoading(deck) ? "Loading…" : track === null ? "Empty" : `${track.title} · ${bpmText(track.grid.bpm)}`}
                </li>
              );
            })}
          </ul>
        )}
        {problem === null ? null : (
          <p className="lesson-problem" role="alert">
            {problem}
          </p>
        )}
      </div>

      <div className="lesson-board">
        {engine === null ? null : <Controller engine={engine} unlocks={FREESTYLE_UNLOCKS} outputLine={engine.output == null ? null : outputLine(engine.output, true)} />}
        {library === null || session === null ? null : (
          <section className="set-library freestyle-library" aria-label="Library">
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
                      if (event.target.files !== null) {
                        const added = library.addFiles(event.target.files);
                        setItems((current) => [...added, ...current.filter((item) => !added.some((each) => each.key === item.key))]);
                      }
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
                      {item.artist} · {bpmText(item.bpm)} · {item.camelot ?? "key ?"}
                    </small>
                  </span>
                  {DECKS.map((deck) => {
                    const blocker = session.loadBlocker(deck);
                    return (
                      <button
                        key={deck}
                        type="button"
                        className="btn"
                        aria-label={`Load ${item.title} onto deck ${deck}`}
                        title={blocker ?? `Load onto deck ${deck}`}
                        disabled={blocker !== null || preparing !== null}
                        onClick={() => {
                          loadOnto(item, deck);
                        }}
                      >
                        → {deck}
                      </button>
                    );
                  })}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}
