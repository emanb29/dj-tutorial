// Dev playground (/playground): the virtual controller on a real audio engine with two generated house
// loops and everything unlocked, for trying the controls by hand.
//
// It is always on under the dev server; a production build needs `?playground` (see App.tsx).
// URL options, all optional:
//   ?unlocks=A.play,A.channel-fader   only these controls unlocked (default: all)
//   ?pulse=A.play                     pulse one control
//   ?caption=A.play:Press%20play       a caption (repeatable)
//   ?monitor=split                     split cue: headphone cue in the left ear, master in the right

import { useEffect, useMemo, useRef, useState } from "react";
import { createAudioEngine, MasterOnlyMonitor, SplitCueMonitor, type AudioEngine, type CommandEvent } from "@audio";
import { ALL_CONTROL_IDS, isControlId, parseControlIds, type ControlId } from "../controller/control-ids.ts";
import { Controller } from "../controller/Controller.tsx";
import type { ControllerCaption } from "../controller/context.tsx";
import { useWording } from "../controller/wording.ts";
import { renderHouseLoop } from "./synthetic-loops.ts";
import "./playground.css";

/** Commands kept for end-to-end tests to read; older ones are dropped. */
const COMMAND_LOG_LIMIT = 500;

export interface PlaygroundHandle {
  readonly engine: AudioEngine;
  readonly commands: CommandEvent[];
}

declare global {
  interface Window {
    /** Set by the dev playground only. */
    djTutorialPlayground?: PlaygroundHandle;
  }
}

const LOOPS = [
  { deck: "A", trackId: "Synthetic house 124", bpm: 124, rootHz: 55, seed: 7 },
  { deck: "B", trackId: "Synthetic house 122", bpm: 122, rootHz: 73.42, seed: 11 },
] as const;
const LOOP_BARS = 64;

/** Lesson 1's controls (deck-basics), for a quick look at the locked state and the unlock reward. */
const LESSON_ONE: ReadonlySet<ControlId> = new Set<ControlId>(["A.play", "A.channel-fader", "master-level", "master-meter"]);
const LESSON_ONE_CAPTIONS: readonly ControllerCaption[] = [{ control: "A.play", text: "Press play (or X)" }];
const EVERYTHING: ReadonlySet<ControlId> = new Set(ALL_CONTROL_IDS);
const NO_CAPTIONS: readonly ControllerCaption[] = [];

interface UrlSetup {
  readonly unlocks: ReadonlySet<ControlId> | null;
  readonly pulse: ControlId | null;
  readonly captions: readonly ControllerCaption[];
  readonly splitCue: boolean;
  readonly problems: readonly string[];
}

export function readUrlSetup(search: string): UrlSetup {
  const params = new URLSearchParams(search);
  const problems: string[] = [];
  const unlocksText = params.get("unlocks");
  let unlocks: ReadonlySet<ControlId> | null = null;
  if (unlocksText !== null) {
    const parsed = parseControlIds(unlocksText);
    unlocks = new Set(parsed.ids);
    problems.push(...parsed.unknown.map((id) => `unlocks: "${id}" is not a control id`));
  }
  const pulseText = params.get("pulse");
  const pulse = pulseText !== null && isControlId(pulseText) ? pulseText : null;
  if (pulseText !== null && pulse === null) problems.push(`pulse: "${pulseText}" is not a control id`);
  const captions = params.getAll("caption").flatMap((entry): ControllerCaption[] => {
    const colon = entry.indexOf(":");
    const control = colon < 0 ? entry : entry.slice(0, colon);
    if (!isControlId(control)) {
      problems.push(`caption: "${control}" is not a control id (use id:text)`);
      return [];
    }
    return [{ control, text: entry.slice(colon + 1) }];
  });
  return { unlocks, pulse, captions, splitCue: params.get("monitor") === "split", problems };
}

type Status = { kind: "loading" } | { kind: "ready"; engine: AudioEngine } | { kind: "failed"; message: string };

async function startEngine(splitCue: boolean): Promise<AudioEngine> {
  const engine = await createAudioEngine({ monitor: splitCue ? new SplitCueMonitor() : new MasterOnlyMonitor() });
  const loads = LOOPS.map(async (loop) => {
    const samples = renderHouseLoop({ sampleRate: engine.context.sampleRate, bpm: loop.bpm, bars: LOOP_BARS, rootHz: loop.rootHz, seed: loop.seed });
    const buffer = engine.context.createBuffer(2, samples.left.length, engine.context.sampleRate);
    buffer.copyToChannel(samples.left, 0);
    buffer.copyToChannel(samples.right, 1);
    const loaded = await engine.load(loop.deck, buffer, {
      trackId: loop.trackId,
      grid: { bpm: loop.bpm, firstBeat: 0, downbeatIndex: 0, rmsResidualMs: 0 },
    });
    if (!loaded.ok) throw new Error(`Loading deck ${loop.deck} failed: ${loaded.error.kind}`);
  });
  await Promise.all(loads);
  return engine;
}

function describeCommand(event: CommandEvent): string {
  const { command } = event;
  const deck = "deck" in command ? ` ${command.deck}` : "";
  const value = "value" in command ? ` → ${typeof command.value === "number" ? command.value.toFixed(2) : String(command.value)}` : "";
  const outcome = event.rejected === null ? "" : ` (refused: ${event.rejected.kind})`;
  return `${command.control}${deck}${value} · ${event.device}${event.gestureEnd ? " · end" : ""}${outcome}`;
}

export function Playground() {
  const setup = useMemo(() => readUrlSetup(window.location.search), []);
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [audioRunning, setAudioRunning] = useState(false);
  const [unlocks, setUnlocks] = useState<ReadonlySet<ControlId>>(setup.unlocks ?? EVERYTHING);
  const lastCommand = useRef<HTMLSpanElement>(null);
  const wording = useWording();

  useEffect(() => {
    let cancelled = false;
    let started: AudioEngine | null = null;
    startEngine(setup.splitCue).then(
      (engine) => {
        started = engine;
        if (cancelled) {
          void engine.close();
          return;
        }
        setStatus({ kind: "ready", engine });
      },
      (error: unknown) => {
        if (!cancelled) setStatus({ kind: "failed", message: String(error) });
      },
    );
    return () => {
      cancelled = true;
      if (started !== null) void started.close();
    };
  }, [setup.splitCue]);

  const engine = status.kind === "ready" ? status.engine : null;

  // Browsers start audio only after a user gesture; the first touch or key press starts it.
  useEffect(() => {
    if (engine === null) return;
    const context = engine.context;
    if (!(context instanceof AudioContext)) return;
    const sync = () => {
      setAudioRunning(context.state === "running");
    };
    const resume = () => {
      if (context.state !== "running") void context.resume();
    };
    sync();
    context.addEventListener("statechange", sync);
    window.addEventListener("pointerdown", resume, { capture: true });
    window.addEventListener("keydown", resume, { capture: true });
    return () => {
      context.removeEventListener("statechange", sync);
      window.removeEventListener("pointerdown", resume, { capture: true });
      window.removeEventListener("keydown", resume, { capture: true });
    };
  }, [engine]);

  // The last command, for the maintainer to see what each input sent, and a log for end-to-end tests.
  useEffect(() => {
    if (engine === null) return;
    const commands: CommandEvent[] = [];
    window.djTutorialPlayground = { engine, commands };
    const stop = engine.on("command", (event) => {
      commands.push(event);
      if (commands.length > COMMAND_LOG_LIMIT) commands.shift();
      if (lastCommand.current !== null) lastCommand.current.textContent = describeCommand(event);
    });
    return () => {
      stop();
      delete window.djTutorialPlayground;
    };
  }, [engine]);

  return (
    <main className="playground">
      <header className="playground-bar">
        <h1>Controller playground</h1>
        <span className={`audio-state${audioRunning ? " running" : ""}`} data-testid="audio-state">
          {audioRunning ? "Audio on" : wording === "touch" ? "Audio starts on your first tap" : "Audio starts on your first click or key"}
        </span>
        <span className="last-command">
          Last input: <span ref={lastCommand} data-testid="last-command">–</span>
        </span>
        <div className="view-switch" role="group" aria-label="Unlocked controls">
          <button
            type="button"
            aria-pressed={unlocks === LESSON_ONE}
            onClick={() => {
              setUnlocks(LESSON_ONE);
            }}
          >
            Lesson 1 view
          </button>
          <button
            type="button"
            aria-pressed={unlocks === EVERYTHING}
            onClick={() => {
              setUnlocks(EVERYTHING);
            }}
          >
            Everything
          </button>
        </div>
      </header>
      {setup.problems.length === 0 ? null : (
        <p className="playground-problems" role="alert">
          URL options ignored: {setup.problems.join("; ")}.
        </p>
      )}
      {status.kind === "loading" ? <p className="playground-note">Generating two loops…</p> : null}
      {status.kind === "failed" ? (
        <p className="playground-problems" role="alert">
          The audio engine failed to start: {status.message}. Reload the page to try again.
        </p>
      ) : null}
      {engine === null ? null : (
        <Controller
          engine={engine}
          unlocks={unlocks}
          pulse={setup.pulse ?? (unlocks === LESSON_ONE ? "A.play" : null)}
          captions={setup.captions.length > 0 ? setup.captions : unlocks === LESSON_ONE ? LESSON_ONE_CAPTIONS : NO_CAPTIONS}
          defaultLegendOpen
        />
      )}
    </main>
  );
}
