// The Mix Editor (ISS-187): the screen where you plan a set's Transitions. The set view on the left,
// the Transition being edited on the right; every edit saves on this device at once, problems are
// listed but never block, and the Complexity rating only advises. Tracks come from the Learner's own
// music folder (resolved by content hash, never uploaded). Planning is for a laptop: on a phone the
// page shows the set read-only, with Preview.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { WaveformOverview } from "@analysis";
import { waveformOverview } from "@analysis/waveform.ts";
import type { ControllerUnlocks } from "@app/controller/control-ids.ts";
import { mixPlanProblems } from "@shared/mix-plan-validate.ts";
import type { LearnerRecord } from "@shared/learner.ts";
import type { MixPlan, PlanGrid, Transition } from "@shared/mix-plan.ts";
import type { FolderFile } from "@tracks";
import { ButtonHint } from "../controller/KeyHint.tsx";
import { LibraryBrowser } from "../library-browser/LibraryBrowser.tsx";
import { folderRows } from "../library-browser/folder-rows.ts";
import { deckOf } from "../mix-plans/deck-layout.ts";
import { pickedTrack, planLibrary } from "../mix-plans/library.ts";
import { createMixPlanStore } from "../mix-plans/store.ts";
import { useMusicFolder } from "../music-folder/MusicFolderPanel.tsx";
import { musicFolder } from "../music-folder/shared-folder.ts";
import { editPlan, type EditorAction, type EditorGrids } from "./editor-state.ts";
import { deriveExecution, type ExecutionPlan } from "./execution-plan.ts";
import { PreviewPlayer } from "./preview-audio.ts";
import { PreviewAudioCache, usePlanTracks, type PlanTrackData } from "./plan-tracks.ts";
import { SetOverview, SetView } from "./SetView.tsx";
import { TransitionEditor } from "./TransitionEditor.tsx";
import { RatingChip } from "./ExecutionStrip.tsx";
import { plannerUnlocks } from "./unlocks.ts";
import "./mix-editor.css";

/** Narrower than this, the page shows the set read-only: planning is for a laptop. */
const LAPTOP_QUERY = "(min-width: 900px)";
const SAVE_AFTER_MS = 400;

const store = createMixPlanStore();

type Loaded = { readonly kind: "loading" } | { readonly kind: "missing" } | { readonly kind: "ready" };
type Saving = "saved" | "saving" | { readonly problem: string };

interface EditorWindow {
  djTutorialMixEditor?: { readonly plan: () => MixPlan | null; readonly previewBeat: () => number | null };
}

function useMedia(query: string): boolean {
  const subscribe = useCallback(
    (listener: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", listener);
      return () => {
        media.removeEventListener("change", listener);
      };
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}

/** Each Transition's Execution plan, derived again only for a Transition that changed (memoised by identity). */
function useExecutions(plan: MixPlan | null, unlocks: ControllerUnlocks): readonly ExecutionPlan[] {
  const [memo] = useState(() => new WeakMap<Transition, { readonly unlocks: ControllerUnlocks; readonly execution: ExecutionPlan }>());
  return useMemo(
    () =>
      plan?.transitions.map((transition, index) => {
        const known = memo.get(transition);
        if (known?.unlocks === unlocks) return known.execution;
        const execution = deriveExecution(transition, { outgoing: deckOf(index), incoming: deckOf(index + 1) }, unlocks);
        memo.set(transition, { unlocks, execution });
        return execution;
      }) ?? [],
    [memo, plan, unlocks],
  );
}

export function MixEditorPage({ planId, learner, onExit }: { readonly planId: string; readonly learner: LearnerRecord; readonly onExit: () => void }) {
  const unlocks = useMemo(() => plannerUnlocks(learner), [learner]);
  const [folder] = useState(musicFolder);
  const snapshot = useMusicFolder(folder);
  const library = useMemo(() => planLibrary(folder), [folder]);
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [plan, setPlan] = useState<MixPlan | null>(null);
  const planRef = useRef<MixPlan | null>(null);
  useEffect(() => {
    planRef.current = plan;
  }, [plan]);
  const [saving, setSaving] = useState<Saving>("saved");
  const dirty = useRef(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [picking, setPicking] = useState<number | null>(null);
  const [pickProblem, setPickProblem] = useState<string | null>(null);
  const [handFound, setHandFound] = useState<ReadonlyMap<string, PlanTrackData>>(new Map());
  const laptop = useMedia(LAPTOP_QUERY);
  const [player] = useState(() => new PreviewPlayer());
  const preview = useSyncExternalStore(player.subscribe, player.snapshot);
  const [previewLoading, setPreviewLoading] = useState<number | null>(null);
  const [previewProblem, setPreviewProblem] = useState<string | null>(null);
  const [audio] = useState(() => new PreviewAudioCache());
  const [waveforms, setWaveforms] = useState<ReadonlyMap<string, WaveformOverview>>(new Map());

  useEffect(() => {
    let live = true;
    void store.get(planId).then(
      (entry) => {
        if (!live) return;
        if (entry?.ok === true) {
          setPlan(entry.plan);
          setSelected(entry.plan.transitions.length > 0 ? 0 : null);
          setLoaded({ kind: "ready" });
        } else setLoaded({ kind: "missing" });
      },
      (error: unknown) => {
        console.warn("[mix-editor] the plan could not be read", error);
        if (live) setLoaded({ kind: "missing" });
      },
    );
    return () => {
      live = false;
    };
  }, [planId]);

  useEffect(
    () => () => {
      void player.close();
    },
    [player],
  );

  // Every edit is kept on this device, a moment after the last one.
  useEffect(() => {
    if (plan === null || !dirty.current) return;
    setSaving("saving");
    const timer = setTimeout(() => {
      void store.save(plan).then(
        (saved) => {
          setSaving(saved.ok ? "saved" : { problem: `${saved.error.message} ${saved.error.fix}` });
        },
        (error: unknown) => {
          console.warn("[mix-editor] the plan could not be saved", error);
          setSaving({ problem: "The plan could not be saved on this device. Leave private browsing, or allow site data, then edit again." });
        },
      );
    }, SAVE_AFTER_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [plan]);

  const found = usePlanTracks(plan, library, snapshot);
  const tracks: readonly (PlanTrackData | undefined)[] = useMemo(
    () => plan?.tracks.map((track) => handFound.get(track.contentHash) ?? found.get(track.contentHash)) ?? [],
    [plan, found, handFound],
  );
  const grids: EditorGrids = useMemo(() => {
    const known = new Map<string, PlanGrid>();
    plan?.tracks.forEach((track, index) => {
      const grid = tracks[index]?.grid;
      if (grid != null) known.set(track.contentHash, grid);
    });
    return known;
  }, [plan, tracks]);
  const executions = useExecutions(plan, unlocks);

  // The pair being edited, drawn from its audio when no cached analysis has a waveform (only these two are decoded).
  const editingPair = laptop ? selected : null;
  useEffect(() => {
    if (editingPair === null || plan === null) return;
    let live = true;
    for (const at of [editingPair, editingPair + 1]) {
      const track = plan.tracks[at];
      const data = tracks[at];
      if (track === undefined || data?.resolution.kind !== "found" || data.analysis !== null || waveforms.has(track.contentHash)) continue;
      void audio.get(track.contentHash, data.resolution.file).then(
        (buffer) => {
          if (!live) return;
          const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
          const mono = channels.length === 1 && channels[0] !== undefined ? channels[0] : Float32Array.from({ length: buffer.length }, (_, index) => channels.reduce((sum, channel) => sum + (channel[index] ?? 0), 0) / channels.length);
          const overview = waveformOverview(mono, buffer.sampleRate);
          setWaveforms((now) => new Map([...now, [track.contentHash, overview]]));
        },
        (error: unknown) => {
          console.warn("[mix-editor] a track's waveform could not be drawn: it would not decode", error);
        },
      );
    }
    return () => {
      live = false;
    };
  }, [audio, editingPair, plan, tracks, waveforms]);
  const problems = useMemo(() => (plan === null ? [] : mixPlanProblems(plan, grids)), [plan, grids]);

  const dispatch = useCallback(
    (action: EditorAction) => {
      dirty.current = true;
      setPlan((now) => (now === null ? now : editPlan(now, action, grids, new Date().toISOString())));
    },
    [grids],
  );

  // The preview follows edits to the Transition it plays.
  const playingIndex = preview.kind === "playing" ? preview.transition : null;
  const playingTransition = playingIndex === null ? undefined : plan?.transitions[playingIndex];
  useEffect(() => {
    if (playingIndex !== null && playingTransition !== undefined) player.update(playingIndex, playingTransition);
  }, [player, playingIndex, playingTransition]);

  const togglePreview = useCallback(
    (index: number) => {
      if (playingIndex === index) {
        player.stop();
        return;
      }
      const current = planRef.current;
      const transition = current?.transitions[index];
      const outgoing = tracks[index];
      const incoming = tracks[index + 1];
      const outHash = current?.tracks[index]?.contentHash;
      const inHash = current?.tracks[index + 1]?.contentHash;
      if (transition === undefined || outgoing?.resolution.kind !== "found" || incoming?.resolution.kind !== "found" || outgoing.grid === null || incoming.grid === null || outHash === undefined || inHash === undefined) {
        setPreviewProblem("Both tracks need to be found on this device, with beat grids, to preview this Transition.");
        return;
      }
      // Inside the click: browsers start sound only from a gesture.
      void player.audioContext().resume();
      setPreviewProblem(null);
      setPreviewLoading(index);
      const grids = { outgoing: outgoing.grid, incoming: incoming.grid };
      void Promise.all([audio.get(outHash, outgoing.resolution.file), audio.get(inHash, incoming.resolution.file)])
        .then(([outBuffer, inBuffer]) => player.play(index, planRef.current?.transitions[index] ?? transition, grids, { outgoing: outBuffer, incoming: inBuffer }))
        .catch((error: unknown) => {
          console.warn("[mix-editor] the preview could not start", error);
          setPreviewProblem("The preview could not start: a track would not decode. Check the file plays elsewhere, or find it again.");
        })
        .finally(() => {
          setPreviewLoading(null);
        });
    },
    [audio, player, playingIndex, tracks],
  );

  const playheadFor = useCallback((index: number) => () => (playingIndex === index ? player.beatNow() : null), [player, playingIndex]);

  useEffect(() => {
    (window as EditorWindow).djTutorialMixEditor = { plan: () => planRef.current, previewBeat: () => player.beatNow() };
    return () => {
      delete (window as EditorWindow).djTutorialMixEditor;
    };
  }, [player]);

  const findByHand = useCallback(
    (index: number, file: File) => {
      const track = planRef.current?.tracks[index];
      if (track === undefined) return;
      void library.checkPicked(file, track).then(({ grid }) => {
        const picked: FolderFile = { trackId: `picked-${track.contentHash}`, name: file.name, album: null, durationSec: track.durationMs / 1000, contentHash: track.contentHash, rekordboxGrid: null, read: () => Promise.resolve(file) };
        setHandFound((now) => new Map([...now, [track.contentHash, { resolution: { kind: "found", matchedBy: "hash", file: picked }, grid, analysis: null, fromRekordbox: false }]]));
      });
    },
    [library],
  );

  // Esc (SHIFT + BROWSE) steps back: the track picker, then the Transition editor, then the page.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== "Escape" || event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof HTMLInputElement && target.type !== "range" && target.type !== "file") return;
      event.preventDefault();
      if (picking !== null) {
        setPicking(null);
        setPickProblem(null);
      } else if (selected !== null && laptop) setSelected(null);
      else onExit();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [picking, selected, laptop, onExit]);

  const rows = useMemo(() => (snapshot.found === 0 || picking === null ? [] : folderRows(folder)), [folder, snapshot, picking]);
  const insert = async (trackId: string) => {
    if (picking === null) return;
    const file = library.files().find((each) => each.trackId === trackId);
    const track = folder.tracks().find((each) => each.id === trackId);
    if (file === undefined || track === undefined) return;
    setPickProblem(`Reading the beat grid of "${track.title}"…`);
    const one = await pickedTrack(library, file, track);
    if (one === null) {
      setPickProblem(`"${track.title}" has no beat grid: it would not decode or has no steady beat. Pick another.`);
      return;
    }
    dispatch({ kind: "insert-track", after: picking, picked: one });
    setSelected(picking);
    setPicking(null);
    setPickProblem(null);
  };

  if (loaded.kind === "loading") return <p className="lesson-loading">Opening the plan…</p>;
  if (loaded.kind === "missing" || plan === null) {
    return (
      <main className="me-page">
        <button type="button" className="btn btn-quiet" onClick={onExit} data-nav-back>
          ← Mix plans <ButtonHint k="Esc" />
        </button>
        <p role="alert">This plan is not on this device. It may have been deleted; upload its .mixplan.json on the Mix plans page.</p>
      </main>
    );
  }

  const hardest = executions.reduce<ExecutionPlan["complexity"]["rating"]>((most, each) => (each.complexity.rating > most ? each.complexity.rating : most), 1);
  const editing = laptop ? selected : null;
  const editingExecution = editing === null ? undefined : executions[editing];

  return (
    <main className={`me-page${laptop ? "" : " me-phone"}`}>
      <header className="me-head">
        <button type="button" className="btn btn-quiet" onClick={onExit} data-nav-back>
          ← Mix plans <ButtonHint k="Esc" />
        </button>
        {laptop ? (
          <input
            className="me-name"
            aria-label="Plan name"
            value={plan.name}
            maxLength={120}
            onChange={(event) => {
              dispatch({ kind: "rename", name: event.currentTarget.value });
            }}
          />
        ) : (
          <h1 className="me-name">{plan.name}</h1>
        )}
        <span className="me-hardest">
          Hardest: <RatingChip rating={hardest} />
        </span>
        <span className="me-caption" role="status" data-testid="save-status">
          {saving === "saved" ? "Saved on this device" : saving === "saving" ? "Saving…" : saving.problem}
        </span>
      </header>
      {laptop ? null : <p className="me-phone-note">Planning is best on a laptop. Here is the set, with Preview.</p>}
      {previewProblem === null ? null : (
        <p className="lesson-problem" role="alert">
          {previewProblem}
        </p>
      )}
      <SetOverview plan={plan} selected={editing} onEdit={setSelected} />
      <div className="me-body">
        <aside className="me-side">
          <SetView
            plan={plan}
            tracks={tracks}
            executions={executions}
            selected={editing}
            previewing={playingIndex}
            readOnly={!laptop}
            onEdit={setSelected}
            onPreview={togglePreview}
            onRemoveTrack={(index) => {
              player.stop();
              dispatch({ kind: "remove-track", track: index });
              setSelected((now) => (now === null ? null : Math.max(0, Math.min(now, plan.transitions.length - 2))));
            }}
            onFind={findByHand}
          />
          {problems.length === 0 ? (
            <p className="me-caption">No problems found.</p>
          ) : (
            <ul className="me-problems" aria-label="Problems">
              {problems.map((each, index) => (
                <li key={index}>
                  {each.message} {each.fix}
                </li>
              ))}
            </ul>
          )}
        </aside>
        {editing === null || editingExecution === undefined ? (
          laptop ? (
            <p className="me-caption me-empty">Pick a Transition in the set to edit it.</p>
          ) : null
        ) : (
          <TransitionEditor
            key={editing}
            plan={plan}
            index={editing}
            tracks={tracks}
            waveforms={waveforms}
            execution={editingExecution}
            dispatch={dispatch}
            previewing={playingIndex === editing}
            previewLoading={previewLoading === editing}
            loop={preview.kind === "playing" ? preview.loop : false}
            onPreview={() => {
              togglePreview(editing);
            }}
            onLoop={(loop) => {
              player.setLoop(loop);
            }}
            playhead={playheadFor(editing)}
            onPair={setSelected}
            onNewPair={() => {
              setPicking(editing + 1);
            }}
            onClose={() => {
              setSelected(null);
            }}
          />
        )}
      </div>
      {picking === null ? null : (
        <div className="me-picker" role="dialog" aria-modal="true" aria-label="Add a track" data-nav-start>
          <div className="me-picker-box">
            <header className="me-picker-head">
              <h2>Add a track after track {picking + 1}</h2>
              <button
                type="button"
                className="btn btn-quiet"
                data-nav-back
                onClick={() => {
                  setPicking(null);
                  setPickProblem(null);
                }}
              >
                Close <ButtonHint k="Esc" />
              </button>
            </header>
            {pickProblem === null ? null : <p role="status">{pickProblem}</p>}
            <LibraryBrowser
              picker="mix-editor"
              rows={rows}
              navStart
              emptyText="Your music folder has no tracks yet. Pick it on the Controller page."
              controllerHint={
                <>
                  FLX4: turn BROWSE to a track, then <kbd className="hw-key">LOAD A</kbd> adds it here
                </>
              }
              onLoad={(row) => {
                void insert(row.key);
              }}
              actions={(row) => (
                <button type="button" className="btn btn-quiet" tabIndex={-1} data-nav-skip aria-label={`Add ${row.title}`} onClick={() => void insert(row.key)}>
                  + Add
                </button>
              )}
            />
          </div>
        </div>
      )}
    </main>
  );
}
