// The virtual DJ controller (DDJ-FLX4 layout). It sends every input to the audio engine's command API
// and draws meters and playheads from engine events on requestAnimationFrame.
//
// Teaching props: `unlocks` (controls not in it are dimmed and ignore input), `pulse` (the one control
// to touch next), and `captions` (one line next to a control). The controller filling up is the
// progress bar, so a newly unlocked control plays a small reward animation.

import { useEffect, useMemo, useState } from "react";
import { midiConnection } from "@midi";
import type { ControlId, ControllerUnlocks } from "./control-ids.ts";
import { ControllerContext, type ControllerCaption, type ControllerContextValue, type MeterLevels } from "./context.tsx";
import { ControlButton } from "./ControlButton.tsx";
import { Deck } from "./Deck.tsx";
import { DeckReadout, PhaseStrip } from "./displays.tsx";
import { pressedByController } from "./focus-navigation.ts";
import { FrameLoop } from "./frame-loop.ts";
import { HardwareBridge } from "./hardware.ts";
import { isMacPlatform } from "./input-device.ts";
import { useControllerConnected } from "./KeyHint.tsx";
import { globalKeyAllowed, keyHintFor, type FocusedElement } from "./keymap.ts";
import { KeyLegend } from "./KeyLegend.tsx";
import { Mixer } from "./Mixer.tsx";
import { ControllerSession, type ControllerEngine } from "./session.ts";
import { useTapOnHardware } from "./tap-feedback.ts";
import { inputWording, useWording } from "./wording.ts";
import "./controller.css";

export interface ControllerProps {
  /** Fixed for the controller's lifetime; give the controller a new `key` to switch engines. */
  readonly engine: ControllerEngine;
  readonly unlocks: ControllerUnlocks;
  readonly pulse?: ControlId | null;
  readonly captions?: readonly ControllerCaption[];
  /**
   * Unlocked controls to hold locked and unlit for now, without the unlock reward when they come back
   * (tempo-fader's listening clips: a lit Master Tempo would give the answer away).
   */
  readonly concealed?: ReadonlySet<ControlId>;
  /** Whether the key legend starts open. The Learner can toggle it with "?" or its button. */
  readonly defaultLegendOpen?: boolean;
  /** Where the sound goes, one short line by the headphone controls (src/audio/output.ts outputLine). */
  readonly outputLine?: string | null;
}

const NO_CAPTIONS: readonly ControllerCaption[] = [];
const NONE_CONCEALED: ReadonlySet<ControlId> = new Set();

function focusedElement(target: EventTarget | null): FocusedElement | null {
  if (!(target instanceof HTMLElement) || target === document.body) return null;
  return { tagName: target.tagName, role: target.getAttribute("role"), isContentEditable: target.isContentEditable };
}

export function Controller({ engine, unlocks, pulse = null, captions = NO_CAPTIONS, concealed = NONE_CONCEALED, defaultLegendOpen = false, outputLine = null }: ControllerProps) {
  const [session] = useState(() => new ControllerSession(engine, { unlocks, macPlatform: isMacPlatform(navigator) }));
  const [frames] = useState(() => new FrameLoop());
  const [meters] = useState<MeterLevels>(() => new Map());
  const [legendOpen, setLegendOpen] = useState(defaultLegendOpen);
  const wording = useWording();
  const tapOnHardware = useTapOnHardware();
  const controllerConnected = useControllerConnected();

  useEffect(() => {
    session.setUnlocks(concealed.size === 0 ? unlocks : new Set([...unlocks].filter((id) => !concealed.has(id))));
  }, [session, unlocks, concealed]);

  useEffect(() => session.connect(), [session]);

  // The DDJ-FLX4, when one is connected: the same session, so the same locks and the same recording.
  useEffect(() => new HardwareBridge(session, engine, midiConnection()).attach(), [session, engine]);

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
      // LOAD and BROWSE press the app's keys (Enter, R, P, N, Esc): never the decks' (N is a crossfader cut).
      if (pressedByController(event) || !globalKeyAllowed(focusedElement(event.target), event.code, event.isComposing)) return;
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

  // Captions are authored with keys ("Press X"); on a touchscreen they name the control instead.
  const captionMap = useMemo(() => new Map(captions.map((caption) => [caption.control, inputWording(caption.text, wording, tapOnHardware, controllerConnected)])), [captions, wording, tapOnHardware, controllerConnected]);
  const context = useMemo<ControllerContextValue>(
    () => ({ session, engine, frames, meters, pulse, captions: captionMap, unlocks, concealed, legendOpen }),
    [session, engine, frames, meters, pulse, captionMap, unlocks, concealed, legendOpen],
  );

  return (
    <ControllerContext value={context}>
      <div className="controller" data-legend-open={legendOpen} data-input={wording} data-nav-skip>
        <header className="controller-display">
          <DeckReadout deck="A" />
          <div className="display-centre">
            <PhaseStrip />
            {/* The FLX4 has no TAP button: SHIFT + BEAT ▶ is TAP (the Beat FX column), and with keys Space
                taps. On a touchscreen, where SHIFT and BEAT ▶ at once are awkward, a TAP button stands in. */}
            {wording !== "touch" ? null : (
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
            )}
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
          <Mixer outputLine={outputLine} />
          <Deck deck="B" />
        </div>
        {legendOpen ? <KeyLegend /> : null}
      </div>
    </ControllerContext>
  );
}
