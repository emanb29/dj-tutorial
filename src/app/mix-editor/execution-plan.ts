// The Execution plan: the FLX4 moves a Transition needs, derived from its lanes. Pure and
// deterministic, never stored, so changing these rules never needs a migration. Design in the Mix
// Editor is never limited by the controller: anything drawn derives, however hard, and the Complexity
// rating says how hard.
//
// Rules (v1, the design doc's "Derived: Execution plan"):
// - Each control starts where its lane starts (lanes.ts `laneTimeline`), in the set-up ("Match your
//   controller").
// - Volume is the channel fader, with the crossfader centred throughout, jumps included: a cut on the
//   1 is the faders snapping. The crossfader's constant-power curve puts a deck at its side 3 dB above
//   the centre, so a crossfader cut would leave the incoming track louder than a fader blend does, and
//   the next Transition (centred again) would drop it. Faders keep every track at one level, the same
//   one the Mix Editor's preview and the Render play.
// - EQ, filter and tempo are their knob or fader on the track's deck, one to one.
// - Echo send is Beat FX ECHO on the deck's channel: BEAT FX ON when the wet leaves or returns to 0,
//   LEVEL/DEPTH while it moves; CH SELECT, BEAT ◀/▶ (`echoBeats`) and the first LEVEL/DEPTH are set up.
// - Loop (1 on, 0 off) is 4 BEAT/EXIT for a 4-beat loop, LOOP IN then LOOP OUT for any other
//   `loopBeats`, and EXIT to end it.
// - The incoming track starts with PLAY on its deck at beat 0 (it is heard from `incomingAt` there),
//   cued in the set-up.
// - A ramp (linear or ease) is one continuous move over its span; a jump is an instant move.
// - A keyframe that only holds the lane's value is realised by whatever brought the lane there.
//
// Values (`from`, `to`, set-up `value`) are the control's position: faders and LEVEL/DEPTH 0…1, the
// crossfader 0 (deck A's side) to 1 (deck B's), EQ and CFX −1…1, TEMPO in BPM (its fader's position
// depends on the track's own BPM and range), CH SELECT 1 or 2, BEAT ◀/▶ in beats, and buttons the
// on/off state they set.

import type { DeckId } from "@audio";
import type { ControllerUnlocks } from "@app/controller/control-ids.ts";
import { deckLayoutId, type Flx4Control, flx4LayoutControl } from "@app/controller/flx4-keys.ts";
import { BEATS_PER_BAR, type Lane, type LaneParam, type Transition } from "@shared/mix-plan.ts";
import { type Complexity, rateComplexity } from "./complexity.ts";
import { assignHands, type UnassignedStep } from "./hands.ts";
import { heard, isJump, type LaneEntry, laneTimeline, type LaneTimeline, type LaneTrack } from "./lanes.ts";

export type Hand = "left" | "right";

/** A keyframe, by its lane's index in the Transition and its own in the lane. */
export interface KeyframeRef {
  readonly lane: number;
  readonly keyframe: number;
}

/** What a step realises: a keyframe, or the incoming track's start. */
export type StepSource = KeyframeRef | "incoming-start";

export interface ExecutionStep {
  readonly control: Flx4Control;
  readonly deck: DeckId | null;
  /** By the layout: deck A's side left, deck B's right, the crossfader to the free hand. */
  readonly hand: Hand;
  /** Beats from the Transition's start; equal for a button or a jump. */
  readonly startBeat: number;
  readonly endBeat: number;
  readonly from: number | boolean;
  readonly to: number | boolean;
  /** How precisely it must land, ± beats (the grading tolerance). */
  readonly windowBeats: number;
  /** The keyframe it realises, for captions and the editor's highlight. */
  readonly source: StepSource;
  /** Other keyframes the same gesture realises: the other track's jump in a crossfader cut, or keyframes that hold the value it reached. */
  readonly alsoRealises: readonly KeyframeRef[];
}

/** Where a control must be before the Transition starts. */
export interface SetUpItem {
  readonly control: Flx4Control;
  readonly deck: DeckId | null;
  readonly value: number | boolean;
  /** The keyframe this position realises; null for a lane's resting value, or one the moves need. */
  readonly source: StepSource | null;
  readonly alsoRealises: readonly KeyframeRef[];
}

export interface ExecutionPlan {
  readonly setUp: readonly SetUpItem[];
  /** In time order. */
  readonly steps: readonly ExecutionStep[];
  readonly complexity: Complexity;
}

/** Which deck each track of the Transition is on. */
export type DeckOf = Readonly<Record<LaneTrack, DeckId>>;

/** A move that lands on the beat it is heard: a cut on the 1, an echo throw. */
export const FINE_WINDOW_BEATS = 1 / 8;
/** A move nobody hears land (the track is silent then), and the start of a ramp. */
export const LOOSE_WINDOW_BEATS = 1 / 2;

const CROSSFADER_CENTRE = 0.5;
const FX_CHANNEL: Readonly<Record<DeckId, number>> = { A: 1, B: 2 };
/** 4 BEAT/EXIT's loop. A lane without `loopBeats` (validation flags it) loops a bar. */
const FOUR_BEAT_LOOP = BEATS_PER_BAR;

const CONTINUOUS_PARTS = {
  volume: "channel-fader",
  "eq-low": "eq-low",
  "eq-mid": "eq-mid",
  "eq-high": "eq-high",
  filter: "filter",
  tempo: "tempo",
} as const satisfies Partial<Record<LaneParam, string>>;

/** A step or set-up item while the plan is built: holds are added to the one that brought their lane there. */
interface Draft {
  readonly alsoRealises: KeyframeRef[];
}
type StepDraft = Omit<UnassignedStep, "alsoRealises"> & Draft;
type SetUpDraft = Omit<SetUpItem, "alsoRealises"> & Draft;

class PlanBuilder {
  readonly setUp: SetUpDraft[] = [];
  readonly steps: StepDraft[] = [];

  constructor(
    readonly transition: Transition,
    readonly deckOf: DeckOf,
  ) {}

  addSetUp(control: Flx4Control, value: number | boolean, source: StepSource | null, alsoRealises: KeyframeRef[] = []): SetUpDraft {
    const draft: SetUpDraft = { control, deck: flx4LayoutControl(control).deck, value, source, alsoRealises };
    this.setUp.push(draft);
    return draft;
  }

  addStep(control: Flx4Control, [startBeat, endBeat]: readonly [number, number], [from, to]: readonly [number | boolean, number | boolean], windowBeats: number, source: StepSource): StepDraft {
    const draft: StepDraft = { control, deck: flx4LayoutControl(control).deck, startBeat, endBeat, from, to, windowBeats, source, alsoRealises: [] };
    this.steps.push(draft);
    return draft;
  }

  /** A button or jump on a track: fine-timed when the track is heard then, loose when it is silent. */
  instantWindow(track: LaneTrack, beat: number): number {
    return heard(this.transition, track, beat) ? FINE_WINDOW_BEATS : LOOSE_WINDOW_BEATS;
  }
}

/** A lane's start as an entry (index -1: no keyframe of its own), then its moves. */
const sequenceOf = (timeline: LaneTimeline): LaneEntry[] => [{ index: -1, keyframe: timeline.keyframes[0] ?? { beat: 0, value: timeline.startValue, curve: "jump" } }, ...timeline.moves];

/** Each item with the one before it (none for the first) and its position. */
const withPrevious = <Item>(items: readonly Item[]) => items.map((current, position) => ({ current, previous: items[position - 1], position }));

/** The refs a lane's starting position realises: the first as the source, the rest alongside. */
function absorbedRefs(laneIndex: number, timeline: LaneTimeline): { source: KeyframeRef | null; alsoRealises: KeyframeRef[] } {
  const [first, ...rest] = timeline.absorbed.map((keyframe) => ({ lane: laneIndex, keyframe }));
  return { source: first ?? null, alsoRealises: rest };
}

interface LaneContext {
  readonly builder: PlanBuilder;
  readonly laneIndex: number;
  readonly lane: Lane;
  readonly deck: DeckId;
  readonly timeline: LaneTimeline;
}

/** Volume, EQ, filter and tempo: one knob or fader, set up where the lane starts, then moved to each keyframe. */
function continuousLane(context: LaneContext, part: (typeof CONTINUOUS_PARTS)[keyof typeof CONTINUOUS_PARTS]): void {
  const { builder, laneIndex, lane, deck, timeline } = context;
  const control = deckLayoutId(deck, part);
  const { source, alsoRealises } = absorbedRefs(laneIndex, timeline);
  let realiser: Draft = builder.addSetUp(control, timeline.startValue, source, alsoRealises);
  for (const { current, previous } of withPrevious(sequenceOf(timeline))) {
    if (previous === undefined) continue;
    const { index, keyframe } = current;
    const ref = { lane: laneIndex, keyframe: index };
    if (keyframe.value === previous.keyframe.value) realiser.alsoRealises.push(ref);
    else if (isJump(previous.keyframe, keyframe)) {
      const window = lane.param === "volume" ? FINE_WINDOW_BEATS : builder.instantWindow(lane.track, keyframe.beat);
      realiser = builder.addStep(control, [keyframe.beat, keyframe.beat], [previous.keyframe.value, keyframe.value], window, ref);
    } else {
      realiser = builder.addStep(control, [previous.keyframe.beat, keyframe.beat], [previous.keyframe.value, keyframe.value], LOOSE_WINDOW_BEATS, ref);
    }
  }
}

/** Echo send: Beat FX ECHO, its state tracked so the lane's wet is always ON × LEVEL/DEPTH. */
function echoLane(context: LaneContext): void {
  const { builder, laneIndex, lane, deck, timeline } = context;
  const sequence = withPrevious(sequenceOf(timeline));
  // LEVEL/DEPTH is set up where the first engagement needs it: at its value for a jump, at 0 for a fade in.
  const engagement = sequence.find(({ current, previous }) => previous !== undefined && current.keyframe.value > 0 && previous.keyframe.value === 0);
  let realiser: Draft = builder.addSetUp("beat-fx-on", false, null);
  if (engagement?.previous === undefined) {
    for (const { index } of timeline.moves) realiser.alsoRealises.push({ lane: laneIndex, keyframe: index });
    return;
  }
  let depth = isJump(engagement.previous.keyframe, engagement.current.keyframe) ? engagement.current.keyframe.value : 0;
  builder.addSetUp("beat-fx-channel", FX_CHANNEL[deck], null);
  builder.addSetUp("beat-fx-beat", lane.echoBeats ?? 1, null);
  builder.addSetUp("beat-fx-depth", depth, null);
  let on = false;

  for (const { current, previous: before } of sequence) {
    if (before === undefined) continue;
    const { index, keyframe } = current;
    const previous = before.keyframe;
    const source = { lane: laneIndex, keyframe: index };
    if (keyframe.value === previous.value) {
      realiser.alsoRealises.push(source);
      continue;
    }
    const press = (beat: number, to: boolean) => builder.addStep("beat-fx-on", [beat, beat], [!to, to], builder.instantWindow(lane.track, beat), source);
    const turn = (span: readonly [number, number], from: number, to: number, window: number) => builder.addStep("beat-fx-depth", span, [from, to], window, source);
    if (isJump(previous, keyframe)) {
      const beat = keyframe.beat;
      if (keyframe.value === 0) {
        realiser = press(beat, false);
        on = false;
        continue;
      }
      if (depth !== keyframe.value) realiser = turn([beat, beat], depth, keyframe.value, builder.instantWindow(lane.track, beat));
      depth = keyframe.value;
      if (!on) {
        realiser = press(beat, true);
        on = true;
      }
      continue;
    }
    if (!on) {
      if (depth !== 0) turn([previous.beat, previous.beat], depth, 0, LOOSE_WINDOW_BEATS);
      press(previous.beat, true);
      on = true;
      depth = 0;
    }
    realiser = turn([previous.beat, keyframe.beat], depth, keyframe.value, LOOSE_WINDOW_BEATS);
    depth = keyframe.value;
  }
}

/** Loop: no set-up can hold a loop (it starts where it is pressed), so it starts off and is pressed where it turns on. */
function loopLane(context: LaneContext): void {
  const { builder, laneIndex, lane, deck, timeline } = context;
  const length = lane.loopBeats ?? FOUR_BEAT_LOOP;
  const startLoop = (beat: number, source: KeyframeRef): StepDraft => {
    if (length === FOUR_BEAT_LOOP) return builder.addStep(deckLayoutId(deck, "loop-exit"), [beat, beat], [false, true], builder.instantWindow(lane.track, beat), source);
    builder.addStep(deckLayoutId(deck, "loop-in"), [beat, beat], [false, true], builder.instantWindow(lane.track, beat), source);
    return builder.addStep(deckLayoutId(deck, "loop-out"), [beat + length, beat + length], [false, true], builder.instantWindow(lane.track, beat + length), source);
  };
  let realiser: Draft = builder.addSetUp(deckLayoutId(deck, "loop-exit"), false, null);
  for (const { current, previous } of withPrevious(sequenceOf(timeline))) {
    if (previous === undefined) continue;
    const { index, keyframe } = current;
    const ref = { lane: laneIndex, keyframe: index };
    const [wasOn, isOn] = [previous.keyframe.value > 0, keyframe.value > 0];
    if (wasOn === isOn) {
      realiser.alsoRealises.push(ref);
      continue;
    }
    // Loops do not ramp: every change lands on its keyframe's beat.
    realiser = isOn ? startLoop(keyframe.beat, ref) : builder.addStep(deckLayoutId(deck, "loop-exit"), [keyframe.beat, keyframe.beat], [true, false], builder.instantWindow(lane.track, keyframe.beat), ref);
  }
}

/** Steps in time order: at one beat, PLAY first, then by lane and keyframe, as the strip lists them. */
function inTimeOrder(steps: readonly StepDraft[]): StepDraft[] {
  const rank = ({ source }: StepDraft): KeyframeRef => (source === "incoming-start" ? { lane: -1, keyframe: -1 } : source);
  return steps
    .map((step, order) => ({ step, order, rank: rank(step) }))
    .sort((a, b) => a.step.startBeat - b.step.startBeat || a.rank.lane - b.rank.lane || a.rank.keyframe - b.rank.keyframe || a.order - b.order)
    .map(({ step }) => step);
}

/**
 * The FLX4 moves that perform `transition`, with the tracks on `deckOf`'s decks, rated for a Learner
 * who has `unlocked` these controls.
 */
export function deriveExecution(transition: Transition, deckOf: DeckOf, unlocked: ControllerUnlocks): ExecutionPlan {
  if (deckOf.outgoing === deckOf.incoming) throw new Error(`Both tracks are on deck ${deckOf.outgoing}: a Transition needs the outgoing and incoming tracks on different decks.`);
  const builder = new PlanBuilder(transition, deckOf);
  builder.addSetUp(deckLayoutId(deckOf.incoming, "cue"), true, "incoming-start");
  builder.addStep(deckLayoutId(deckOf.incoming, "play"), [0, 0], [false, true], builder.instantWindow("incoming", 0), "incoming-start");

  builder.addSetUp("crossfader", CROSSFADER_CENTRE, null);

  transition.lanes.forEach((lane, laneIndex) => {
    const timeline = laneTimeline(lane);
    if (timeline === null) return;
    const context: LaneContext = { builder, laneIndex, lane, deck: deckOf[lane.track], timeline };
    if (lane.param === "echo-send") echoLane(context);
    else if (lane.param === "loop") loopLane(context);
    else continuousLane(context, CONTINUOUS_PARTS[lane.param]);
  });

  const steps = assignHands(inTimeOrder(builder.steps));
  return { setUp: builder.setUp, steps, complexity: rateComplexity(steps, transition, unlocked) };
}
