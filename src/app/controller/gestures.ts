// Gesture arithmetic for knobs and faders, and the mapping from a control to its engine command.
// Everything here is pure, so the leeway rules (relative drags, a centre catch, fine adjust) are tested
// without a browser. "Travel" is in screen pixels, positive meaning up or right on screen.

import type { DeckId, EngineCommand } from "@audio";
import type { ControlId, DeckControlId } from "./control-ids.ts";
import type { WheelDeltas } from "./input-device.ts";

type DeckContinuousPart = "trim" | "eq-high" | "eq-mid" | "eq-low" | "filter" | "channel-fader" | "tempo";

type SharedContinuousPart = "crossfader" | "master-level" | "cue-mix" | "headphone-level" | "beat-fx-depth";

export type ContinuousControlId = `${DeckId}.${DeckContinuousPart}` | SharedContinuousPart;

export interface ContinuousSpec {
  readonly min: number;
  readonly max: number;
  /** Where double-click puts the control. */
  readonly resetValue: number;
  /** Centred knobs catch at the centre when a drag passes close to it (not with fine adjust). */
  readonly centreDetent: boolean;
  /** True when the top of the control is its minimum (the tempo fader: faster is towards you). */
  readonly inverted: boolean;
}

/** A knob drag (and a wheel turn) of this many pixels sweeps the whole range: one trackpad stroke. */
export const FULL_TRAVEL_PX = 240;
/** A fader track shorter than this has not been laid out; its drag falls back to the knob travel. */
const SHORTEST_TRACK_PX = 24;
const FINE_FACTOR = 0.2;
const CENTRE_CATCH_FRACTION = 0.015;
const LINE_PX = 16;
const PAGE_PX = 400;

const CENTRED: ContinuousSpec = { min: -1, max: 1, resetValue: 0, centreDetent: true, inverted: false };

const SPECS: Readonly<Record<DeckContinuousPart | SharedContinuousPart, ContinuousSpec>> = {
  trim: CENTRED,
  "eq-high": CENTRED,
  "eq-mid": CENTRED,
  "eq-low": CENTRED,
  filter: CENTRED,
  "channel-fader": { min: 0, max: 1, resetValue: 1, centreDetent: false, inverted: false },
  tempo: { min: -1, max: 1, resetValue: 0, centreDetent: true, inverted: true },
  crossfader: { min: 0, max: 1, resetValue: 0.5, centreDetent: true, inverted: false },
  "master-level": CENTRED,
  "cue-mix": { min: 0, max: 1, resetValue: 0.5, centreDetent: true, inverted: false },
  "headphone-level": { min: 0, max: 1, resetValue: 0.5, centreDetent: false, inverted: false },
  "beat-fx-depth": { min: 0, max: 1, resetValue: 0.5, centreDetent: false, inverted: false },
};

const SHARED_CONTINUOUS: ReadonlySet<string> = new Set<SharedContinuousPart>(["crossfader", "master-level", "cue-mix", "headphone-level", "beat-fx-depth"]);
const isShared = (part: string): part is SharedContinuousPart => SHARED_CONTINUOUS.has(part);

function splitId(id: ContinuousControlId): { deck: DeckId | null; part: keyof typeof SPECS } {
  const dot = id.indexOf(".");
  if (dot < 0) return { deck: null, part: id as keyof typeof SPECS };
  return { deck: id.slice(0, dot) as DeckId, part: id.slice(dot + 1) as DeckContinuousPart };
}

export function isContinuousControl(id: ControlId): id is ContinuousControlId {
  return splitId(id as ContinuousControlId).part in SPECS;
}

export function continuousSpec(id: ContinuousControlId): ContinuousSpec {
  return SPECS[splitId(id).part];
}

/** The engine command that sets a control to `value`, or null when the engine has no such control. */
export function commandFor(id: ContinuousControlId, value: number): EngineCommand | null {
  const { deck, part } = splitId(id);
  if (deck === null) return isShared(part) ? { control: part, value } : null;
  if (isShared(part)) return null;
  return { control: part, deck, value };
}

function clamp(spec: ContinuousSpec, value: number): number {
  return Math.min(spec.max, Math.max(spec.min, value));
}

function span(spec: ContinuousSpec): number {
  return spec.max - spec.min;
}

/** Moves a value by screen travel, honouring orientation, fine adjust and the centre catch. */
function moveBy(spec: ContinuousSpec, value: number, travelPx: number, fine: boolean, fullTravelPx: number): number {
  const direction = spec.inverted ? -1 : 1;
  const moved = clamp(spec, value + direction * (travelPx / fullTravelPx) * span(spec) * (fine ? FINE_FACTOR : 1));
  if (spec.centreDetent && !fine && Math.abs(moved - spec.resetValue) < CENTRE_CATCH_FRACTION * span(spec)) return spec.resetValue;
  return moved;
}

/**
 * The value during a drag that started at `startValue` and has travelled `travelPx` since, where
 * `fullTravelPx` sweeps the whole range. Drags are relative: grabbing anywhere on a control never makes
 * it jump, which gives a trackpad leeway. A fader passes its track's length (`faderTravelPx`), so its
 * cap moves exactly as far as the pointer and stays under a finger; a knob passes `FULL_TRAVEL_PX`.
 */
export function dragValue(spec: ContinuousSpec, startValue: number, travelPx: number, options: { fine: boolean; fullTravelPx: number }): number {
  return moveBy(spec, startValue, travelPx, options.fine, options.fullTravelPx);
}

/** The drag travel that sweeps a fader end to end: the rendered length of the track its cap runs along. */
export function faderTravelPx(trackLengthPx: number): number {
  return Number.isFinite(trackLengthPx) && trackLengthPx >= SHORTEST_TRACK_PX ? trackLengthPx : FULL_TRAVEL_PX;
}

/**
 * Screen travel of one wheel event. With natural scrolling (macOS default) content follows the fingers,
 * so fingers moving up send a positive deltaY; with a classic wheel, rolling up sends a negative one.
 * Whichever axis moved more wins, with rightwards meaning up.
 */
export function wheelTravelPx(wheel: WheelDeltas, options: { natural: boolean }): number {
  const scale = wheel.deltaMode === 1 ? LINE_PX : wheel.deltaMode === 2 ? PAGE_PX : 1;
  const sign = options.natural ? 1 : -1;
  const vertical = sign * wheel.deltaY * scale;
  const horizontal = -sign * wheel.deltaX * scale;
  return Math.abs(horizontal) > Math.abs(vertical) ? horizontal : vertical;
}

export function wheelValue(spec: ContinuousSpec, value: number, travelPx: number, options: { fine: boolean }): number {
  return moveBy(spec, value, travelPx, options.fine, FULL_TRAVEL_PX);
}

/**
 * The value after a key press on a focused control, or null for a key it does not handle. Arrows move
 * the control the way they point on screen (so ArrowDown speeds up the tempo fader).
 */
export function nudgeValue(spec: ContinuousSpec, value: number, key: string, options: { fine: boolean }): number | null {
  const step = (span(spec) / 50) * (options.fine ? 0.1 : 1);
  const visual = spec.inverted ? -1 : 1;
  switch (key) {
    case "ArrowUp":
    case "ArrowRight":
      return clamp(spec, value + visual * step);
    case "ArrowDown":
    case "ArrowLeft":
      return clamp(spec, value - visual * step);
    case "PageUp":
      return clamp(spec, value + visual * (span(spec) / 10));
    case "PageDown":
      return clamp(spec, value - visual * (span(spec) / 10));
    case "Home":
      return spec.min;
    case "End":
      return spec.max;
    default:
      return null;
  }
}

/** A finger this far to the side of where a tempo-fader drag began is fine adjust (touch has no Shift). */
export const SIDEWAYS_FINE_PX = 48;

export function isTempoFader(id: ContinuousControlId): boolean {
  return splitId(id).part === "tempo";
}

/** The deck a deck control belongs to. */
export function deckOf(id: DeckControlId): DeckId {
  return id.startsWith("A.") ? "A" : "B";
}
