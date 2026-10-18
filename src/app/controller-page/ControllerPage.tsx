// The hardware page (/controller): connect the DDJ-FLX4, watch what it sends, test its LEDs, tick off
// every control in one pass, and choose where the sound goes. It works without a controller too: it
// says what to plug in.

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ALL_LEDS, allLedsOff, CHECKLIST, describeInput, Flx4Decoder, ledMessages, midiConnection, physicalControlOf, type MidiStatus } from "@midi";
import { OutputPicker } from "./OutputPicker.tsx";
import { sysexChosen } from "../midi-sysex.ts";
import { PositionsCard } from "./PositionsCard.tsx";
import { TimingCheck } from "./TimingCheck.tsx";
import "./controller-page.css";

const MONITOR_LINES = 12;
const LED_STEP_MS = 60;

interface MonitorLine {
  readonly key: number;
  readonly bytes: string;
  readonly text: string;
}

function useMidiStatus(): MidiStatus {
  const midi = midiConnection();
  return useSyncExternalStore(midi.subscribe, midi.status);
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(" ");

export function ControllerPage({ onBack }: { readonly onBack: () => void }) {
  const status = useMidiStatus();
  const [lines, setLines] = useState<readonly MonitorLine[]>([]);
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    void midiConnection().connectIfAllowed({ sysex: sysexChosen() });
    // Offered from the first tap Lesson: /controller#timing-check.
    if (window.location.hash === "#timing-check") document.getElementById("timing-check")?.scrollIntoView({ block: "start" });
  }, []);

  useEffect(() => {
    const decoder = new Flx4Decoder();
    let next = 0;
    return midiConnection().onMessage((message) => {
      const input = decoder.decode(message.data);
      if (input === null) return;
      const line = { key: next++, bytes: hex(message.data), text: describeInput(input) };
      setLines((current) => [line, ...current].slice(0, MONITOR_LINES));
      const id = physicalControlOf(input);
      if (id !== null) setSeen((current) => (current.has(id) ? current : new Set([...current, id])));
    });
  }, []);

  const groups = useMemo(() => [...new Set(CHECKLIST.map((item) => item.group))].map((group) => [group, CHECKLIST.filter((item) => item.group === group)] as const), []);
  const done = CHECKLIST.filter((item) => seen.has(item.id)).length;

  return (
    <main className="controller-page">
      <header className="controller-page-head">
        <button type="button" className="btn btn-quiet" onClick={onBack}>
          ← Lessons
        </button>
        <h1>Controller</h1>
      </header>

      <section aria-label="Connection" className="hw-card">
        <ConnectionStatus status={status} />
      </section>

      <section aria-label="Sound output" className="hw-card">
        <h2>Where the sound goes</h2>
        <OutputPicker />
      </section>

      <section aria-label="Timing check" className="hw-card" id="timing-check">
        <h2>Timing check</h2>
        <TimingCheck />
      </section>

      <section aria-label="Positions" className="hw-card">
        <h2>Where the knobs are</h2>
        <PositionsCard connected={status.kind === "connected"} />
      </section>

      <section aria-label="Controls checklist" className="hw-card">
        <h2>
          Move every control{" "}
          <span className="hw-count" data-testid="checklist-count">
            {done} of {CHECKLIST.length}
          </span>
        </h2>
        <p className="hw-hint">Each control ticks when the app hears it. Pads tick in any pad mode.</p>
        <div className="hw-checklist">
          {groups.map(([group, items]) => (
            <div key={group} className="hw-group" role="group" aria-label={group}>
              <h3>{group}</h3>
              <ul>
                {items.map((item) => (
                  <li key={item.id} data-control={item.id} data-seen={seen.has(item.id)}>
                    <span aria-hidden="true">{seen.has(item.id) ? "✓" : "○"}</span> {item.label}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section aria-label="MIDI monitor" className="hw-card">
        <h2>What the controller sends</h2>
        {lines.length === 0 ? (
          <p className="hw-hint">Nothing yet. Touch any control.</p>
        ) : (
          <ol className="hw-monitor" aria-live="polite">
            {lines.map((line) => (
              <li key={line.key}>
                <code>{line.bytes}</code> {line.text}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-label="LED test" className="hw-card">
        <h2>Lights</h2>
        <LedTest connected={status.kind === "connected"} />
      </section>

      <section aria-label="Hardware keys" className="hw-card">
        <h2>In a Lesson</h2>
        <ul className="hw-keys">
          <li>
            <b>LOAD</b> goes into the Check (Enter) · <b>SHIFT + LOAD</b> back to practice (P)
          </li>
          <li>
            <b>TAP</b> is <b>SHIFT + BEAT ▶</b> (TAP on the panel) and the <b>BROWSE press</b>; also any pad until the Lessons hand you hot cues, and <b>BEAT ◀ / ▶</b> until they hand you Beat FX · <b>SHIFT + BROWSE press</b> is Ready (R)
          </li>
          <li>
            <b>Hold BEAT SYNC</b> for MASTER TEMPO · <b>SHIFT + BEAT SYNC</b> changes the tempo range
          </li>
          <li>A control the Lesson has not opened yet says “Not yet” on screen. A dashed mark shows where a fader is until it meets the screen’s value.</li>
        </ul>
      </section>
    </main>
  );
}

function ConnectionStatus({ status }: { readonly status: MidiStatus }) {
  const connect = () => {
    void midiConnection().connect();
  };
  switch (status.kind) {
    case "unsupported":
      return <p data-testid="midi-status">This browser has no Web MIDI. Use Chrome, Edge or Arc on the Mac.</p>;
    case "not-asked":
      return (
        <>
          <p data-testid="midi-status">Plug the DDJ-FLX4 into the Mac with its USB cable (no driver needed), then connect.</p>
          <button type="button" className="btn btn-primary" onClick={connect}>
            Connect controller
          </button>
        </>
      );
    case "asking":
      return <p data-testid="midi-status">Waiting for the browser: allow MIDI devices.</p>;
    case "denied":
      return (
        <>
          <p data-testid="midi-status">{status.message}</p>
          <button type="button" className="btn" onClick={connect}>
            Try again
          </button>
        </>
      );
    case "no-controller":
      return (
        <>
          <p data-testid="midi-status">No DDJ-FLX4 found. Plug it in with its USB cable; it shows up here by itself.</p>
          {status.ports.length === 0 ? null : <p className="hw-hint">MIDI devices seen: {status.ports.join(", ")}</p>}
        </>
      );
    case "connected":
      return (
        <p data-testid="midi-status">
          <span className="hw-dot" aria-hidden="true" /> Connected: {status.inputName}
          {status.outputName === null ? " (no LED output)" : ""}
        </p>
      );
  }
}

function LedTest({ connected }: { readonly connected: boolean }) {
  const [running, setRunning] = useState(false);
  useEffect(() => {
    if (!running) return;
    const midi = midiConnection();
    let step = 0;
    const timer = setInterval(() => {
      const led = ALL_LEDS[step];
      if (led === undefined) {
        midi.send(allLedsOff());
        setRunning(false);
        return;
      }
      const previous = ALL_LEDS[step - 1];
      midi.send([...(previous === undefined ? [] : ledMessages(previous, false)), ...ledMessages(led, true)]);
      step += 1;
    }, LED_STEP_MS);
    return () => {
      clearInterval(timer);
      midi.send(allLedsOff());
    };
  }, [running]);
  return (
    <>
      <p className="hw-hint">Each light comes on in turn: PLAY, CUE, BEAT SYNC, channel CUE, loop, HOT CUE and the pads, deck A then B.</p>
      <button
        type="button"
        className="btn"
        disabled={!connected || running}
        onClick={() => {
          setRunning(true);
        }}
      >
        {running ? "Testing…" : "Test the lights"}
      </button>
    </>
  );
}
