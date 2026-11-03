// The Render's mixer moves (ISS-190): each Transition's lanes, through its Execution plan, as engine
// commands at set times. Going through the Execution plan's control mapping is what makes a Render
// sound like a perfect live take: a cut on the 1 is the crossfader snapping, an echo out is Beat FX
// ECHO, a blend is the channel faders. Pure.
//
// Deck controls the Execution plan names (PLAY, CUE, TEMPO, loops) are the timeline's job
// (timeline.ts): the Render plays each track's playback, tempo and loops included, from one pass.
//
// Between Transitions:
// - A track's deck is reset when the track loads: TRIM to the plan's level match, EQ and CFX centred,
//   the fader down. Then the Transition's own set-up for that deck applies, at its start.
// - A set-up move a track already heard would hear (the crossfader back to the centre after a cut,
//   say) is made over the bar before the Transition, never sooner than the last Transition's end.
// - Beat FX follows the deck it echoes: its BPM is set from the timeline as it turns on.
import type { EngineCommand } from "@audio/commands.ts";
import type { DeckId } from "@audio/types.ts";
import { ALL_CONTROL_IDS } from "@app/controller/control-ids.ts";
import type { Flx4Control } from "@app/controller/flx4-keys.ts";
import { deriveExecution, type ExecutionStep, type StepSource } from "@app/mix-editor/execution-plan.ts";
import { deckOf } from "@app/mix-plans/deck-layout.ts";
import { trimKnobFor } from "@lessons/track.ts";
import type { Keyframe, MixPlan, Transition } from "@shared/mix-plan.ts";
import { bpmAtBeat, secAtBeat, type SetTimeline, type TransitionTiming } from "./timeline.ts";

/** An engine command at a set time. */
export interface TimedCommand {
  readonly atSec: number;
  readonly command: EngineCommand;
}

/** A ramp is played as a move every this many seconds (about a MIDI fader's message rate). */
export const RAMP_STEP_SEC = 0.005;
/** A set-up move a track already heard would hear takes this long before its Transition. */
export const SET_UP_BEATS = 4;
/** Beat FX's tempo range (engine.ts): an echo on a track outside it follows the nearest end. */
const FX_BPM = { min: 60, max: 300 } as const;

const UNLOCKED = new Set(ALL_CONTROL_IDS);
const FX_CHANNELS: Readonly<Record<number, DeckId>> = { 1: "A", 2: "B" };
const CHANNEL_PARTS = new Set(["channel-fader", "eq-low", "eq-mid", "eq-high", "filter"]);

/** The engine command that puts an Execution plan control at `value`; null for what the timeline plays. */
export function engineCommandFor(control: Flx4Control, value: number | boolean): EngineCommand | null {
  switch (control) {
    case "crossfader":
      return { control: "crossfader", value: Number(value) };
    case "beat-fx-on":
      return { control: "beat-fx", value: Boolean(value) };
    case "beat-fx-depth":
      return { control: "beat-fx-depth", value: Number(value) };
    case "beat-fx-beat":
      return { control: "beat-fx-beats", value: Number(value) };
    case "beat-fx-channel": {
      const channel = FX_CHANNELS[Number(value)];
      if (channel === undefined) throw new Error(`CH SELECT ${String(value)} is not a deck channel: the Execution plan sets 1 or 2.`);
      return { control: "beat-fx-channel", value: channel };
    }
    default: {
      const [deck, part] = control.split(".") as [DeckId, string];
      if (!CHANNEL_PARTS.has(part)) return null;
      return { control: part as "channel-fader", deck, value: Number(value) };
    }
  }
}

/** One key per control the commands move, so the latest value of each can be found. */
export function controlKey(command: EngineCommand): string {
  return "deck" in command ? `${command.deck}.${command.control}` : command.control;
}

const valueOf = (command: EngineCommand): unknown => ("value" in command ? command.value : null);

const ease = (x: number) => x * x * (3 - 2 * x);

function curveOf(transition: Transition, source: StepSource): Keyframe["curve"] {
  if (source === "incoming-start") return "jump";
  return transition.lanes[source.lane]?.keyframes[source.keyframe]?.curve ?? "linear";
}

class CommandList {
  readonly commands: TimedCommand[] = [];
  private readonly state = new Map<string, unknown>();

  emit(atSec: number, command: EngineCommand): void {
    this.commands.push({ atSec, command });
    this.state.set(controlKey(command), valueOf(command));
  }

  current(command: EngineCommand): unknown {
    return this.state.get(controlKey(command));
  }

  /** The deck Beat FX takes in now. */
  fxChannel(): unknown {
    return this.state.get("beat-fx-channel");
  }

  /** `make(value)` from `from` to `to` over a span, a move every RAMP_STEP_SEC, landing exactly on `to` at the end. */
  ramp(fromSec: number, toSec: number, from: number, to: number, shape: (x: number) => number, make: (value: number) => EngineCommand): void {
    const span = toSec - fromSec;
    const steps = Math.max(1, Math.ceil(span / RAMP_STEP_SEC));
    for (let step = 1; step <= steps; step++) {
      const x = step / steps;
      this.emit(fromSec + span * x, make(from + (to - from) * shape(x)));
    }
  }
}

/** A deck's controls as a newly loaded track starts: TRIM at its level match, EQ and CFX centred, the fader down. */
function freshDeck(deck: DeckId, gainDb: number): EngineCommand[] {
  return [
    { control: "trim", deck, value: trimKnobFor(gainDb) },
    { control: "eq-low", deck, value: 0 },
    { control: "eq-mid", deck, value: 0 },
    { control: "eq-high", deck, value: 0 },
    { control: "filter", deck, value: 0 },
    { control: "channel-fader", deck, value: 0 },
  ];
}

function transitionCommands(list: CommandList, plan: MixPlan, index: number, timing: TransitionTiming, previousEndSec: number): void {
  const transition = plan.transitions[index];
  const incomingTrack = plan.tracks[index + 1];
  if (transition === undefined || incomingTrack === undefined) return;
  const decks = { outgoing: deckOf(index), incoming: deckOf(index + 1) } as const;
  const execution = deriveExecution(transition, decks, UNLOCKED);
  const start = timing.startSec;

  // The incoming deck: fresh, then its set-up, as it loads.
  const incomingSetUp = execution.setUp.filter((item) => item.deck === decks.incoming).flatMap((item) => engineCommandFor(item.control, item.value) ?? []);
  for (const command of [...freshDeck(decks.incoming, incomingTrack.gainDb), ...incomingSetUp]) list.emit(start, command);

  // Everything else the set-up names: Beat FX at the start, heard controls over the bar before it.
  const lead = Math.min(start - previousEndSec, (SET_UP_BEATS * 60) / bpmAtBeat(timing, 0, "outgoing"));
  for (const item of execution.setUp.filter((each) => each.deck !== decks.incoming)) {
    const command = engineCommandFor(item.control, item.value);
    if (command === null || list.current(command) === valueOf(command)) continue;
    const from = list.current(command);
    if (command.control.startsWith("beat-fx") || typeof from !== "number" || lead <= 0) list.emit(start, command);
    else list.ramp(start - lead, start, from, Number(item.value), (x) => x, (value) => ({ ...command, value }) as EngineCommand);
  }

  for (const step of execution.steps) stepCommands(list, transition, timing, step, decks);
}

function stepCommands(list: CommandList, transition: Transition, timing: TransitionTiming, step: ExecutionStep, decks: Readonly<Record<"outgoing" | "incoming", DeckId>>): void {
  const sample = engineCommandFor(step.control, step.to);
  if (sample === null) return;
  const startSec = secAtBeat(timing, step.startBeat);
  if (typeof step.to === "boolean" || typeof step.from === "boolean" || step.endBeat <= step.startBeat) {
    if (sample.control === "beat-fx" && sample.value) {
      const track = list.fxChannel() === decks.incoming ? "incoming" : "outgoing";
      const bpm = Math.min(FX_BPM.max, Math.max(FX_BPM.min, bpmAtBeat(timing, step.startBeat, track)));
      list.emit(startSec, { control: "beat-fx-bpm", value: bpm });
    }
    list.emit(startSec, sample);
    return;
  }
  const shape = curveOf(transition, step.source) === "ease" ? ease : (x: number) => x;
  const { from, to } = step;
  list.ramp(startSec, secAtBeat(timing, step.endBeat), from, to, shape, (value) => engineCommandFor(step.control, value) ?? sample);
}

/** Every mixer move of the set, in time order (moves at one time keep the order they are made in). */
export function mixCommands(plan: MixPlan, timeline: SetTimeline): TimedCommand[] {
  const list = new CommandList();
  const first = plan.tracks[0];
  for (const command of [
    ...freshDeck("A", first?.gainDb ?? 0),
    { control: "channel-fader", deck: "A", value: 1 },
    ...freshDeck("B", 0),
    { control: "crossfader", value: 0.5 },
    { control: "beat-fx", value: false },
  ] satisfies EngineCommand[]) {
    list.emit(0, command);
  }
  let previousEndSec = 0;
  for (const timing of timeline.transitions) {
    transitionCommands(list, plan, timing.index, timing, previousEndSec);
    previousEndSec = timing.endSec;
  }
  return list.commands.map((each, order) => ({ each, order })).sort((a, b) => a.each.atSec - b.each.atSec || a.order - b.order).map(({ each }) => each);
}

/** The latest value of every control at `sec` (moves at exactly `sec` included): what a segment starts from. */
export function stateAt(commands: readonly TimedCommand[], sec: number): EngineCommand[] {
  const latest = new Map<string, EngineCommand>();
  for (const { atSec, command } of commands) {
    if (atSec > sec) break;
    latest.delete(controlKey(command));
    latest.set(controlKey(command), command);
  }
  return [...latest.values()];
}
