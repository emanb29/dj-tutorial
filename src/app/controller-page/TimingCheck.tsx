// The Timing check (Controller page): a click track plays through the Learner's chosen output, they tap
// along 16 times (TAP on the FLX4 or any tap-like button there, Space, or the button on screen), and the
// median offset (outliers rejected, src/audio/input-latency.ts) is stored for this browser and output
// (src/app/timing-offset.ts). Every later engine takes it off the Learner's inputs before grading.
// The taps are measured raw: this engine has no correction of its own.

import { useEffect, useRef, useState } from "react";
import { createAudioEngine, MAX_INPUT_CORRECTION_MS, measureTimingOffset, TIMING_CHECK_TAPS, type AudioEngine, type BeatGrid, type TimingMeasurement } from "@audio";
import { Flx4Decoder, midiConnection } from "@midi";
import { currentOutputPlan, useOutputChoice } from "../audio-output.ts";
import { resetTiming, saveTiming, useTiming, type OutputMode } from "../timing-offset.ts";
import { isTapPress, offsetFromClicks } from "./tap-timing.ts";

const BPM = 100;
const BEAT_SEC = 60 / BPM;
/** Clicks before the taps count: listen first. */
const COUNT_IN = 4;
/** Clicks in all: the count-in, the taps asked for, and some slack for missed ones. */
const CLICKS = COUNT_IN + TIMING_CHECK_TAPS + 8;
const FIRST_CLICK_SEC = 0.5;
const CLICK_MS = 12;

declare global {
  interface Window {
    /** Set while the Timing check's clicks play, like a Lesson's handle: lets end-to-end tests follow the clicks. */
    learnToDjTimingCheck?: { readonly engine: AudioEngine };
  }
}

const MODE_NAMES: Readonly<Record<OutputMode, string>> = { "split-cue": "this computer's output", controller: "the FLX4", "two-devices": "two devices", "computer-and-controller-phones": "this computer and the FLX4's headphones", "dual-master": "the FLX4 and this computer (PC MASTER OUT)" };

/** A click track: a short tone burst on every beat, the first of each bar higher. */
function clickTrack(context: BaseAudioContext): { audio: AudioBuffer; grid: BeatGrid } {
  const seconds = FIRST_CLICK_SEC + CLICKS * BEAT_SEC + 1;
  const audio = context.createBuffer(2, Math.round(seconds * context.sampleRate), context.sampleRate);
  const left = audio.getChannelData(0);
  const clickSamples = Math.round((CLICK_MS / 1000) * context.sampleRate);
  for (let beat = 0; beat < CLICKS; beat++) {
    const start = Math.round((FIRST_CLICK_SEC + beat * BEAT_SEC) * context.sampleRate);
    const frequency = beat % 4 === 0 ? 1760 : 1320;
    for (let index = 0; index < clickSamples; index++) {
      const fade = 1 - index / clickSamples;
      left[start + index] = 0.6 * fade * Math.sin((2 * Math.PI * frequency * index) / context.sampleRate);
    }
  }
  audio.copyToChannel(left, 1);
  return { audio, grid: { bpm: BPM, firstBeat: FIRST_CLICK_SEC, downbeatIndex: 0, rmsResidualMs: 0 } };
}

/** Signed ms from the nearest counted click to a tap heard at track position `positionSec`, or null in the count-in. */
export function offsetFromNearestClick(positionSec: number): number | null {
  const beat = Math.round((positionSec - FIRST_CLICK_SEC) / BEAT_SEC);
  if (beat < COUNT_IN || beat >= CLICKS) return null;
  return offsetFromClicks(positionSec, FIRST_CLICK_SEC, BEAT_SEC);
}

type Run = { readonly kind: "idle" } | { readonly kind: "starting" } | { readonly kind: "listening"; readonly mode: OutputMode; readonly taps: number; readonly lastMs: number | null } | { readonly kind: "done"; readonly mode: OutputMode; readonly result: TimingMeasurement } | { readonly kind: "failed"; readonly message: string };

function describeOffset(offsetMs: number): string {
  const rounded = Math.round(offsetMs);
  if (rounded === 0) return "right on the click";
  return `${String(Math.abs(rounded))} ms ${rounded > 0 ? "late" : "early"}`;
}

function resultLine(result: TimingMeasurement, mode: OutputMode): string {
  switch (result.kind) {
    case "measured": {
      const bounded = Math.abs(result.offsetMs) > MAX_INPUT_CORRECTION_MS ? ` The app takes off at most ${String(MAX_INPUT_CORRECTION_MS)} ms.` : "";
      return `Your taps land ${describeOffset(result.offsetMs)} through ${MODE_NAMES[mode]}. Saved: tap grading allows for it from now on.${bounded}`;
    }
    case "too-few":
      return `Only ${String(result.kept)} taps were close to a click (${String(result.needed)} needed). Try again: tap with each click.`;
    case "too-unsteady":
      return "The taps were too uneven to read. Try again: a steady tap on every click.";
  }
}

export function TimingCheck() {
  const choice = useOutputChoice();
  const [run, setRun] = useState<Run>({ kind: "idle" });
  // The stored result for the output the next engine will use (the plan's mode, after any fallback).
  const [mode, setMode] = useState<OutputMode>(choice.kind);
  const stored = useTiming(mode);
  const engine = useRef<AudioEngine | null>(null);
  const offsets = useRef<number[]>([]);
  /** The tap handler while the clicks play, for the on-screen TAP button. */
  const tapNow = useRef<((eventTimeMs: number) => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    void currentOutputPlan().then((plan) => {
      if (!cancelled) setMode(plan.kind);
    });
    return () => {
      cancelled = true;
    };
  }, [choice]);

  const stop = () => {
    const running = engine.current;
    engine.current = null;
    delete window.learnToDjTimingCheck;
    if (running !== null) {
      running.close().catch((error: unknown) => {
        console.warn("[timing] the click track's engine did not close cleanly", error);
      });
    }
  };
  useEffect(() => stop, []);

  const listening = run.kind === "listening" ? run.mode : null;
  useEffect(() => {
    if (listening === null) return;
    const tapped = (eventTimeMs: number) => {
      const running = engine.current;
      if (running === null) return;
      const heard = running.heardTime(eventTimeMs);
      const reading = heard.ok ? running.playheadAt("A", heard.ctx) : null;
      const offset = reading === null ? null : offsetFromNearestClick(reading.positionSec);
      if (offset === null) return;
      offsets.current.push(offset);
      if (offsets.current.length < TIMING_CHECK_TAPS) {
        setRun({ kind: "listening", mode: listening, taps: offsets.current.length, lastMs: offset });
        return;
      }
      const result = measureTimingOffset(offsets.current);
      if (result.kind === "measured") saveTiming(listening, result.offsetMs, result.kept);
      stop();
      setRun({ kind: "done", mode: listening, result });
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      event.preventDefault();
      tapped(event.timeStamp);
    };
    const decoder = new Flx4Decoder();
    const stopMidi = midiConnection().onMessage((message) => {
      const input = decoder.decode(message.data);
      if (input !== null && isTapPress(input)) tapped(message.timeStamp);
    });
    tapNow.current = tapped;
    window.addEventListener("keydown", onKey);
    return () => {
      tapNow.current = null;
      window.removeEventListener("keydown", onKey);
      stopMidi();
    };
  }, [listening]);

  const start = async () => {
    stop();
    offsets.current = [];
    setRun({ kind: "starting" });
    try {
      const plan = await currentOutputPlan();
      const created = await createAudioEngine({ masterTempo: false, output: { plan, headphones: false } });
      engine.current = created;
      const { audio, grid } = clickTrack(created.context);
      const loaded = await created.load("A", audio, { trackId: "timing-check", grid });
      if (!loaded.ok) throw new Error("the click track would not load");
      if (created.context instanceof AudioContext) await created.context.resume();
      created.command({ control: "play", deck: "A" }, { device: "mouse" });
      window.learnToDjTimingCheck = { engine: created };
      setMode(plan.kind);
      // Space taps from here on; it must not press whichever button has focus.
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      setRun({ kind: "listening", mode: plan.kind, taps: 0, lastMs: null });
    } catch (error) {
      stop();
      setRun({ kind: "failed", message: `The click track could not play: ${error instanceof Error ? error.message : String(error)}` });
    }
  };

  return (
    <div className="timing-check" data-testid="timing-check">
      <p className="hw-hint">
        Tap along to {String(TIMING_CHECK_TAPS)} clicks (after {String(COUNT_IN)} to listen) with TAP (SHIFT + BEAT ▶) on the FLX4, Space, or the button below. Tap grading then
        allows for your setup&apos;s delay. Run it again after changing where the sound goes.
      </p>
      <p data-testid="timing-stored">
        {stored === null ? (
          <>Through {MODE_NAMES[mode]}: not measured yet.</>
        ) : (
          <>
            Through {MODE_NAMES[mode]}: taps land <b>{describeOffset(stored.offsetMs)}</b>; grading allows for it.{" "}
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => {
                resetTiming(mode);
              }}
            >
              Reset
            </button>
          </>
        )}
      </p>
      {run.kind === "listening" ? (
        <>
          <p role="status" data-testid="timing-progress">
            {run.lastMs === null ? "Listen to 4 clicks, then tap with each one." : `${String(run.taps)} of ${String(TIMING_CHECK_TAPS)} · last tap ${run.lastMs > 0 ? "+" : ""}${String(Math.round(run.lastMs))} ms`}
          </p>
          <button
            type="button"
            className="btn btn-primary timing-tap"
            onPointerDown={(event) => {
              event.preventDefault();
              tapNow.current?.(event.timeStamp);
            }}
          >
            TAP
          </button>
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => {
              stop();
              setRun({ kind: "idle" });
            }}
          >
            Stop
          </button>
        </>
      ) : (
        <button type="button" className="btn" disabled={run.kind === "starting"} onClick={() => void start()}>
          {run.kind === "starting" ? "Starting…" : stored === null ? "Start the timing check" : "Run it again"}
        </button>
      )}
      {run.kind === "done" ? (
        <p role="status" data-testid="timing-result">
          {resultLine(run.result, run.mode)}
        </p>
      ) : null}
      {run.kind === "failed" ? <p role="alert">{run.message}</p> : null}
      <p className="hw-hint">This is your tap timing. The headphone delay for two devices is separate (under Where the sound goes).</p>
    </div>
  );
}
