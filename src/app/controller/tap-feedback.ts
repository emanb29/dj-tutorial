// TAP between the Lesson and the FLX4, both ways:
// - the Lesson announces each tap it judges (on the beat or not), and the bridge blinks the pad it came from;
// - the bridge publishes which hardware control is TAP now ("any pad", "BEAT ▶"), and captions name it.

import { useSyncExternalStore } from "react";

type JudgedListener = (onBeat: boolean) => void;

const judgedListeners = new Set<JudgedListener>();

/** Says a tap was judged; `onBeat` is the Lesson's own on-time verdict. */
export function announceTapJudged(onBeat: boolean): void {
  for (const listener of judgedListeners) listener(onBeat);
}

export function onTapJudged(listener: JudgedListener): () => void {
  judgedListeners.add(listener);
  return () => {
    judgedListeners.delete(listener);
  };
}

let tapOnHardware: string | null = null;
const nameListeners = new Set<() => void>();

/** The connected controller's TAP control by name, or null with no controller (or TAP locked). */
export function publishTapOnHardware(name: string | null): void {
  if (name === tapOnHardware) return;
  tapOnHardware = name;
  for (const listener of nameListeners) listener();
}

function subscribeName(listener: () => void): () => void {
  nameListeners.add(listener);
  return () => {
    nameListeners.delete(listener);
  };
}

/** The hardware TAP's name for captions; re-renders when the controller or the unlocks change. */
export function useTapOnHardware(): string | null {
  return useSyncExternalStore(
    subscribeName,
    () => tapOnHardware,
    () => null,
  );
}
