// The tap test on the Controller page: a click track, and how early or late each TAP lands against
// what was heard. It times taps exactly as a Lesson does (the MIDI message's time, mapped to heard time
// through the output timestamp), so the Learner can check their controller's timing before a Check.

import { useEffect, useRef, useState } from "react";
import { audioContextClock } from "@audio";
import { TAP_TOLERANCE_MS } from "@checks";
import { Flx4Decoder, midiConnection, type Flx4Input } from "@midi";

const CLICK_BPM = 100;
const CLICKS = 24;
const LEAD_IN_SEC = 0.6;
const CLICK_SEC = 0.03;

/** The presses that are TAP in an early Lesson: any pad, BEAT ◀ / ▶, the BROWSE press. */
export function isTapPress(input: Flx4Input): boolean {
  if (input.kind === "pad") return input.pressed;
  if (input.kind !== "button" || !input.pressed) return false;
  return (input.control === "browse-press" && !input.shift) || input.control === "fx-beat-back" || input.control === "fx-beat-forward";
}

/** Milliseconds from the nearest click to a tap heard at `heardSec` (negative: early). */
export function offsetFromClicks(heardSec: number, firstClickSec: number, beatSec: number): number {
  const beats = (heardSec - firstClickSec) / beatSec;
  return (beats - Math.round(beats)) * beatSec * 1000;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

const signed = (ms: number) => `${ms > 0 ? "+" : ""}${String(Math.round(ms))} ms`;

interface Run {
  readonly context: AudioContext;
  readonly firstClickSec: number;
}

export function TapTest() {
  const [offsets, setOffsets] = useState<readonly number[]>([]);
  const [running, setRunning] = useState(false);
  const run = useRef<Run | null>(null);

  useEffect(() => {
    if (!running) return;
    const current = run.current;
    if (current === null) return;
    const clock = audioContextClock(current.context);
    const beatSec = 60 / CLICK_BPM;
    const tapAt = (eventTimeMs: number) => {
      const heard = clock.heardTime(eventTimeMs);
      if (!heard.ok) return;
      setOffsets((list) => [...list, offsetFromClicks(heard.ctx, current.firstClickSec, beatSec)]);
    };
    const decoder = new Flx4Decoder();
    const stopMidi = midiConnection().onMessage((message) => {
      const input = decoder.decode(message.data);
      if (input !== null && isTapPress(input)) tapAt(message.timeStamp);
    });
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      event.preventDefault();
      tapAt(event.timeStamp);
    };
    window.addEventListener("keydown", onKey);
    const done = setTimeout(
      () => {
        setRunning(false);
      },
      (LEAD_IN_SEC + CLICKS * beatSec + 0.5) * 1000,
    );
    return () => {
      stopMidi();
      window.removeEventListener("keydown", onKey);
      clearTimeout(done);
      void current.context.close();
      run.current = null;
    };
  }, [running]);

  const start = () => {
    const context = new AudioContext();
    const firstClickSec = context.currentTime + LEAD_IN_SEC;
    const beatSec = 60 / CLICK_BPM;
    for (let click = 0; click < CLICKS; click++) {
      const at = firstClickSec + click * beatSec;
      const tone = new OscillatorNode(context, { frequency: click % 4 === 0 ? 1500 : 1000 });
      const level = new GainNode(context, { gain: 0 });
      level.gain.setValueAtTime(0.4, at);
      level.gain.exponentialRampToValueAtTime(0.001, at + CLICK_SEC);
      tone.connect(level).connect(context.destination);
      tone.start(at);
      tone.stop(at + CLICK_SEC + 0.01);
    }
    run.current = { context, firstClickSec };
    setOffsets([]);
    setRunning(true);
  };

  const last = offsets.at(-1);
  return (
    <>
      <p className="hw-hint">
        Tap SHIFT + BEAT ▶ (TAP), any pad or Space on each click, {CLICKS} clicks at {CLICK_BPM} BPM. A Lesson counts a tap within {TAP_TOLERANCE_MS} ms as on time.
      </p>
      <button type="button" className="btn" disabled={running} onClick={start}>
        {running ? "Listening…" : "Start the tap test"}
      </button>
      {last === undefined ? null : (
        <p data-testid="tap-offset">
          Last tap {signed(last)} · typical {signed(median(offsets))} over {offsets.length} {offsets.length === 1 ? "tap" : "taps"}
        </p>
      )}
    </>
  );
}
