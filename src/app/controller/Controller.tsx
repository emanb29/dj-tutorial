// The virtual DJ controller (DDJ-FLX4 layout). It sends every input to the audio engine's command API
// and draws meters and playheads from engine events on requestAnimationFrame.
//
// Teaching props: `unlocks` (controls not in it are dimmed and ignore input), `pulse` (the one control
// to touch next), and `captions` (one line next to a control). The controller filling up is the
// progress bar, so a newly unlocked control plays a small reward animation.

import { useEffect, useMemo, useState } from "react";
import type { ControlId, ControllerUnlocks } from "./control-ids.ts";
import { ControllerContext, type ControllerCaption, type ControllerContextValue, type MeterLevels } from "./context.tsx";
import { ControlButton } from "./ControlButton.tsx";
import { Deck } from "./Deck.tsx";
import { DeckReadout, PhaseStrip } from "./displays.tsx";
import { FrameLoop } from "./frame-loop.ts";
import { isMacPlatform } from "./input-device.ts";
import { globalKeyAllowed, keyHintFor, type FocusedElement } from "./keymap.ts";
import { KeyLegend } from "./KeyLegend.tsx";
import { Mixer } from "./Mixer.tsx";
import { ControllerSession, type ControllerEngine } from "./session.ts";
import "./controller.css";

export interface ControllerProps {
  /** Fixed for the controller's lifetime; give the controller a new `key` to switch engines. */
  readonly engine: ControllerEngine;
  readonly unlocks: ControllerUnlocks;
  readonly pulse?: ControlId | null;
  readonly captions?: readonly ControllerCaption[];
  /** Whether the key legend starts open. The Learner can toggle it with "?" or its button. */
  readonly defaultLegendOpen?: boolean;
}

const NO_CAPTIONS: readonly ControllerCaption[] = [];

function focusedElement(target: EventTarget | null): FocusedElement | null {
  if (!(target instanceof HTMLElement) || target === document.body) return null;
  return { tagName: target.tagName, role: target.getAttribute("role"), isContentEditable: target.isContentEditable };
}

export function Controller({ engine, unlocks, pulse = null, captions = NO_CAPTIONS, defaultLegendOpen = false }: ControllerProps) {
  const [session] = useState(() => new ControllerSession(engine, { unlocks, macPlatform: isMacPlatform(navigator) }));
  const [frames] = useState(() => new FrameLoop());
  const [meters] = useState<MeterLevels>(() => new Map());
  const [legendOpen, setLegendOpen] = useState(defaultLegendOpen);

  useEffect(() => {
    session.setUnlocks(unlocks);
  }, [session, unlocks]);

  useEffect(() => session.connect(), [session]);

  useEffect(
    () =>
      engine.on("meter", (frame) => {
        meters.set(frame.bus, frame.samplePeakDb);
      }),
    [engine, meters],
  );

  useEffect(() => {
    session.onLegendToggle(() => {
      setLegendOpen((open) => !open);
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (!globalKeyAllowed(focusedElement(event.target), event.code, event.isComposing)) return;
      const { code, repeat, timeStamp, shiftKey, ctrlKey, metaKey, altKey } = event;
      if (session.keyDown({ code, repeat, timeStamp, shiftKey, ctrlKey, metaKey, altKey })) event.preventDefault();
    };
    // Releases are never filtered: a key pressed on the controller and released in a text box still lets go.
    const onKeyUp = (event: KeyboardEvent) => {
      if (session.keyUp({ code: event.code, timeStamp: event.timeStamp })) event.preventDefault();
    };
    // A release the page never sees (focus moved away, tab hidden) must not leave CUE or a drag held.
    const releaseAll = () => {
      session.releaseAll();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") session.releaseAll();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", releaseAll);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      session.onLegendToggle(null);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", releaseAll);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [session]);

  const captionMap = useMemo(() => new Map(captions.map((caption) => [caption.control, caption.text])), [captions]);
  const context = useMemo<ControllerContextValue>(
    () => ({ session, engine, frames, meters, pulse, captions: captionMap, unlocks, legendOpen }),
    [session, engine, frames, meters, pulse, captionMap, unlocks, legendOpen],
  );

  return (
    <ControllerContext value={context}>
      <div className="controller" data-legend-open={legendOpen}>
        <header className="controller-display">
          <DeckReadout deck="A" />
          <div className="display-centre">
            <PhaseStrip />
            <ControlButton
              id="tap"
              label="TAP"
              ariaLabel="Tap the beat"
              shape="small"
              keyHint={keyHintFor("tap")}
              onPress={(input) => {
                session.tap(input);
              }}
            />
            <button
              type="button"
              className="legend-toggle"
              aria-expanded={legendOpen}
              onClick={() => {
                setLegendOpen((open) => !open);
              }}
            >
              Keys <kbd>?</kbd>
            </button>
          </div>
          <DeckReadout deck="B" />
        </header>
        <div className="controller-body">
          <Deck deck="A" />
          <Mixer />
          <Deck deck="B" />
        </div>
        {legendOpen ? <KeyLegend /> : null}
      </div>
    </ControllerContext>
  );
}
