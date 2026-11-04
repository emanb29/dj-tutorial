// The whole app from the DDJ-FLX4, no keyboard or mouse: BROWSE moves a ring between the page's
// buttons and presses one, LOAD and SHIFT + BROWSE are the keys the pages listen for (the table is in
// src/app/controller/flx4-keys.ts). Mounted once, on every page; the decks' own controls go through the
// controller session instead (src/app/controller/hardware.ts) and never reach this.

import { useEffect, useState } from "react";
import { Flx4Decoder, midiConnection } from "@midi";
import { flx4Command } from "./controller/flx4-keys.ts";
import { FocusNavigator, type NavigationNotice } from "./controller/focus-navigation.ts";

/** How long a "the controller can't do that here" line stays. */
const NOTICE_MS = 4000;
/** Set on <html> while the FLX4 moves the ring: the ring is drawn large (theme.css). Cleared by a pointer. */
const NAV_ATTRIBUTE = "data-controller-nav";

export function ControllerNavigation() {
  const [notice, setNotice] = useState<NavigationNotice | null>(null);

  useEffect(() => {
    const decoder = new Flx4Decoder();
    const navigator = new FocusNavigator(document);
    const root = document.documentElement;
    const stopMidi = midiConnection().onMessage((message) => {
      const input = decoder.decode(message.data);
      const command = input === null ? null : flx4Command(input);
      if (command === null) return;
      root.setAttribute(NAV_ATTRIBUTE, "");
      const said =
        command.kind === "move"
          ? navigator.move(command.step)
          : command.kind === "jump"
            ? navigator.jump(command.step)
            : command.kind === "select"
              ? navigator.select()
              : command.loadDeck === undefined
                ? navigator.key(command.code)
                : navigator.load(command.loadDeck, command.code);
      root.toggleAttribute("data-controller-changing", navigator.changingValue);
      if (said !== null) setNotice(said);
    });
    const onPointer = () => {
      root.removeAttribute(NAV_ATTRIBUTE);
    };
    window.addEventListener("pointerdown", onPointer, { capture: true });
    return () => {
      stopMidi();
      window.removeEventListener("pointerdown", onPointer, { capture: true });
      root.removeAttribute(NAV_ATTRIBUTE);
    };
  }, []);

  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => {
      setNotice(null);
    }, NOTICE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [notice]);

  return notice === null ? null : (
    <p className="controller-nav-notice" role="status" data-testid="controller-nav-notice">
      {notice.text}
    </p>
  );
}
