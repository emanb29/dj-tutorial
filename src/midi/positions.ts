// Where the DDJ-FLX4's faders and knobs physically are, as far as the app knows. AlphaTheta's MIDI list
// has no message that asks the unit for its positions (docs/research/flx4-midi.md, "Positions on
// connect"), so a control's position is known once it has moved (or once the unit answered the
// unofficial position request, when the Learner allowed SysEx). Kept for the whole tab, across Lessons,
// and forgotten when the controller is unplugged.

import { midiConnection, type MidiConnection } from "./connection.ts";
import { Flx4Decoder, physicalControlOf } from "./decoder.ts";

export interface KnownPosition {
  /** 0…1 along the control's travel (bottom, left, fully counter-clockwise, or tempo's "−" end is 0). */
  readonly value: number;
  readonly atMs: number;
}

export class HardwarePositions {
  private readonly known = new Map<string, KnownPosition>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  /** A continuous control (physicalControlOf's id) seen at `value`. */
  record(id: string, value: number, atMs: number): void {
    this.known.set(id, { value, atMs });
    this.changed();
  }

  get(id: string): KnownPosition | null {
    return this.known.get(id) ?? null;
  }

  ids(): ReadonlySet<string> {
    return new Set(this.known.keys());
  }

  clear(): void {
    if (this.known.size === 0) return;
    this.known.clear();
    this.changed();
  }

  /** Increases on every change, for useSyncExternalStore. */
  snapshot = (): number => this.version;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private changed(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}

let shared: HardwarePositions | null = null;

/** The app's one record of the controller's positions, fed by the app's one MIDI connection. */
export function hardwarePositions(): HardwarePositions {
  if (shared === null) {
    shared = new HardwarePositions();
    trackPositions(midiConnection(), shared);
  }
  return shared;
}

/** Feeds `positions` from every fader and knob message, and empties it when the controller goes away. */
export function trackPositions(connection: Pick<MidiConnection, "onMessage" | "subscribe" | "connected">, positions: HardwarePositions): () => void {
  const decoder = new Flx4Decoder();
  const stopMessages = connection.onMessage((message) => {
    const input = decoder.decode(message.data);
    if (input?.kind !== "continuous") return;
    const id = physicalControlOf(input);
    if (id !== null) positions.record(id, input.value, message.timeStamp);
  });
  const stopStatus = connection.subscribe(() => {
    if (!connection.connected) positions.clear();
  });
  return () => {
    stopMessages();
    stopStatus();
  };
}
