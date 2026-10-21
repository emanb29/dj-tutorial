// A key hint that names the FLX4's button too while it is connected: "Enter" + "LOAD A". The button
// comes from the one table (flx4-keys.ts), so a hint and the controller can never disagree.

import { useSyncExternalStore } from "react";
import { midiConnection } from "@midi";
import { shortButtonForKey } from "./flx4-keys.ts";

/** Whether a DDJ-FLX4 is connected now; re-renders as it is plugged in and out. */
export function useControllerConnected(): boolean {
  const midi = midiConnection();
  return useSyncExternalStore(
    midi.subscribe,
    () => midi.connected,
    () => false,
  );
}

/** Only the FLX4's button for a key (`<kbd>LOAD A</kbd>`), while it is connected; nothing otherwise. */
export function ButtonHint({ k }: { readonly k: string }) {
  const connected = useControllerConnected();
  const button = connected ? shortButtonForKey(k) : null;
  return button === null ? null : <kbd className="hw-key">{button}</kbd>;
}

/** `<kbd>Enter</kbd>`, and with the FLX4 connected `<kbd>LOAD A</kbd>` beside it. */
export function KeyHint({ k }: { readonly k: string }) {
  const connected = useControllerConnected();
  const button = connected ? shortButtonForKey(k) : null;
  return (
    <>
      <kbd>{k}</kbd>
      {button === null ? null : (
        <>
          <span className="key-or"> / </span>
          <kbd className="hw-key">{button}</kbd>
        </>
      )}
    </>
  );
}
