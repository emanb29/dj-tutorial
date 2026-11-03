import { describe, expect, it } from "vitest";
import { ALL_CONTROL_IDS, type ControlId } from "@app/controller/control-ids.ts";
import { type Flx4Control, flx4LayoutControl } from "@app/controller/flx4-keys.ts";
import { seededRandom } from "@app/lesson/track-rotation.ts";
import { type Keyframe, type Lane, type LaneParam, RECIPE_IDS, type RecipeId, type Transition } from "@shared/mix-plan.ts";
import { transitionFromRecipe } from "@shared/mix-plan-recipes.ts";
import { type ComplexityReason } from "./complexity.ts";
import { deriveExecution, type ExecutionStep, type KeyframeRef, type SetUpItem, type StepSource } from "./execution-plan.ts";

// Every golden Transition starts on bar 17 (a phrase start) of the outgoing track on deck A, with the
// incoming track on deck B from its bar 1. The recipes are shared/mix-plan-recipes.ts's.
const DECKS = { outgoing: "A", incoming: "B" } as const;
const EVERYTHING: ReadonlySet<ControlId> = new Set(ALL_CONTROL_IDS);
const PLACE = { outgoingAt: { bar: 17, beat: 1 }, incomingAt: { bar: 1, beat: 1 }, tempos: { outgoing: 124, incoming: 128 } } as const;

const recipe = (id: RecipeId) => transitionFromRecipe(id, PLACE);
const custom = (lengthBeats: number, lanes: Lane[]): Transition => ({ recipe: "custom", outgoingAt: PLACE.outgoingAt, incomingAt: PLACE.incomingAt, lengthBeats, lanes });
const kf = (beat: number, value: number, curve: Keyframe["curve"] = "linear"): Keyframe => ({ beat, value, curve });
const lane = (track: Lane["track"], param: LaneParam, keyframes: Keyframe[], extra: Pick<Lane, "echoBeats" | "loopBeats"> = {}): Lane => ({ track, param, keyframes, ...extra });

const ref = (laneIndex: number, keyframe: number): KeyframeRef => ({ lane: laneIndex, keyframe });
const deckOf = (control: Flx4Control) => flx4LayoutControl(control).deck;

/** A step, golden-style: control, hand, beats, from → to, window, the keyframe it realises (and any others). */
function step(
  control: Flx4Control,
  hand: "left" | "right",
  [startBeat, endBeat]: readonly [number, number],
  [from, to]: readonly [number | boolean, number | boolean],
  windowBeats: number,
  source: StepSource,
  alsoRealises: KeyframeRef[] = [],
): ExecutionStep {
  return { control, deck: deckOf(control), hand, startBeat, endBeat, from, to, windowBeats, source, alsoRealises };
}

function setUp(control: Flx4Control, value: number | boolean, source: StepSource | null, alsoRealises: KeyframeRef[] = []): SetUpItem {
  return { control, deck: deckOf(control), value, source, alsoRealises };
}

const reason = (factor: ComplexityReason["factor"], beat: number, lanes: number[], points: number): ComplexityReason => ({ factor, beat, lanes, points });

const FINE = 1 / 8;
const LOOSE = 1 / 2;
const CUED = setUp("B.cue", true, "incoming-start");
const CENTRED = setUp("crossfader", 0.5, null);
const PLAY_B_UNHEARD = step("B.play", "right", [0, 0], [false, true], LOOSE, "incoming-start");

describe("golden Execution plans and ratings, one per recipe", () => {
  it("a plain 16-bar volume blend (crossfade-16): fader B up over a phrase, then fader A down; rated 1", () => {
    const plan = deriveExecution(recipe("crossfade-16"), DECKS, EVERYTHING);
    expect(plan.setUp).toEqual([CUED, CENTRED, setUp("B.channel-fader", 0, ref(0, 0)), setUp("A.channel-fader", 1, null, [ref(1, 0)])]);
    expect(plan.steps).toEqual([
      PLAY_B_UNHEARD,
      step("B.channel-fader", "right", [0, 32], [0, 1], LOOSE, ref(0, 1)),
      step("A.channel-fader", "left", [32, 64], [1, 0], LOOSE, ref(1, 1)),
    ]);
    expect(plan.complexity).toEqual({ rating: 1, score: 0, weightsVersion: 1, reasons: [] });
  });

  it("a bass swap: both LOW knobs turn on the second phrase's 1, one hand each; rated 2", () => {
    const plan = deriveExecution(recipe("bass-swap"), DECKS, EVERYTHING);
    expect(plan.setUp).toEqual([
      CUED,
      CENTRED,
      setUp("B.channel-fader", 0, ref(0, 0)),
      setUp("B.eq-low", -1, ref(1, 0)),
      setUp("A.eq-low", 0, null),
      setUp("A.channel-fader", 1, null, [ref(3, 0)]),
    ]);
    expect(plan.steps).toEqual([
      PLAY_B_UNHEARD,
      step("B.channel-fader", "right", [0, 32], [0, 1], LOOSE, ref(0, 1)),
      step("B.eq-low", "right", [32, 32], [-1, 0], FINE, ref(1, 1)),
      step("A.eq-low", "left", [32, 32], [0, -1], FINE, ref(2, 0)),
      step("A.channel-fader", "left", [32, 64], [1, 0], LOOSE, ref(3, 1)),
    ]);
    expect(plan.complexity).toEqual({
      rating: 2,
      score: 3,
      weightsVersion: 1,
      reasons: [reason("dense-bar", 32, [1, 2, 3], 1), reason("fine-timing", 32, [1], 1), reason("fine-timing", 32, [2], 1)],
    });
  });

  it("a cut on the 1: PLAY B and fader A snapping down on the phrase's 1, fader B already up; rated 2", () => {
    const plan = deriveExecution(recipe("cut-on-the-1"), DECKS, EVERYTHING);
    expect(plan.setUp).toEqual([CUED, CENTRED, setUp("A.channel-fader", 1, null), setUp("B.channel-fader", 1, ref(1, 0))]);
    expect(plan.steps).toEqual([
      step("B.play", "right", [0, 0], [false, true], FINE, "incoming-start"),
      step("A.channel-fader", "left", [0, 0], [1, 0], FINE, ref(0, 0)),
    ]);
    expect(plan.complexity).toEqual({ rating: 2, score: 2, weightsVersion: 1, reasons: [reason("fine-timing", 0, [], 1), reason("fine-timing", 0, [0], 1)] });
  });

  it("a cut on the 1 after a phrase with B unheard: both faders snap on the 1, the crossfader centred", () => {
    const plan = deriveExecution(
      custom(32, [lane("outgoing", "volume", [kf(32, 0, "jump")]), lane("incoming", "volume", [kf(0, 0, "jump"), kf(32, 1, "jump")])]),
      DECKS,
      EVERYTHING,
    );
    // Not a crossfader cut: at its side the crossfader leaves a deck 3 dB above a centred blend.
    expect(plan.setUp).toEqual([CUED, CENTRED, setUp("A.channel-fader", 1, null), setUp("B.channel-fader", 0, ref(1, 0))]);
    expect(plan.steps).toEqual([PLAY_B_UNHEARD, step("A.channel-fader", "left", [32, 32], [1, 0], FINE, ref(0, 0)), step("B.channel-fader", "right", [32, 32], [0, 1], FINE, ref(1, 1))]);
    expect(plan.complexity).toEqual({ rating: 2, score: 2, weightsVersion: 1, reasons: [reason("fine-timing", 32, [0], 1), reason("fine-timing", 32, [1], 1)] });
  });

  it("a filter sweep: CFX A and fader B together over a phrase, then fader A and LOW B on the next 1; rated 2", () => {
    const plan = deriveExecution(recipe("filter-sweep"), DECKS, EVERYTHING);
    expect(plan.setUp).toEqual([
      CUED,
      CENTRED,
      setUp("A.filter", 0, null, [ref(0, 0)]),
      setUp("A.channel-fader", 1, null),
      setUp("B.channel-fader", 0, ref(2, 0)),
      setUp("B.eq-low", -1, ref(3, 0)),
    ]);
    expect(plan.steps).toEqual([
      PLAY_B_UNHEARD,
      step("A.filter", "left", [0, 32], [0, 1], LOOSE, ref(0, 1)),
      step("B.channel-fader", "right", [0, 32], [0, 1], LOOSE, ref(2, 1)),
      step("A.channel-fader", "left", [32, 32], [1, 0], FINE, ref(1, 0)),
      step("B.eq-low", "right", [32, 32], [-1, 0], FINE, ref(3, 1)),
    ]);
    expect(plan.complexity).toEqual({
      rating: 2,
      score: 3,
      weightsVersion: 1,
      reasons: [reason("dense-bar", 0, [0, 2], 1), reason("fine-timing", 32, [1], 1), reason("fine-timing", 32, [3], 1)],
    });
  });

  it("an echo out: BEAT FX ON on the 1, fader A cut a bar later, then echo off and fader B up; rated 2", () => {
    const plan = deriveExecution(recipe("echo-out"), DECKS, EVERYTHING);
    expect(plan.setUp).toEqual([
      CUED,
      CENTRED,
      setUp("beat-fx-on", false, null),
      setUp("beat-fx-channel", 1, null),
      setUp("beat-fx-beat", 1, null),
      setUp("beat-fx-depth", 1, null),
      setUp("A.channel-fader", 1, null),
      setUp("B.channel-fader", 0, null),
    ]);
    expect(plan.steps).toEqual([
      PLAY_B_UNHEARD,
      // PLAY B has the right hand on the 1, so the left one reaches across for BEAT FX ON.
      step("beat-fx-on", "left", [0, 0], [false, true], FINE, ref(0, 0)),
      step("A.channel-fader", "left", [4, 4], [1, 0], FINE, ref(1, 0)),
      step("beat-fx-on", "right", [8, 8], [true, false], LOOSE, ref(0, 1)),
      step("B.channel-fader", "left", [8, 8], [0, 1], FINE, ref(2, 0)),
    ]);
    expect(plan.complexity).toEqual({
      rating: 2,
      score: 3,
      weightsVersion: 1,
      reasons: [reason("fine-timing", 0, [0], 1), reason("fine-timing", 4, [1], 1), reason("fine-timing", 8, [2], 1)],
    });
  });

  it("a loop to extend: 4 BEAT on the 1, the faders trade, EXIT once A is silent; rated 2", () => {
    const plan = deriveExecution(recipe("loop-to-extend"), DECKS, EVERYTHING);
    expect(plan.setUp).toEqual([CUED, CENTRED, setUp("A.loop-exit", false, null), setUp("B.channel-fader", 0, ref(1, 0)), setUp("A.channel-fader", 1, null, [ref(2, 0)])]);
    expect(plan.steps).toEqual([
      PLAY_B_UNHEARD,
      step("A.loop-exit", "left", [0, 0], [false, true], FINE, ref(0, 0)),
      step("B.channel-fader", "right", [0, 16], [0, 1], LOOSE, ref(1, 1)),
      step("A.channel-fader", "left", [16, 32], [1, 0], LOOSE, ref(2, 1)),
      step("A.loop-exit", "left", [32, 32], [true, false], LOOSE, ref(0, 1)),
    ]);
    expect(plan.complexity).toEqual({ rating: 2, score: 2, weightsVersion: 1, reasons: [reason("dense-bar", 0, [0, 1], 1), reason("fine-timing", 0, [0], 1)] });
  });

  it("a tempo ride: the blend at A's tempo, then TEMPO B back to its own once A is gone; rated 1", () => {
    const plan = deriveExecution(recipe("tempo-ride"), DECKS, EVERYTHING);
    expect(plan.setUp).toEqual([
      CUED,
      CENTRED,
      setUp("B.tempo", 124, ref(0, 0), [ref(0, 1)]),
      setUp("B.channel-fader", 0, ref(1, 0)),
      setUp("A.channel-fader", 1, null, [ref(2, 0)]),
    ]);
    expect(plan.steps).toEqual([
      PLAY_B_UNHEARD,
      step("B.channel-fader", "right", [0, 32], [0, 1], LOOSE, ref(1, 1)),
      step("A.channel-fader", "left", [32, 64], [1, 0], LOOSE, ref(2, 1)),
      step("B.tempo", "right", [64, 96], [124, 128], LOOSE, ref(0, 2)),
    ]);
    expect(plan.complexity.rating).toBe(1);
  });

  it("an echo out with a filter sweep together: three moves at once on bar 8; rated 4", () => {
    const plan = deriveExecution(
      custom(32, [
        lane("outgoing", "filter", [kf(0, 0), kf(32, 1)]),
        lane("incoming", "volume", [kf(0, 0), kf(32, 1)]),
        lane("outgoing", "echo-send", [kf(0, 0), kf(28, 0.5, "jump")], { echoBeats: 1 }),
        lane("outgoing", "volume", [kf(0, 1), kf(32, 0, "jump")]),
      ]),
      DECKS,
      EVERYTHING,
    );
    expect(plan.steps).toEqual([
      PLAY_B_UNHEARD,
      step("A.filter", "left", [0, 32], [0, 1], LOOSE, ref(0, 1)),
      step("B.channel-fader", "right", [0, 32], [0, 1], LOOSE, ref(1, 1)),
      // Both hands are on a ramp, so BEAT FX ON stays with the right one: two moves on one hand.
      step("beat-fx-on", "right", [28, 28], [false, true], FINE, ref(2, 1)),
      step("A.channel-fader", "left", [32, 32], [1, 0], FINE, ref(3, 1)),
    ]);
    expect(plan.complexity).toEqual({
      rating: 4,
      score: 9,
      weightsVersion: 1,
      reasons: [
        reason("dense-bar", 0, [0, 1], 1),
        reason("three-hands", 28, [0, 1, 2], 4),
        reason("one-hand-two-moves", 28, [1, 2], 2),
        reason("fine-timing", 28, [2], 1),
        reason("fine-timing", 32, [3], 1),
      ],
    });
  });

  it("three lanes moving at once with a tempo ride: both faders and TEMPO B over one phrase; rated 5", () => {
    const plan = deriveExecution(
      custom(32, [
        lane("outgoing", "volume", [kf(0, 1), kf(32, 0)]),
        lane("incoming", "volume", [kf(0, 0), kf(32, 1)]),
        lane("incoming", "tempo", [kf(0, 124), kf(32, 128)]),
      ]),
      DECKS,
      EVERYTHING,
    );
    expect(plan.steps).toEqual([
      PLAY_B_UNHEARD,
      step("A.channel-fader", "left", [0, 32], [1, 0], LOOSE, ref(0, 1)),
      step("B.channel-fader", "right", [0, 32], [0, 1], LOOSE, ref(1, 1)),
      step("B.tempo", "right", [0, 32], [124, 128], LOOSE, ref(2, 1)),
    ]);
    expect(plan.complexity).toEqual({
      rating: 5,
      score: 11,
      weightsVersion: 1,
      reasons: [
        reason("three-hands", 0, [0, 1, 2], 4),
        reason("one-hand-two-moves", 0, [1, 2], 2),
        reason("tempo-ride", 0, [0, 1, 2], 4),
        reason("dense-bar", 0, [0, 1, 2], 1),
      ],
    });
  });
});

describe("locked controls", () => {
  it("a control whose Lesson isn't Passed raises the rating, for that Learner only", () => {
    const blend = recipe("crossfade-16");
    const withoutFaderB = new Set(ALL_CONTROL_IDS.filter((id) => id !== "B.channel-fader"));
    const plan = deriveExecution(blend, DECKS, withoutFaderB);
    expect(plan.complexity).toEqual({ rating: 2, score: 2, weightsVersion: 1, reasons: [reason("not-unlocked", 0, [0], 2)] });
    // The step is still there, and the plan is otherwise the same.
    expect(plan.steps).toEqual(deriveExecution(blend, DECKS, EVERYTHING).steps);
  });
});

describe("hands", () => {
  it("follow the layout: deck A's controls to the left hand, deck B's to the right, whichever decks the tracks are on", () => {
    const plan = deriveExecution(recipe("bass-swap"), { outgoing: "B", incoming: "A" }, EVERYTHING);
    expect(plan.steps.map(({ control, hand }) => `${control} ${hand}`)).toEqual([
      "A.play left",
      "A.channel-fader left",
      "A.eq-low left",
      "B.eq-low right",
      "B.channel-fader right",
    ]);
  });

  it("a deck control crosses to the other hand when its own is busy and the other is free, and a crossing within a beat counts", () => {
    const plan = deriveExecution(
      custom(32, [
        lane("incoming", "volume", [kf(0, 0), kf(16, 1)]),
        lane("outgoing", "eq-low", [kf(0, 0), kf(7.5, -1, "jump")]),
        lane("incoming", "eq-high", [kf(0, 0), kf(8, -1, "jump")]),
      ]),
      DECKS,
      EVERYTHING,
    );
    expect(plan.steps.map(({ control, hand }) => `${control} ${hand}`)).toEqual(["B.play right", "B.channel-fader right", "A.eq-low left", "B.eq-high left"]);
    expect(plan.complexity.reasons).toContainEqual(reason("hand-jump", 8, [1, 2], 1));
  });

  it("keeps the crossfader centred in every recipe, so every track plays at the level a fader blend gives it", () => {
    for (const id of RECIPE_IDS) {
      const plan = deriveExecution(recipe(id), DECKS, EVERYTHING);
      expect(plan.setUp.filter(({ control }) => control === "crossfader")).toEqual([CENTRED]);
      expect(plan.steps.filter(({ control }) => control === "crossfader")).toEqual([]);
    }
  });

  it("more than two moves at once are all still emitted, and only rated", () => {
    const plan = deriveExecution(
      custom(16, [
        lane("outgoing", "eq-low", [kf(8, -1, "jump")]),
        lane("outgoing", "eq-mid", [kf(8, -1, "jump")]),
        lane("incoming", "eq-low", [kf(0, -1), kf(8, 0, "jump")]),
        lane("incoming", "eq-mid", [kf(0, -1), kf(8, 0, "jump")]),
      ]),
      DECKS,
      EVERYTHING,
    );
    const atEight = plan.steps.filter(({ startBeat }) => startBeat === 8);
    expect(atEight.map(({ control, hand }) => `${control} ${hand}`)).toEqual(["A.eq-low left", "A.eq-mid left", "B.eq-low right", "B.eq-mid right"]);
    expect(plan.complexity.reasons.filter(({ factor }) => factor === "three-hands")).toEqual([reason("three-hands", 8, [0, 1, 2, 3], 4)]);
    expect(plan.complexity.reasons.filter(({ factor }) => factor === "one-hand-two-moves")).toEqual([
      reason("one-hand-two-moves", 8, [0, 1], 2),
      reason("one-hand-two-moves", 8, [2, 3], 2),
    ]);
  });

  it("a button right where a ramp starts or ends on the same hand is not two moves at once", () => {
    expect(deriveExecution(recipe("crossfade-16"), DECKS, EVERYTHING).complexity.reasons).toEqual([]);
  });
});

describe("where controls start", () => {
  it("an incoming keyframe on the 1 is set up, but an outgoing one is a move on the 1", () => {
    const plan = deriveExecution(custom(16, [lane("incoming", "eq-high", [kf(0, -1, "jump")]), lane("outgoing", "eq-high", [kf(0, -1, "jump")])]), DECKS, EVERYTHING);
    expect(plan.setUp).toContainEqual(setUp("B.eq-high", -1, ref(0, 0)));
    expect(plan.setUp).toContainEqual(setUp("A.eq-high", 0, null));
    expect(plan.steps).toContainEqual(step("A.eq-high", "left", [0, 0], [0, -1], FINE, ref(1, 0)));
  });

  it("a first keyframe that ramps ramps from the resting value at beat 0", () => {
    const plan = deriveExecution(custom(16, [lane("outgoing", "filter", [kf(16, 1)])]), DECKS, EVERYTHING);
    expect(plan.steps).toContainEqual(step("A.filter", "left", [0, 16], [0, 1], LOOSE, ref(0, 0)));
  });
});

describe("splitting and merging gestures", () => {
  it("an echo that fades in is BEAT FX ON plus LEVEL/DEPTH from 0", () => {
    const plan = deriveExecution(custom(16, [lane("outgoing", "echo-send", [kf(8, 0, "jump"), kf(16, 0.6)], { echoBeats: 0.5 })]), DECKS, EVERYTHING);
    expect(plan.setUp).toContainEqual(setUp("beat-fx-depth", 0, null));
    expect(plan.setUp).toContainEqual(setUp("beat-fx-beat", 0.5, null));
    expect(plan.steps.slice(1)).toEqual([
      step("beat-fx-on", "right", [8, 8], [false, true], FINE, ref(0, 1)),
      step("beat-fx-depth", "right", [8, 16], [0, 0.6], LOOSE, ref(0, 1)),
    ]);
  });

  it("a loop other than 4 beats is LOOP IN, then LOOP OUT where it ends", () => {
    const plan = deriveExecution(custom(16, [lane("outgoing", "loop", [kf(8, 1, "jump"), kf(16, 0, "jump")], { loopBeats: 2 })]), DECKS, EVERYTHING);
    expect(plan.setUp).toContainEqual(setUp("A.loop-exit", false, null));
    expect(plan.steps.slice(1)).toEqual([
      step("A.loop-in", "left", [8, 8], [false, true], FINE, ref(0, 0)),
      step("A.loop-out", "left", [10, 10], [false, true], FINE, ref(0, 0)),
      step("A.loop-exit", "left", [16, 16], [true, false], FINE, ref(0, 1)),
    ]);
  });

  it("a volume jump off the phrase, or with the other track not full, stays on the faders", () => {
    const offPhrase = deriveExecution(custom(32, [lane("outgoing", "volume", [kf(30, 0, "jump")]), lane("incoming", "volume", [kf(30, 1, "jump")])]), DECKS, EVERYTHING);
    expect(offPhrase.steps.map(({ control }) => control)).toEqual(["B.play", "A.channel-fader", "B.channel-fader"]);
    const notFull = deriveExecution(custom(32, [lane("outgoing", "volume", [kf(32, 0, "jump")]), lane("incoming", "volume", [kf(32, 0.5, "jump")])]), DECKS, EVERYTHING);
    expect(notFull.steps.map(({ control }) => control)).toEqual(["B.play", "A.channel-fader", "B.channel-fader"]);
  });

  it("PLAY is loose when the incoming track starts unheard, fine-timed when it is heard from its first beat", () => {
    expect(deriveExecution(custom(32, []), DECKS, EVERYTHING).steps).toEqual([PLAY_B_UNHEARD]);
    expect(deriveExecution(custom(32, [lane("incoming", "volume", [kf(0, 1)])]), DECKS, EVERYTHING).steps).toEqual([
      step("B.play", "right", [0, 0], [false, true], FINE, "incoming-start"),
    ]);
  });
});

// A random but valid Transition: one to five lanes, each with up to six keyframes in its range.
function randomTransition(random: () => number): Transition {
  const pick = <Item>(items: readonly Item[]): Item => items[Math.floor(random() * items.length)] as Item;
  const params: readonly LaneParam[] = ["volume", "eq-low", "eq-mid", "eq-high", "filter", "tempo", "echo-send", "loop"];
  const value = (param: LaneParam): number => {
    if (param === "volume" || param === "echo-send") return pick([0, 0, 0.5, 1, 1, random()]);
    if (param === "tempo") return pick([124, 126, 128]);
    if (param === "loop") return pick([0, 1]);
    return pick([-1, 0, 0, 1, random() * 2 - 1]);
  };
  const lengthBeats = pick([8, 16, 32, 64]);
  const lanes = Array.from({ length: 1 + Math.floor(random() * 5) }, (): Lane => {
    const param = pick(params);
    const beats = Array.from({ length: Math.floor(random() * 7) }, () => Math.round(random() * lengthBeats * 2) / 2).sort((a, b) => a - b);
    const keyframes = beats.map((beat) => kf(beat, value(param), pick(["jump", "linear", "ease"] as const)));
    const extra = param === "echo-send" ? { echoBeats: pick([0.5, 1, 2]) } : param === "loop" ? { loopBeats: pick([1, 2, 4, 8]) } : {};
    return lane(pick(["outgoing", "incoming"] as const), param, keyframes, extra);
  });
  return { recipe: "custom", outgoingAt: { bar: pick([1, 9, 17, 18]), beat: pick([1, 3] as const) }, incomingAt: { bar: 1, beat: 1 }, lengthBeats, lanes };
}

describe("properties, over 500 random Transitions", () => {
  const random = seededRandom(189);
  const transitions = Array.from({ length: 500 }, () => randomTransition(random));

  it("every keyframe is realised by at least one step or set-up item", () => {
    for (const transition of transitions) {
      const plan = deriveExecution(transition, DECKS, EVERYTHING);
      const realised = new Set(
        [...plan.steps, ...plan.setUp]
          .flatMap(({ source, alsoRealises }) => [source, ...alsoRealises])
          .flatMap((entry) => (entry === null || entry === "incoming-start" ? [] : [`${String(entry.lane)}:${String(entry.keyframe)}`])),
      );
      transition.lanes.forEach(({ keyframes }, laneIndex) => {
        keyframes.forEach((_, keyframe) => {
          expect(realised.has(`${String(laneIndex)}:${String(keyframe)}`), JSON.stringify({ transition, laneIndex, keyframe })).toBe(true);
        });
      });
    }
  });

  it("is deterministic, in time order, rated 1–5 with reasons that add up, and never throws on a design", () => {
    for (const transition of transitions) {
      const plan = deriveExecution(transition, DECKS, EVERYTHING);
      expect(deriveExecution(transition, DECKS, EVERYTHING)).toEqual(plan);
      const starts = plan.steps.map(({ startBeat }) => startBeat);
      expect(starts).toEqual([...starts].sort((a, b) => a - b));
      expect(plan.complexity.rating).toBeGreaterThanOrEqual(1);
      expect(plan.complexity.rating).toBeLessThanOrEqual(5);
      expect(plan.complexity.reasons.reduce((sum, { points }) => sum + points, 0)).toBe(plan.complexity.score);
      for (const { startBeat, endBeat, hand, control } of plan.steps) {
        expect(endBeat).toBeGreaterThanOrEqual(startBeat);
        expect(["left", "right"]).toContain(hand);
        expect(flx4LayoutControl(control).id).toBe(control);
      }
    }
  });

  it("a Learner with nothing unlocked never rates easier than one with everything", () => {
    for (const transition of transitions.slice(0, 100)) {
      expect(deriveExecution(transition, DECKS, new Set()).complexity.score).toBeGreaterThanOrEqual(deriveExecution(transition, DECKS, EVERYTHING).complexity.score);
    }
  });
});

it("every shared recipe derives", () => {
  for (const id of RECIPE_IDS) expect(deriveExecution(recipe(id), DECKS, EVERYTHING).steps.length).toBeGreaterThan(0);
});
