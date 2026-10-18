// Where the FLX4's faders and knobs are (Controller page). The FLX4 cannot be asked for its positions in
// AlphaTheta's MIDI list, so the app learns each one when it moves: "Sync from controller" lists them
// and ticks each as it reports. Optionally, with the Learner's SysEx permission, the app sends the
// unofficial position request on connect (src/midi/connection.ts). Docs: docs/research/flx4-midi.md.

import { useState, useSyncExternalStore } from "react";
import { CHECKLIST, hardwarePositions, midiConnection } from "@midi";
import { chooseSysex, sysexChosen } from "../midi-sysex.ts";

/** The faders and knobs the app maps (MIC LEVEL is not used), as the checklist names them. */
const MAPPED = new Set(["tempo", "trim", "eq-high", "eq-mid", "eq-low", "filter", "channel-fader", "crossfader", "master-level", "headphone-mix", "headphone-level", "beat-fx-depth"]);
const CONTINUOUS_ITEMS = CHECKLIST.filter((item) => MAPPED.has(item.id.replace(/^[AB]\./, "")));

type SysexState = "off" | "asking" | "on" | "refused";

export function PositionsCard({ connected }: { readonly connected: boolean }) {
  const positions = hardwarePositions();
  useSyncExternalStore(positions.subscribe, positions.snapshot);
  const known = positions.ids();
  const [syncing, setSyncing] = useState(false);
  const [sysex, setSysex] = useState<SysexState>(() => (sysexChosen() && midiConnection().canRequestPositions ? "on" : "off"));
  const done = CONTINUOUS_ITEMS.filter((item) => known.has(item.id)).length;

  const allowSysex = async () => {
    setSysex("asking");
    chooseSysex(true);
    const granted = await midiConnection().enableSysex();
    if (!granted) {
      chooseSysex(false);
      setSysex("refused");
      return;
    }
    setSysex("on");
    midiConnection().requestPositions();
  };

  return (
    <>
      <p className="hw-hint" data-testid="positions-limit">
        The FLX4 can&apos;t say where its knobs sit until they move: the screen shows a dashed mark for each one once it has moved.
      </p>
      {syncing ? (
        <>
          <p>
            Wiggle each knob and fader a little.{" "}
            <span className="hw-count" data-testid="positions-count">
              {done} of {CONTINUOUS_ITEMS.length}
            </span>
          </p>
          <ul className="hw-positions">
            {CONTINUOUS_ITEMS.map((item) => (
              <li key={item.id} data-control={item.id} data-known={known.has(item.id)}>
                <span aria-hidden="true">{known.has(item.id) ? "✓" : "○"}</span> {item.group === "Mixer" || item.group === "Beat FX" ? item.label : `${item.label} ${item.group.replace("Deck ", "")}`}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <button
          type="button"
          className="btn"
          disabled={!connected}
          onClick={() => {
            setSyncing(true);
          }}
        >
          Sync from controller
        </button>
      )}
      <p className="hw-hint">
        Experimental: the app can also ask the FLX4 for every position when it connects, with a message AlphaTheta doesn&apos;t document (other DJ software uses it). Chrome will
        ask you to allow &quot;system exclusive&quot; MIDI messages; without it everything still works.
      </p>
      {sysex === "on" ? (
        <p data-testid="sysex-state">On: the app asks for positions each time the controller connects.</p>
      ) : (
        <button type="button" className="btn btn-quiet" disabled={!connected || sysex === "asking"} onClick={() => void allowSysex()}>
          {sysex === "asking" ? "Waiting for the browser…" : "Ask the FLX4 for its positions"}
        </button>
      )}
      {sysex === "refused" ? <p role="status">Not allowed. Positions are learnt as each control moves.</p> : null}
    </>
  );
}
