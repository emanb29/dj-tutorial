// Pointer, wheel and keyboard handling shared by knobs and faders. Drags are relative (grab anywhere on
// the hit area; the control never jumps), Shift is fine adjust, double-click resets, and a control
// focused with Tab takes Arrow/Page/Home/End nudges. A click does not take focus, so the deck keys keep
// working after a drag.

import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent, type RefObject } from "react";
import type { InputDevice } from "@audio";
import { keepFocusWhereItIs } from "./ControlButton.tsx";
import { useController, useSessionValue } from "./context.tsx";
import { faderTravelPx, isTempoFader, SIDEWAYS_FINE_PX, type ContinuousControlId } from "./gestures.ts";
import type { DragGesture } from "./session.ts";

export type DragAxis = "vertical" | "horizontal";

interface ActiveDrag {
  readonly gesture: DragGesture;
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
}

/**
 * `track`, for a fader, is the element its cap runs along: a drag over the track's rendered length
 * sweeps the whole range, so the cap stays under the pointer at any size. Knobs leave it out and sweep
 * over `FULL_TRAVEL_PX`.
 */
export function useContinuousControl(id: ContinuousControlId, axis: DragAxis, track?: RefObject<HTMLElement | null>) {
  const { session } = useController();
  const value = useSessionValue(() => session.valueOf(id));
  const target = useRef<HTMLDivElement>(null);
  const drag = useRef<ActiveDrag | null>(null);
  // The device of the last pointer press, so a double-click reset is recorded with it.
  const lastPointerDevice = useRef<InputDevice | null>(null);

  // Wheel needs a non-passive listener so a scroll over a control moves it instead of the page.
  useEffect(() => {
    const node = target.current;
    if (node === null) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      // Chromium turns Shift + vertical scroll into horizontal scroll; undo that so Shift is only "fine".
      const swapped = event.shiftKey && event.deltaY === 0;
      const deltas = { deltaX: swapped ? 0 : event.deltaX, deltaY: swapped ? event.deltaX : event.deltaY, deltaMode: event.deltaMode };
      session.wheel(id, deltas, { fine: event.shiftKey, eventTimeMs: event.timeStamp });
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      node.removeEventListener("wheel", onWheel);
    };
  }, [session, id]);

  // Unmounting mid-drag still ends the gesture, so the recorder gets its gestureEnd.
  useEffect(
    () => () => {
      const active = drag.current;
      drag.current = null;
      active?.gesture.end({ eventTimeMs: performance.now() });
    },
    [],
  );

  const travel = (event: PointerEvent, start: ActiveDrag) => (axis === "vertical" ? start.startY - event.clientY : event.clientX - start.startX);
  // A finger has no Shift: on a touchscreen, sliding it out to the side of a tempo fader is fine adjust
  // (as media scrubbing on a phone), so a BPM can be set to a tenth.
  const fineAdjust = (event: PointerEvent, start: ActiveDrag) =>
    event.shiftKey || (event.pointerType === "touch" && isTempoFader(id) && Math.abs(event.clientX - start.startX) >= SIDEWAYS_FINE_PX);

  const release = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (active?.pointerId !== event.pointerId) return;
    // Letting go of a second mouse button mid-drag is not the end of the drag.
    if (event.type === "pointerup" && event.button !== 0) return;
    drag.current = null;
    active.gesture.end({ eventTimeMs: event.timeStamp });
  };

  return {
    value,
    target,
    handlers: {
      onMouseDown: keepFocusWhereItIs,
      onPointerDown(event: PointerEvent<HTMLDivElement>) {
        if (event.button !== 0 || drag.current !== null) return;
        const device = session.devices.fromPointer(event.pointerType);
        lastPointerDevice.current = device;
        // Measured at each press: the layout (phone or laptop, portrait or landscape) can change between drags.
        const trackBox = track?.current?.getBoundingClientRect();
        const gesture = session.beginDrag(
          id,
          device,
          trackBox === undefined ? {} : { fullTravelPx: faderTravelPx(axis === "vertical" ? trackBox.height : trackBox.width) },
        );
        if (gesture === null) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { gesture, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY };
      },
      onPointerMove(event: PointerEvent<HTMLDivElement>) {
        const active = drag.current;
        if (active?.pointerId !== event.pointerId) return;
        active.gesture.move(travel(event, active), { fine: fineAdjust(event, active), eventTimeMs: event.timeStamp });
      },
      onPointerUp: release,
      onPointerCancel: release,
      onLostPointerCapture: release,
      onDoubleClick(event: MouseEvent<HTMLDivElement>) {
        session.reset(id, { device: lastPointerDevice.current ?? session.devices.fromPointer("mouse"), eventTimeMs: event.timeStamp });
      },
      onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        if (session.nudge(id, event.key, { fine: event.shiftKey, eventTimeMs: event.timeStamp })) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
    },
  };
}
