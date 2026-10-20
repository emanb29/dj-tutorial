import { describe, expect, it } from "vitest";
import { checkDecksFor, LESSONS, PLACEMENT_TASK_IDS, placementTask, practiceDecksFor, practiceLoopFor, setUpTrim, SYNTHETIC_HOUSE, SYNTHETIC_PARTNER, syntheticLessonTrack, type DeckSetups, type LessonDefinition, type LessonTrack } from "@lessons";
import type { ContinuousControlId } from "../controller/gestures.ts";
import {
  BEAT_FX_SETUP_FIELDS,
  DECK_SETUP_FIELDS,
  DEFAULT_TRIM,
  describeTarget,
  matchItems,
  matchLine,
  MIXER_SETUP_FIELDS,
  settledValue,
  setUpTargets,
  stepTargets,
  targetMatched,
  type HardwarePlaces,
  type SetUpTarget,
} from "./hardware-sync.ts";

const track: LessonTrack = { ...syntheticLessonTrack(SYNTHETIC_HOUSE), partner: syntheticLessonTrack(SYNTHETIC_PARTNER) };
const before = () => ({ syncOn: false, tempoRangePercent: 6 });
const targetsOf = (decks: DeckSetups) => setUpTargets(decks, track, { withB: true, before });
const at = (positions: Partial<Record<ContinuousControlId, number>>): HardwarePlaces => ({ position: (control) => positions[control] ?? null });

/** Every set-up a Lesson or a Placement task applies: practice, its loop back, and a few Check attempts. */
function setUpsOf(definition: LessonDefinition): DeckSetups[] {
  const loop = practiceLoopFor(definition, track);
  return [practiceDecksFor(definition, track), ...(loop?.decks === undefined ? [] : [loop.decks]), ...[0, 1, 2, 3].map((attempt) => checkDecksFor(definition.planCheck(track, attempt)))];
}

const ALL: readonly LessonDefinition[] = [...LESSONS, ...PLACEMENT_TASK_IDS.map(placementTask)];

describe("the set-up table: neutral, deliberate or software", () => {
  it("classifies every field every Lesson and Placement set-up touches", () => {
    const unclassified = ALL.flatMap((definition) =>
      setUpsOf(definition).flatMap((decks) => [
        ...Object.keys(decks).filter((key) => key !== "A" && key !== "B" && key !== "beatFx" && !(key in MIXER_SETUP_FIELDS)).map((key) => `${definition.id}: ${key}`),
        ...[decks.A, decks.B].flatMap((setup) => (setup === undefined ? [] : Object.keys(setup).filter((key) => !(key in DECK_SETUP_FIELDS)).map((key) => `${definition.id}: deck ${key}`))),
        ...Object.keys(decks.beatFx ?? {}).filter((key) => !(key in BEAT_FX_SETUP_FIELDS)).map((key) => `${definition.id}: beatFx ${key}`),
      ]),
    );
    expect(unclassified).toEqual([]);
  });

  it("turns every fader and knob a set-up names into a target, and nothing discrete", () => {
    for (const definition of ALL) {
      for (const decks of setUpsOf(definition)) {
        const controls = targetsOf(decks).map((target) => target.control);
        for (const [deck, setup] of [["A", decks.A], ["B", decks.B]] as const) {
          if (setup === undefined) continue;
          expect(controls, `${definition.id} ${deck}`).toContain(`${deck}.channel-fader`);
          expect(controls, `${definition.id} ${deck}`).toContain(`${deck}.trim`);
          if (setup.tempoPercent !== undefined && setup.sync !== true) expect(controls).toContain(`${deck}.tempo`);
          if (setup.eqCentred === true) expect(controls).toEqual(expect.arrayContaining([`${deck}.eq-high`, `${deck}.eq-mid`, `${deck}.eq-low`]));
          if (setup.filterCentred === true) expect(controls).toContain(`${deck}.filter`);
        }
        if (decks.crossfader !== undefined) expect(controls).toContain("crossfader");
        if (decks.beatFx?.depth !== undefined) expect(controls).toContain("beat-fx-depth");
        expect(new Set(controls).size).toBe(controls.length);
      }
    }
  });

  it("asks for Lesson 4 (Set the level)'s hot TRIM A and quiet TRIM B, and takes the usual set-up trim from the hardware", () => {
    const gain = LESSONS.find((lesson) => lesson.id === "gain-staging");
    const basics = LESSONS.find((lesson) => lesson.id === "deck-basics");
    if (gain === undefined || basics === undefined) throw new Error("Lessons 1 and 4 are in the catalogue");
    const trims = targetsOf(practiceDecksFor(gain, track)).filter((target) => target.control.endsWith(".trim"));
    expect(trims.map((target) => target.kind)).toEqual(["deliberate", "deliberate"]);
    const [trimA, trimB] = trims;
    expect(trimA?.value).toBeGreaterThan(trimB?.value ?? 0);
    const plain = targetsOf(practiceDecksFor(basics, track)).find((target) => target.control === "A.trim");
    expect(plain).toMatchObject({ kind: DEFAULT_TRIM, value: setUpTrim(track) });
    expect(DEFAULT_TRIM).toBe("neutral");
  });

  it("asks for faders, centred EQs and filters, the tempo, the crossfader and LEVEL/DEPTH; positions, CUE 🎧 and SYNC stay in software", () => {
    expect(DECK_SETUP_FIELDS).toMatchObject({ fader: "deliberate", eqCentred: "deliberate", filterCentred: "deliberate", tempoPercent: "deliberate", pos: "software", headphoneCue: "software", sync: "software", hotCues: "software" });
    expect(MIXER_SETUP_FIELDS.crossfader).toBe("deliberate");
    expect(BEAT_FX_SETUP_FIELDS).toEqual({ on: "software", channel: "software", beats: "software", depth: "deliberate" });
  });

  it("has no tempo target for a deck the set-up syncs (its tempo is the leader's)", () => {
    const targets = targetsOf({ A: { pos: 0, fader: 1, play: true, sync: true, tempoPercent: 0 } });
    expect(targets.map((target) => target.control)).not.toContain("A.tempo");
  });
});

describe("matching the controller", () => {
  const fader: SetUpTarget = { control: "B.channel-fader", value: 0, kind: "deliberate", to: "all the way down" };
  const trim: SetUpTarget = { control: "A.trim", value: 0.4, kind: "deliberate", to: describeTarget("A.trim", 0.4, 0) };
  const neutral: SetUpTarget = { control: "A.trim", value: -0.1, kind: "neutral", to: "centre" };

  it("ticks an item off within the tolerance, and says which way to move it before", () => {
    expect(matchItems([fader, trim], at({ "B.channel-fader": 0.03, "A.trim": 0.1 }), new Set()).map((item) => [item.state, matchLine(item)])).toEqual([
      ["matched", "Fader B: all the way down"],
      ["move", "TRIM A: to 2 o'clock ↻"],
    ]);
    expect(targetMatched(trim, 0.45)).toBe(true);
    expect(targetMatched(trim, 0.6)).toBe(false);
  });

  it("asks to wiggle a control whose position is not known yet", () => {
    const [item] = matchItems([fader], at({}), new Set());
    expect(item?.state).toBe("unknown");
    expect(item === undefined ? "" : matchLine(item)).toBe("Fader B: wiggle it");
  });

  it("never asks for a neutral value, nor for one the Learner skipped", () => {
    expect(matchItems([neutral, fader], at({}), new Set(["B.channel-fader"]))).toEqual([]);
  });

  it("asks for a deck's three EQs at centre as one item", () => {
    const eqs = (["eq-high", "eq-mid", "eq-low"] as const).map((band): SetUpTarget => ({ control: `B.${band}`, value: 0, kind: "deliberate", to: "centre" }));
    const items = matchItems([fader, ...eqs], at({ "B.channel-fader": 0, "B.eq-high": 0, "B.eq-mid": 0.3, "B.eq-low": 0 }), new Set());
    expect(items.map((item) => [item.label, item.state])).toEqual([
      ["Fader B", "matched"],
      ["EQs B", "move"],
    ]);
    expect(items[1] === undefined ? "" : matchLine(items[1])).toBe("EQs B: centre");
  });

  it("takes the hardware's value for a neutral target and a matched one; the plan's for an unknown or skipped one", () => {
    expect(settledValue(neutral, 0.37)).toBe(0.37);
    expect(settledValue(neutral, null)).toBe(-0.1);
    expect(settledValue(trim, 0.42)).toBe(0.42);
    expect(settledValue(trim, -0.5)).toBe(0.4);
    expect(settledValue(trim, null)).toBe(0.4);
  });

  it("says where to in a few words", () => {
    expect(describeTarget("A.channel-fader", 1, 0)).toBe("all the way up");
    expect(describeTarget("crossfader", 0, 0)).toBe("all the way to A");
    expect(describeTarget("crossfader", 0.5, 0)).toBe("centre");
    expect(describeTarget("B.tempo", 0, 6)).toBe("centre");
    expect(describeTarget("B.tempo", 0.25, 6)).toBe("to +1.5%");
    expect(describeTarget("A.eq-low", 0, 0)).toBe("centre");
    expect(describeTarget("A.trim", -1, 0)).toBe("to 7 o'clock");
    expect(describeTarget("beat-fx-depth", 0.7, 0)).toBe("to 2 o'clock");
  });

  it("points the tempo hint the way the fader moves: + is towards you", () => {
    const tempo: SetUpTarget = { control: "B.tempo", value: 0.25, kind: "deliberate", to: "to +1.5%" };
    expect(matchItems([tempo], at({ "B.tempo": 0 }), new Set())[0]?.hint).toBe("↓");
  });
});

describe("a set-up step's own asks", () => {
  it("leaves the controls its asks set (fader B up, LOW B down, SYNC B, trims) out of the match items", () => {
    const targets: SetUpTarget[] = [
      { control: "A.channel-fader", value: 1, kind: "deliberate", to: "all the way up" },
      { control: "B.channel-fader", value: 0, kind: "deliberate", to: "all the way down" },
      { control: "B.eq-low", value: 0, kind: "deliberate", to: "centre" },
      { control: "B.eq-mid", value: 0, kind: "deliberate", to: "centre" },
      { control: "B.tempo", value: 0, kind: "deliberate", to: "centre" },
      { control: "A.trim", value: 0, kind: "deliberate", to: "centre" },
      { control: "B.trim", value: 0, kind: "deliberate", to: "centre" },
    ];
    const controls = (asks: Parameters<typeof stepTargets>[1]) => stepTargets(targets, asks).map((target) => target.control);
    expect(controls([{ kind: "cue-on", deck: "B" }, { kind: "echo-on" }])).toEqual(targets.map((target) => target.control));
    expect(controls([{ kind: "fader-up", deck: "B" }])).toEqual(["A.channel-fader", "B.eq-low", "B.eq-mid", "B.tempo", "A.trim", "B.trim"]);
    expect(controls([{ kind: "low-cut", deck: "B" }])).toEqual(["A.channel-fader", "B.channel-fader", "B.eq-mid", "B.tempo", "A.trim", "B.trim"]);
    // A synced deck's tempo is the leader's.
    expect(controls([{ kind: "sync-on", deck: "B" }])).toEqual(["A.channel-fader", "B.channel-fader", "B.eq-low", "B.eq-mid", "A.trim", "B.trim"]);
    expect(controls([{ kind: "trims-matched" }])).toEqual(["A.channel-fader", "B.channel-fader", "B.eq-low", "B.eq-mid", "B.tempo"]);
  });

  it("never asks the controller for the opposite of what a Lesson's set-up step asks", () => {
    for (const definition of LESSONS) {
      for (const plan of [definition.planCheck(track, 1), definition.planCheck(track, 1, LESSONS.map((each) => each.id))]) {
        if (plan.setUp === undefined) continue;
        const asked = stepTargets(targetsOf(checkDecksFor(plan)), plan.setUp.asks).map((target) => target.control);
        for (const ask of plan.setUp.asks) {
          if (ask.kind === "fader-up") expect(asked, definition.id).not.toContain(`${ask.deck}.channel-fader`);
          if (ask.kind === "low-cut") expect(asked, definition.id).not.toContain(`${ask.deck}.eq-low`);
        }
      }
    }
  });
});
