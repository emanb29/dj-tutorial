// Mix plans (ISS-186): the bare list before the Mix Editor (ISS-187 on). Create a plan by picking
// tracks from the music folder in play order, rename, delete, download or upload a .mixplan.json, and
// open one to see its tracks found on this device ("Find <file>" when one is not), its decks and what
// is wrong with it. Plans stay on this device; tracks are never uploaded.
import { useCallback, useEffect, useMemo, useState } from "react";
import { deckOf } from "./deck-layout.ts";
import { pickedTrack, planLibrary, type PlanLibrary } from "./library.ts";
import { gridForFile, resolvePlanTracks, type TrackResolution } from "./resolve.ts";
import { createMixPlanStore, type StoredPlan } from "./store.ts";
import { ButtonHint } from "../controller/KeyHint.tsx";
import { musicFolder } from "../music-folder/shared-folder.ts";
import { mixPlanFileName, mixPlanFileText, parseMixPlanFile } from "@shared/mix-plan-file.ts";
import { RECIPES, newMixPlan, type PickedTrack } from "@shared/mix-plan-recipes.ts";
import { mixPlanProblems, type MixPlanProblem } from "@shared/mix-plan-validate.ts";
import { phraseOf, type MixPlan, type PlanGrid } from "@shared/mix-plan.ts";
import "./mix-plans.css";

type View = { readonly kind: "list" } | { readonly kind: "new" } | { readonly kind: "open"; readonly plan: MixPlan };

const store = createMixPlanStore();

function download(plan: MixPlan) {
  const url = URL.createObjectURL(new Blob([mixPlanFileText(plan)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = mixPlanFileName(plan);
  link.click();
  URL.revokeObjectURL(url);
}

export function MixPlansPage({ onExit }: { readonly onExit: () => void }) {
  const library = useMemo(() => planLibrary(musicFolder()), []);
  const [view, setView] = useState<View>({ kind: "list" });
  const [plans, setPlans] = useState<readonly StoredPlan[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const refresh = useCallback(
    () =>
      store.list().then(setPlans, (error: unknown) => {
        console.warn("[mix-plans] the plans could not be read", error);
        setProblem("Your plans could not be read on this device. Leave private browsing, or allow site data, then reload.");
      }),
    [],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(
    async (plan: MixPlan) => {
      const saved = await store.save(plan);
      setProblem(saved.ok ? null : `${saved.error.message} ${saved.error.fix}`);
      await refresh();
      return saved.ok;
    },
    [refresh],
  );

  const back = view.kind === "list" ? onExit : () => {
    setView({ kind: "list" });
  };

  return (
    <main className="plans-page">
      <header className="plans-head">
        <button type="button" className="btn btn-quiet" onClick={back} data-nav-back>
          ← {view.kind === "list" ? "Lessons" : "Mix plans"} <ButtonHint k="Esc" />
        </button>
        <h1>{view.kind === "open" ? view.plan.name : view.kind === "new" ? "New mix plan" : "Mix plans"}</h1>
      </header>
      {problem === null ? null : (
        <p className="lesson-problem" role="alert">
          {problem}
        </p>
      )}
      {view.kind === "new" ? (
        <NewPlan
          library={library}
          onCreate={async (plan) => {
            if (await save(plan)) setView({ kind: "open", plan });
          }}
        />
      ) : view.kind === "open" ? (
        <OpenPlan plan={view.plan} library={library} />
      ) : (
        <PlanList
          plans={plans}
          onNew={() => {
            setView({ kind: "new" });
          }}
          onOpen={(plan) => {
            setView({ kind: "open", plan });
          }}
          onSave={save}
          onDelete={async (id) => {
            await store.delete(id);
            await refresh();
          }}
          onProblem={setProblem}
        />
      )}
    </main>
  );
}

interface PlanListProps {
  readonly plans: readonly StoredPlan[] | null;
  readonly onNew: () => void;
  readonly onOpen: (plan: MixPlan) => void;
  readonly onSave: (plan: MixPlan) => Promise<boolean>;
  readonly onDelete: (id: string) => Promise<void>;
  readonly onProblem: (text: string | null) => void;
}

function PlanList({ plans, onNew, onOpen, onSave, onDelete, onProblem }: PlanListProps) {
  const [renaming, setRenaming] = useState<{ readonly id: string; readonly name: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const upload = async (file: File) => {
    const read = parseMixPlanFile(await file.text());
    if (!read.ok) {
      onProblem(read.problems.map((each) => `${each.message} ${each.fix}`).join(" "));
      return;
    }
    // A copy of its own: an uploaded plan never replaces one already here.
    const now = new Date().toISOString();
    await onSave({ ...read.plan, id: crypto.randomUUID(), createdAt: now, updatedAt: now });
  };

  return (
    <section className="plans-panel" aria-label="Your mix plans">
      <p className="plans-caption">Plan a set from your own music folder · kept on this device, never uploaded</p>
      <div className="plans-actions">
        <button type="button" className="btn btn-primary" onClick={onNew} data-nav-default>
          New plan
        </button>
        <label className="btn btn-quiet plans-file">
          Upload a plan
          <input
            type="file"
            accept=".json,application/json"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file !== undefined) void upload(file);
            }}
          />
        </label>
      </div>
      {plans === null ? <p className="plans-caption">Loading…</p> : plans.length === 0 ? <p className="plans-caption">No plans yet.</p> : null}
      <ul className="plans-list">
        {plans?.map((entry) => {
          const id = entry.ok ? entry.plan.id : entry.id;
          return (
            <li key={id} data-plan={id}>
              {!entry.ok ? (
                <span className="plans-name">Can't be read: {entry.problems[0]?.message}</span>
              ) : renaming?.id === id ? (
                <form
                  className="plans-rename"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const name = renaming.name.trim();
                    if (name === "") return;
                    void onSave({ ...entry.plan, name, updatedAt: new Date().toISOString() }).then(() => {
                      setRenaming(null);
                    });
                  }}
                >
                  <input
                    aria-label="Plan name"
                    value={renaming.name}
                    maxLength={120}
                    autoFocus
                    onChange={(event) => {
                      setRenaming({ id, name: event.currentTarget.value });
                    }}
                  />
                  <button type="submit" className="btn btn-primary">
                    Save
                  </button>
                </form>
              ) : (
                <span className="plans-name">
                  {entry.plan.name} <span className="plans-caption">· {entry.plan.tracks.length} tracks</span>
                </span>
              )}
              <span className="plans-row-actions">
                {entry.ok ? (
                  <>
                    <button type="button" className="btn btn-quiet" onClick={() => {
                        onOpen(entry.plan);
                      }}>
                      Open
                    </button>
                    <button type="button" className="btn btn-quiet" onClick={() => {
                        setRenaming({ id, name: entry.plan.name });
                      }}>
                      Rename
                    </button>
                    <button type="button" className="btn btn-quiet" onClick={() => {
                        download(entry.plan);
                      }}>
                      Download
                    </button>
                  </>
                ) : null}
                <button
                  type="button"
                  className="btn btn-quiet"
                  onClick={() => {
                    if (deleting === id) void onDelete(id);
                    else setDeleting(id);
                  }}
                >
                  {deleting === id ? "Really delete?" : "Delete"}
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function NewPlan({ library, onCreate }: { readonly library: PlanLibrary; readonly onCreate: (plan: MixPlan) => Promise<void> }) {
  const folder = musicFolder();
  const [name, setName] = useState("New set");
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState<readonly string[]>([]);
  const [working, setWorking] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const tracks = folder.tracks();
  const byId = new Map(tracks.map((track) => [track.id, track]));
  const shown = tracks.filter((track) => `${track.artist} ${track.title}`.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 50);

  const create = async () => {
    const picked: PickedTrack[] = [];
    for (const [index, id] of order.entries()) {
      const track = byId.get(id);
      const file = library.files().find((each) => each.trackId === id);
      if (track === undefined || file === undefined) continue;
      setWorking(`Reading the beat grid of track ${String(index + 1)} of ${String(order.length)}…`);
      const one = await pickedTrack(library, file, track);
      if (one === null) {
        setWorking(null);
        setProblem(`"${track.title}" has no beat grid: it would not decode or has no steady beat. Remove it and pick another.`);
        return;
      }
      picked.push(one);
    }
    setWorking(null);
    await onCreate(newMixPlan({ id: crypto.randomUUID(), name: name.trim() || "New set", now: new Date().toISOString(), picked }));
  };

  if (tracks.length === 0) {
    return (
      <section className="plans-panel">
        <p>Your music folder has no tracks yet. Pick it on the Controller page, then come back.</p>
      </section>
    );
  }
  return (
    <section className="plans-panel" aria-label="New plan">
      <label className="plans-field">
        Name
        <input value={name} maxLength={120} onChange={(event) => {
            setName(event.currentTarget.value);
          }} />
      </label>
      <h2>Play order</h2>
      {order.length === 0 ? <p className="plans-caption">Pick at least 2 tracks below, in the order they play.</p> : null}
      <ol className="plans-order">
        {order.map((id, index) => (
          <li key={`${id}-${String(index)}`}>
            <span>
              {deckOf(index)} · {byId.get(id)?.title ?? "?"}
            </span>
            <button type="button" className="btn btn-quiet" onClick={() => {
                setOrder(order.filter((_, each) => each !== index));
              }}>
              Remove
            </button>
          </li>
        ))}
      </ol>
      <button type="button" className="btn btn-primary" disabled={order.length < 2 || working !== null} onClick={() => void create()}>
        Make the plan
      </button>
      {working === null ? null : <p role="status">{working}</p>}
      {problem === null ? null : (
        <p className="lesson-problem" role="alert">
          {problem}
        </p>
      )}
      <h2>Your library</h2>
      <input aria-label="Search the library" placeholder="Search" value={query} onChange={(event) => {
          setQuery(event.currentTarget.value);
        }} />
      <ul className="plans-library">
        {shown.map((track) => (
          <li key={track.id}>
            <button type="button" className="btn btn-quiet" onClick={() => {
                setProblem(null);
                setOrder([...order, track.id]);
              }}>
              + {track.artist} – {track.title}
              {track.bpmHint === undefined ? "" : ` · ${String(Math.round(track.bpmHint))} BPM`}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface Found {
  readonly resolution: TrackResolution;
  readonly grid: PlanGrid | null;
  /** Set once the Learner found a missing track by hand: the plan's own file, or another one. */
  readonly picked?: "same" | "different";
}

function OpenPlan({ plan, library }: { readonly plan: MixPlan; readonly library: PlanLibrary }) {
  const [found, setFound] = useState<readonly Found[] | null>(null);

  useEffect(() => {
    const stale = new AbortController();
    void (async () => {
      const resolutions = await resolvePlanTracks(plan.tracks, library.files());
      const grids = await Promise.all(
        resolutions.map((resolution, index) => {
          const track = plan.tracks[index];
          return resolution.kind === "found" && track !== undefined ? gridForFile(resolution.file, track, library) : Promise.resolve(null);
        }),
      );
      if (!stale.signal.aborted) setFound(resolutions.map((resolution, index) => ({ resolution, grid: grids[index] ?? null })));
    })();
    return () => {
      stale.abort();
    };
  }, [plan, library]);

  const problems: readonly MixPlanProblem[] = useMemo(() => {
    const grids = new Map<string, PlanGrid>();
    found?.forEach((each, index) => {
      const hash = plan.tracks[index]?.contentHash;
      if (each.grid !== null && hash !== undefined) grids.set(hash, each.grid);
    });
    return found === null ? [] : mixPlanProblems(plan, grids);
  }, [found, plan]);

  if (found === null) return <p role="status">Finding the tracks in your music folder…</p>;
  return (
    <section className="plans-panel" aria-label="Plan">
      <ol className="plans-set">
        {plan.tracks.map((track, index) => {
          const here = found[index];
          const transition = plan.transitions[index];
          const missing = here?.resolution.kind === "missing" && here.picked === undefined;
          const nextMissing = found[index + 1]?.resolution.kind === "missing" && found[index + 1]?.picked === undefined;
          return (
            <li key={`${track.contentHash}-${String(index)}`} data-found={missing ? "no" : "yes"}>
              <span className="plans-name">
                {deckOf(index)} · {track.title ?? track.fileName}
                {here?.resolution.kind === "found" && here.resolution.matchedBy === "name" ? <span className="plans-caption"> · found by name, other bytes: check its grid</span> : null}
                {here?.picked === undefined ? null : <span className="plans-caption"> · {here.picked === "same" ? "found" : "a different file than the plan's: check its grid"}</span>}
              </span>
              {here?.resolution.kind === "missing" && missing ? (
                <label className="btn btn-primary plans-file">
                  {here.resolution.caption}
                  <input
                    type="file"
                    accept="audio/*"
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = "";
                      if (file === undefined) return;
                      void library.checkPicked(file, track).then(({ sameFile, grid }) => {
                        setFound((now) => now?.map((each, at) => (at === index ? { ...each, grid, picked: sameFile ? "same" : "different" } : each)) ?? now);
                      });
                    }}
                  />
                </label>
              ) : null}
              {transition === undefined ? null : (
                <p className={`plans-transition${missing || nextMissing ? " plans-greyed" : ""}`}>
                  ↓ {transition.recipe === "custom" ? "Custom" : RECIPES[transition.recipe].name} at Phrase {phraseOf(transition.outgoingAt).phrase},{" "}
                  {transition.lengthBeats / 4} bars
                </p>
              )}
            </li>
          );
        })}
      </ol>
      {problems.length === 0 ? (
        <p className="plans-caption">No problems found.</p>
      ) : (
        <ul className="plans-problems" aria-label="Problems">
          {problems.map((each, index) => (
            <li key={index}>
              {each.message} {each.fix}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
