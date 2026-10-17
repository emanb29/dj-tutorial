// Which device made an input, recorded with every command so Check tolerances can be tuned per device
// (check-design "Input leeway"). PointerEvent.pointerType says "mouse" for both a mouse and a trackpad,
// so trackpads are told apart by how they scroll: sideways deltas and small fractional pixel steps
// come from a trackpad; line-mode deltas and large whole notches come from a mouse wheel.
// This is a heuristic. A Mac laptop is assumed to be on its trackpad until a mouse wheel is seen.

import type { InputDevice } from "@audio";

export interface WheelDeltas {
  readonly deltaX: number;
  readonly deltaY: number;
  /** WheelEvent.deltaMode: 0 pixels, 1 lines, 2 pages. */
  readonly deltaMode: number;
}

export type WheelEvidence = "trackpad" | "mouse" | "unknown";

/** A mouse wheel notch is about 100–120 px in Chromium; trackpads send many small steps. */
const MOUSE_NOTCH_MIN_PX = 50;

export function classifyWheel(wheel: WheelDeltas): WheelEvidence {
  if (wheel.deltaMode !== 0) return "mouse";
  if (wheel.deltaX !== 0) return "trackpad";
  if (!Number.isInteger(wheel.deltaY)) return "trackpad";
  if (Math.abs(wheel.deltaY) >= MOUSE_NOTCH_MIN_PX) return "mouse";
  return "unknown";
}

export class InputDeviceDetector {
  private evidence: "trackpad" | "mouse";

  constructor(options: { macPlatform: boolean }) {
    this.evidence = options.macPlatform ? "trackpad" : "mouse";
  }

  /** Records what a wheel event says about the pointing device, and returns the device that made it. */
  observeWheel(wheel: WheelDeltas): "trackpad" | "mouse" {
    const evidence = classifyWheel(wheel);
    if (evidence !== "unknown") this.evidence = evidence;
    return this.evidence;
  }

  fromPointer(pointerType: string): InputDevice {
    if (pointerType === "touch" || pointerType === "pen") return "touch";
    return this.evidence;
  }
}

/** True on a Mac, where a pointer is most likely the built-in trackpad. */
export function isMacPlatform(navigatorLike: { readonly userAgent: string }): boolean {
  return /Macintosh|Mac OS X/.test(navigatorLike.userAgent);
}
