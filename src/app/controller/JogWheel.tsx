// The jog wheel (research §3). On a paused deck, turning it searches: the playhead moves with the
// platter, to find a cue point. On a playing deck it bends pitch: the deck speeds up (clockwise) or slows
// down, by how fast it turns (once the nudge-phase Lesson unlocks it). Dragging round the platter (a
// finger on a phone), scrolling over it (a trackpad) and holding the nudge keys (keymap.ts) all work.
// The platter's marker turns with the playhead at 33⅓ rpm.

import { useEffect, useRef, type PointerEvent } from "react";
import type { DeckId } from "@audio";
import { deckControl } from "./control-ids.ts";
import { useController, useSessionValue } from "./context.tsx";
import { ControlFrame, type CaptionSide } from "./ControlFrame.tsx";
import { useFrame } from "./frame-loop.ts";
import { wheelTravelPx } from "./gestures.ts";
import { keyHintFor } from "./keymap.ts";
import { useHoldTouchesToControl } from "./no-fling.ts";
import type { JogGesture } from "./session.ts";

const REVOLUTIONS_PER_SEC = 100 / 3 / 60;
/** With no movement for this long, a held jog wheel stops bending. */
const STILL_MS = 70;
/** Wheel scrolling: pixels of scroll that count as one radian of platter turn. */
const WHEEL_PX_PER_RADIAN = 60;
const WHEEL_END_MS = 140;

interface Turning {
  readonly gesture: JogGesture;
  readonly pointerId: number;
  angle: number;
  timeMs: number;
}

function angleAround(element: HTMLElement, event: { clientX: number; clientY: number }): number {
  const box = element.getBoundingClientRect();
  return Math.atan2(event.clientY - (box.top + box.height / 2), event.clientX - (box.left + box.width / 2));
}

/** The smallest signed difference between two angles, so crossing ±π does not jump. */
function angleDelta(from: number, to: number): number {
  const delta = to - from;
  return Math.atan2(Math.sin(delta), Math.cos(delta));
}

export function JogWheel({ deck, captionSide }: { readonly deck: DeckId; readonly captionSide?: CaptionSide }) {
  const { session, engine, frames } = useController();
  const surface = useRef<HTMLDivElement>(null);
  const platter = useRef<HTMLDivElement>(null);
  const turning = useRef<Turning | null>(null);
  const stillTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touched = useSessionValue((snapshot) => snapshot.jogTouched[deck]);

  useFrame(frames, () => {
    const reading = engine.playhead(deck);
    if (!reading.ok || platter.current === null) return;
    const degrees = (reading.positionSec * REVOLUTIONS_PER_SEC * 360) % 360;
    platter.current.style.transform = `rotate(${degrees.toFixed(1)}deg)`;
  });

  useHoldTouchesToControl(surface);

  // Scroll over the platter: one jog gesture per burst of wheel events.
  useEffect(() => {
    const node = surface.current;
    if (node === null) return;
    let burst: { gesture: JogGesture; timeMs: number; end: ReturnType<typeof setTimeout> | undefined } | null = null;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const device = session.devices.observeWheel(event);
      if (burst === null) {
        const gesture = session.beginJog(deck, device);
        if (gesture === null) return;
        burst = { gesture, timeMs: event.timeStamp - 16, end: undefined };
      }
      const current = burst;
      clearTimeout(current.end);
      const radians = wheelTravelPx(event, { natural: session.naturalScrolling }) / WHEEL_PX_PER_RADIAN;
      current.gesture.turn(radians, Math.max(8, event.timeStamp - current.timeMs), { eventTimeMs: event.timeStamp });
      current.timeMs = event.timeStamp;
      current.end = setTimeout(() => {
        current.gesture.end({ eventTimeMs: performance.now() });
        burst = null;
      }, WHEEL_END_MS);
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      node.removeEventListener("wheel", onWheel);
      if (burst !== null) {
        clearTimeout(burst.end);
        burst.gesture.end({ eventTimeMs: performance.now() });
      }
    };
  }, [session, deck]);

  // Unmounting mid-turn still ends the gesture: the deck stops bending and the recorder gets gestureEnd.
  useEffect(
    () => () => {
      if (stillTimer.current !== null) clearTimeout(stillTimer.current);
      const active = turning.current;
      turning.current = null;
      active?.gesture.end({ eventTimeMs: performance.now() });
    },
    [],
  );

  const release = (event: PointerEvent<HTMLDivElement>) => {
    const active = turning.current;
    if (active?.pointerId !== event.pointerId) return;
    if (event.type === "pointerup" && event.button !== 0) return;
    turning.current = null;
    if (stillTimer.current !== null) clearTimeout(stillTimer.current);
    active.gesture.end({ eventTimeMs: event.timeStamp });
  };

  return (
    <ControlFrame id={deckControl(deck, "jog")} className="jog" keyHint={keyHintFor(deckControl(deck, "jog-bend"))} {...(captionSide === undefined ? {} : { captionSide })}>
      <div
        ref={surface}
        className="jog-surface"
        data-touched={touched}
        role="group"
        aria-roledescription="jog wheel"
        aria-label={`Deck ${deck} jog wheel: drag round or scroll; paused it searches, playing it nudges`}
        title="Jog wheel: turn it (drag round, or scroll). Paused: moves the playhead. Playing: nudges the deck faster or slower."
        onPointerDown={(event) => {
          if (event.button !== 0 || turning.current !== null) return;
          const gesture = session.beginJog(deck, session.devices.fromPointer(event.pointerType));
          if (gesture === null) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          turning.current = { gesture, pointerId: event.pointerId, angle: angleAround(event.currentTarget, event), timeMs: event.timeStamp };
        }}
        onPointerMove={(event) => {
          const active = turning.current;
          if (active?.pointerId !== event.pointerId) return;
          const angle = angleAround(event.currentTarget, event);
          active.gesture.turn(angleDelta(active.angle, angle), event.timeStamp - active.timeMs, { eventTimeMs: event.timeStamp });
          active.angle = angle;
          active.timeMs = event.timeStamp;
          if (stillTimer.current !== null) clearTimeout(stillTimer.current);
          stillTimer.current = setTimeout(() => {
            active.gesture.turn(0, STILL_MS, { eventTimeMs: performance.now() });
          }, STILL_MS);
        }}
        onPointerUp={release}
        onPointerCancel={release}
        onLostPointerCapture={release}
      >
        <div className="jog-ring" />
        <div ref={platter} className="jog-platter">
          <span className="jog-marker" />
        </div>
        <div className="jog-centre">{deck}</div>
      </div>
    </ControlFrame>
  );
}
