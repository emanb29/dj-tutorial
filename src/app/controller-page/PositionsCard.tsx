// Where the FLX4's faders and knobs are (Controller page). The FLX4 cannot be asked for its positions in
// AlphaTheta's MIDI list, so the app learns each one when it moves: "Sync from controller" lists them
// and ticks each as it reports. Docs: docs/research/flx4-midi.md.

import { useState, useSyncExternalStore } from "react";
import { CHECKLIST, hardwarePositions } from "@midi";

/** The faders and knobs the app maps (MIC LEVEL is not used), as the checklist names them. */
const MAPPED = new Set(["tempo", "trim", "eq-high", "eq-mid", "eq-low", "filter", "channel-fader", "crossfader", "master-level", "headphone-mix", "headphone-level", "beat-fx-depth"]);
const CONTINUOUS_ITEMS = CHECKLIST.filter((item) => MAPPED.has(item.id.replace(/^[AB]\./, "")));

export function PositionsCard({ connected }: { readonly connected: boolean }) {
  const positions = hardwarePositions();
  useSyncExternalStore(positions.subscribe, positions.snapshot);
  const known = positions.ids();
  const [syncing, setSyncing] = useState(false);
  const done = CONTINUOUS_ITEMS.filter((item) => known.has(item.id)).length;

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
    </>
  );
}
