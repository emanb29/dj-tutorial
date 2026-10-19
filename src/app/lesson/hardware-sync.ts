// The screen's controller in step with a connected DDJ-FLX4 (owner, 2026-10-18: "the physical and
// virtual controllers should ALWAYS be in sync"). The FLX4's knobs and faders cannot be moved by the app
// and cannot report where they are until they move (src/midi/positions.ts), so while it is connected a
// set-up never turns a fader or knob, in software, to somewhere the hardware is known not to be:
// - neutral: a value the Lesson does not care about is taken from the hardware (unknown: as planned);
// - deliberate: a value the Lesson sets on purpose is asked for in a "Match your controller" step, each
//   item ticked off live as the hardware gets there; the set-up waits for all of them, or Skip;
// - software: discrete state (Play, CUE 🎧, SYNC, positions, pads, loops) lives only in the app.
// With no controller connected, set-ups apply every value as planned (unchanged).

import type { BeatFxSnapshot } from "@audio";
import { hardwarePositions, midiConnection, type HardwarePositions, type MidiConnection } from "@midi";
import { setUpTrim, type DeckSetup, type DeckSetups, type LessonTrack } from "@lessons";
import type { DeckId } from "@shared/attempt.ts";
import { continuousSpec, type ContinuousControlId } from "../controller/gestures.ts";
import { hardwareAppValue, physicalIdOf } from "../controller/hardware.ts";

export type SetUpClass = "neutral" | "deliberate" | "software";

/**
 * How a set-up applies each DeckSetup field while the controller is connected. `trim` is deliberate
 * when a set-up names it (Lesson 4 (Set the level)'s hot A and quiet B, Placement's quiet B before
 * the cut); a set-up without one uses the Lesson's set-up level, which is neutral (DEFAULT_TRIM).
 */
export const DECK_SETUP_FIELDS = {
  pos: "software",
  play: "software",
  headphoneCue: "software",
  cuePoint: "software",
  sync: "software",
  tempoRange: "software",
  masterTempo: "software",
  hotCues: "software",
  fader: "deliberate",
  trim: "deliberate",
  tempoPercent: "deliberate",
  eqCentred: "deliberate",
  filterCentred: "deliberate",
} as const satisfies Record<keyof DeckSetup, SetUpClass>;

/** The set-up level of TRIM (`setUpTrim`), when a set-up does not name a trim: it only keeps a deck out of the red. */
export const DEFAULT_TRIM = "neutral" as const satisfies SetUpTarget["kind"];

/** The mixer fields of DeckSetups (the decks are DECK_SETUP_FIELDS). */
export const MIXER_SETUP_FIELDS = { crossfader: "deliberate" } as const satisfies Record<Exclude<keyof DeckSetups, "A" | "B" | "beatFx">, SetUpClass>;

/** Beat FX as a set-up names it: only LEVEL/DEPTH is a knob (the CH SELECT lever is not tracked yet). */
export const BEAT_FX_SETUP_FIELDS = { on: "software", channel: "software", beats: "software", depth: "deliberate" } as const satisfies Record<keyof BeatFxSnapshot, SetUpClass>;

/** Fraction of a control's travel the hardware may be off a deliberate value and still match it. */
export const MATCH_TOLERANCE = 0.04;

/** One fader or knob a set-up sets: where to, and how it is applied with the controller connected. */
export interface SetUpTarget {
  readonly control: ContinuousControlId;
  readonly value: number;
  readonly kind: "neutral" | "deliberate";
  /** Where to, for the match step: "all the way down", "centre", "to 2 o'clock". */
  readonly to: string;
}

/** What the set-up needs to know of a deck before it applies: SYNC and the range (the tempo fader's meaning). */
export interface DeckBefore {
  readonly syncOn: boolean;
  readonly tempoRangePercent: number;
}

const DECKS: readonly DeckId[] = ["A", "B"];
const EQS = ["eq-high", "eq-mid", "eq-low"] as const;

/** Every fader and knob the app has, deck ones first. */
export const CONTINUOUS_CONTROLS: readonly ContinuousControlId[] = [
  ...DECKS.flatMap((deck) => (["channel-fader", "trim", ...EQS, "filter", "tempo"] as const).map((part) => `${deck}.${part}` as const)),
  "crossfader",
  "master-level",
  "cue-mix",
  "headphone-level",
  "beat-fx-depth",
];

/** The faders and knobs a set-up sets, in the order a Learner would reach for them. */
export function setUpTargets(decks: DeckSetups, track: LessonTrack, options: { readonly withB: boolean; readonly before: (deck: DeckId) => DeckBefore }): SetUpTarget[] {
  const deckTargets = (deck: DeckId, setup: DeckSetup): SetUpTarget[] => {
    const before = options.before(deck);
    const target = (part: "channel-fader" | "trim" | "eq-high" | "eq-mid" | "eq-low" | "filter" | "tempo", value: number, kind: SetUpTarget["kind"]): SetUpTarget => {
      const control: ContinuousControlId = `${deck}.${part}`;
      return { control, value, kind, to: describeTarget(control, value, setup.tempoRange ?? before.tempoRangePercent) };
    };
    const synced = setup.sync ?? before.syncOn;
    const range = setup.tempoRange ?? before.tempoRangePercent;
    return [
      target("channel-fader", setup.fader, DECK_SETUP_FIELDS.fader),
      setup.trim === undefined ? target("trim", setUpTrim(track), DEFAULT_TRIM) : target("trim", setup.trim, DECK_SETUP_FIELDS.trim),
      ...(setup.tempoPercent !== undefined && !synced ? [target("tempo", Math.max(-1, Math.min(1, setup.tempoPercent / range)), DECK_SETUP_FIELDS.tempoPercent)] : []),
      ...(setup.eqCentred === true ? EQS.map((band) => target(band, 0, DECK_SETUP_FIELDS.eqCentred)) : []),
      ...(setup.filterCentred === true ? [target("filter", 0, DECK_SETUP_FIELDS.filterCentred)] : []),
    ];
  };
  const crossfader = decks.crossfader;
  const depth = decks.beatFx?.depth;
  return [
    ...deckTargets("A", decks.A),
    ...(decks.B !== undefined && options.withB ? deckTargets("B", decks.B) : []),
    ...(crossfader === undefined ? [] : [{ control: "crossfader" as const, value: crossfader, kind: MIXER_SETUP_FIELDS.crossfader, to: describeTarget("crossfader", crossfader, 0) }]),
    ...(depth === undefined ? [] : [{ control: "beat-fx-depth" as const, value: depth, kind: BEAT_FX_SETUP_FIELDS.depth, to: describeTarget("beat-fx-depth", depth, 0) }]),
  ];
}

/** Where the hardware has a fader or knob, as an app value. */
export interface HardwarePlaces {
  /** Null until it has moved in this tab (the FLX4 cannot report positions). */
  position(control: ContinuousControlId): number | null;
}

/** The connected controller, as a set-up sees it. */
export interface HardwareView extends HardwarePlaces {
  readonly connected: boolean;
  /** Any change: connected or not, a fader or knob moved. */
  subscribe(listener: () => void): () => void;
}

function within(control: ContinuousControlId, a: number, b: number): boolean {
  const spec = continuousSpec(control);
  return Math.abs(a - b) <= MATCH_TOLERANCE * (spec.max - spec.min) + 1e-9;
}

/** Whether the hardware is where a target wants it (a neutral target is wherever the hardware is). */
export function targetMatched(target: SetUpTarget, hardware: number | null): boolean {
  if (target.kind === "neutral") return true;
  return hardware !== null && within(target.control, hardware, target.value);
}

/**
 * The value a set-up sends for a target, the controller connected: the hardware's, when it is known
 * and the target takes it (neutral, or a deliberate value it matches); else the planned value (an
 * unknown position, or a deliberate one the Learner skipped).
 */
export function settledValue(target: SetUpTarget, hardware: number | null): number {
  if (hardware === null) return target.value;
  return target.kind === "neutral" || within(target.control, hardware, target.value) ? hardware : target.value;
}

export type MatchState = "matched" | "move" | "unknown";

/** One line of the "Match your controller" step. */
export interface MatchItem {
  readonly key: string;
  /** "TRIM A", "Fader B", "EQs B". */
  readonly label: string;
  readonly to: string;
  readonly state: MatchState;
  /** Which way to move it, while it is known and not there yet. */
  readonly hint: "↑" | "↓" | "←" | "→" | "↻" | "↺" | null;
  readonly controls: readonly ContinuousControlId[];
}

/** An item's line: "TRIM A: up to 2 o'clock ↻", "Fader B: wiggle it". */
export function matchLine(item: MatchItem): string {
  if (item.state === "unknown") return `${item.label}: wiggle it`;
  return item.hint === null ? `${item.label}: ${item.to}` : `${item.label}: ${item.to} ${item.hint}`;
}

/**
 * The match step's items for these targets: every deliberate target not skipped, with the EQs of a
 * deck that all go to centre as one item. Empty when nothing needs moving.
 */
export function matchItems(targets: readonly SetUpTarget[], hardware: HardwarePlaces, skipped: ReadonlySet<ContinuousControlId>): MatchItem[] {
  const asked = targets.filter((target) => target.kind === "deliberate" && !skipped.has(target.control));
  const items: MatchItem[] = [];
  const grouped = new Set<ContinuousControlId>();
  for (const deck of DECKS) {
    const eqs = asked.filter((target) => EQS.some((band) => target.control === `${deck}.${band}`));
    if (eqs.length === EQS.length && eqs.every((target) => target.value === 0)) {
      const states = eqs.map((target) => stateOf(target, hardware.position(target.control)));
      const state: MatchState = states.every((each) => each === "matched") ? "matched" : states.includes("unknown") ? "unknown" : "move";
      items.push({ key: `${deck}.eqs`, label: `EQs ${deck}`, to: "centre", state, hint: null, controls: eqs.map((target) => target.control) });
      for (const target of eqs) grouped.add(target.control);
    }
  }
  const single = asked.filter((target) => !grouped.has(target.control)).map((target): MatchItem => {
    const at = hardware.position(target.control);
    const state = stateOf(target, at);
    return { key: target.control, label: labelOf(target.control), to: target.to, state, hint: state === "move" && at !== null ? hintOf(target.control, at, target.value) : null, controls: [target.control] };
  });
  // In the targets' order, the EQ group where its first band was.
  const order = (item: MatchItem) => asked.findIndex((target) => target.control === item.controls[0]);
  return [...single, ...items].sort((a, b) => order(a) - order(b));
}

function stateOf(target: SetUpTarget, at: number | null): MatchState {
  if (at === null) return "unknown";
  return targetMatched(target, at) ? "matched" : "move";
}

const LABELS: Readonly<Record<string, string>> = {
  "channel-fader": "Fader",
  trim: "TRIM",
  "eq-high": "HI",
  "eq-mid": "MID",
  "eq-low": "LOW",
  filter: "CFX",
  tempo: "Tempo",
  crossfader: "Crossfader",
  "master-level": "MASTER LEVEL",
  "cue-mix": "MIXING",
  "headphone-level": "LEVEL 🎧",
  "beat-fx-depth": "LEVEL/DEPTH",
};

export function labelOf(control: ContinuousControlId): string {
  const [first, part] = control.split(".");
  return part === undefined ? (LABELS[control] ?? control) : `${LABELS[part] ?? part} ${first ?? ""}`;
}

function partOf(control: ContinuousControlId): string {
  return control.split(".").at(-1) ?? control;
}

/** A knob's value as a clock position: fully left is 7 o'clock, the centre 12, fully right 5. */
function clock(fraction: number): string {
  const hour = Math.round(12 + (fraction - 0.5) * 10);
  return `${String(((hour + 11) % 12) + 1)} o'clock`;
}

/** Where to, in a few words. `rangePercent`: the tempo range (tempo only). */
export function describeTarget(control: ContinuousControlId, value: number, rangePercent: number): string {
  const spec = continuousSpec(control);
  const fraction = (value - spec.min) / (spec.max - spec.min);
  switch (partOf(control)) {
    case "channel-fader":
      return fraction <= 0.02 ? "all the way down" : fraction >= 0.98 ? "all the way up" : `to ${String(Math.round(fraction * 100))}%`;
    case "crossfader":
      return fraction <= 0.02 ? "all the way to A" : fraction >= 0.98 ? "all the way to B" : Math.abs(fraction - 0.5) <= 0.02 ? "centre" : `${String(Math.round(fraction * 100))}% to B`;
    case "tempo": {
      const percent = value * rangePercent;
      return Math.abs(percent) < 0.05 ? "centre" : `to ${percent > 0 ? "+" : "−"}${Math.abs(percent).toFixed(1)}%`;
    }
    default:
      return spec.centreDetent && Math.abs(value - spec.resetValue) <= 0.01 * (spec.max - spec.min) ? "centre" : `to ${clock(fraction)}`;
  }
}

/** Which way to move the hardware from `at` to `to`, as the panel lays it out. */
function hintOf(control: ContinuousControlId, at: number, to: number): MatchItem["hint"] {
  const higher = to > at;
  switch (partOf(control)) {
    case "channel-fader":
      return higher ? "↑" : "↓";
    // The tempo fader's "+" is towards you.
    case "tempo":
      return higher ? "↓" : "↑";
    case "crossfader":
      return higher ? "→" : "←";
    default:
      return higher ? "↻" : "↺";
  }
}

/** The DDJ-FLX4 connection and the positions it has seen (by default the app's one of each), as a set-up sees them. */
export function liveHardwareView(
  connection: Pick<MidiConnection, "connected" | "subscribe"> = midiConnection(),
  positions: Pick<HardwarePositions, "get" | "subscribe"> = hardwarePositions(),
): HardwareView {
  return {
    get connected() {
      return connection.connected;
    },
    position: (control) => {
      const known = positions.get(physicalIdOf(control));
      return known === null ? null : hardwareAppValue(control, known.value);
    },
    subscribe: (listener) => {
      const stopPositions = positions.subscribe(listener);
      const stopConnection = connection.subscribe(listener);
      return () => {
        stopPositions();
        stopConnection();
      };
    },
  };
}

/** No controller: what the tests use where none is wanted. */
export const NO_HARDWARE: HardwareView = { connected: false, position: () => null, subscribe: () => () => undefined };
