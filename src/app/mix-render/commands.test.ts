import { describe, expect, it } from "vitest";
import type { EngineCommand } from "@audio/commands.ts";
import { testGrid, testPlan } from "@shared/mix-plan-test-support.ts";
import type { RecipeId } from "@shared/mix-plan.ts";
import { mixCommands, RAMP_STEP_SEC, stateAt, type TimedCommand } from "./commands.ts";
import { setTimeline, type SetTimeline } from "./timeline.ts";

function render(recipe: RecipeId, count = 2): { timeline: SetTimeline; commands: TimedCommand[]; startSec: number } {
  const { plan } = testPlan(count, { recipe });
  const outcome = setTimeline(plan, Array.from({ length: count }, () => testGrid()));
  if (!outcome.ok) throw new Error(outcome.problems[0]?.message);
  const commands = mixCommands(plan, outcome.timeline);
  return { timeline: outcome.timeline, commands, startSec: outcome.timeline.transitions[0]?.startSec ?? Number.NaN };
}

/** The commands for one control, as [set seconds, value]. */
function moves(commands: readonly TimedCommand[], match: Partial<EngineCommand>): [number, unknown][] {
  return commands
    .filter(({ command }) => Object.entries(match).every(([key, value]) => (command as Record<string, unknown>)[key] === value))
    .map(({ atSec, command }) => [atSec, "value" in command ? command.value : null]);
}

const near = (sec: number) => expect.closeTo(sec, 6) as number;

describe("mixCommands", () => {
  it("starts deck A at full with the crossfader centred, and deck B down", () => {
    const { commands } = render("crossfade-16");
    expect(stateAt(commands, 0)).toEqual(
      expect.arrayContaining([
        { control: "channel-fader", deck: "A", value: 1 },
        { control: "channel-fader", deck: "B", value: 0 },
        { control: "crossfader", value: 0.5 },
        { control: "trim", deck: "A", value: 0 },
        { control: "beat-fx", value: false },
      ]),
    );
  });

  it("plays a bass swap with the faders and LOW knobs, as its Execution plan does", () => {
    // 120 BPM: the Transition starts at 256 s and its 64 beats take 32 s.
    const { commands, startSec } = render("bass-swap");
    expect(startSec).toBeCloseTo(256, 9);
    expect(moves(commands, { control: "eq-low", deck: "B" })).toEqual([
      [0, 0],
      [256, 0],
      [256, -1],
      [near(272), 0],
    ]);
    expect(moves(commands, { control: "eq-low", deck: "A" })).toEqual([
      [0, 0],
      [near(272), -1],
    ]);
    const incomingFader = moves(commands, { control: "channel-fader", deck: "B" });
    expect(incomingFader.at(-1)).toEqual([near(272), 1]);
    // A ramp is a move every 5 ms, rising steadily.
    const ramp = incomingFader.filter(([sec]) => sec > 256 && sec <= 272);
    expect(ramp.length).toBe(Math.ceil(16 / RAMP_STEP_SEC));
    expect(ramp[ramp.length / 2]?.[1]).toBeCloseTo(0.5, 2);
    const outgoingFader = moves(commands, { control: "channel-fader", deck: "A" });
    expect(outgoingFader.at(-1)).toEqual([near(288), 0]);
    expect(outgoingFader.filter(([sec]) => sec > 0 && sec < 272)).toEqual([]);
  });

  it("plays a cut on the 1 with the crossfader, and brings it back to the centre over the bar before the next Transition", () => {
    const { commands, timeline } = render("cut-on-the-1", 3);
    const [first, second] = timeline.transitions;
    if (first === undefined || second === undefined) throw new Error("expected two Transitions");
    // The incoming track starts at full behind the centred crossfader, which snaps to its side on the 1.
    expect(moves(commands, { control: "channel-fader", deck: "B" }).filter(([sec]) => sec === first.startSec).at(-1)).toEqual([first.startSec, 1]);
    const crossfader = moves(commands, { control: "crossfader" });
    expect(crossfader.filter(([sec]) => sec <= first.startSec)).toEqual([
      [0, 0.5],
      [first.startSec, 1],
    ]);
    // The next Transition starts centred: track 2 eases down 3 dB over the 4 beats (2 s) before it, then cuts to deck A.
    const back = crossfader.filter(([sec]) => sec > first.startSec && sec < second.startSec);
    expect(back[0]?.[0]).toBeGreaterThan(second.startSec - 2);
    expect(crossfader.slice(-2)).toEqual([
      [near(second.startSec), 0.5],
      [second.startSec, 0],
    ]);
  });

  it("plays an echo out with Beat FX on the outgoing deck, at that deck's BPM", () => {
    const { commands, startSec } = render("echo-out");
    const fx = commands.filter(({ atSec, command }) => command.control.startsWith("beat-fx") && atSec > 0);
    expect(fx.map(({ atSec, command }) => [atSec, command])).toEqual([
      [startSec, { control: "beat-fx-channel", value: "A" }],
      [startSec, { control: "beat-fx-beats", value: 1 }],
      [startSec, { control: "beat-fx-depth", value: 1 }],
      [startSec, { control: "beat-fx-bpm", value: 120 }],
      [startSec, { control: "beat-fx", value: true }],
      [near(startSec + 4), { control: "beat-fx", value: false }],
    ]);
  });

  it("resets a deck as its next track loads: a filter left high-passed by a filter sweep does not carry over", () => {
    const { commands, timeline } = render("filter-sweep", 3);
    const third = timeline.transitions[1]?.startSec ?? Number.NaN;
    expect(stateAt(commands, third).find((command) => command.control === "filter" && command.deck === "A")).toEqual({ control: "filter", deck: "A", value: 0 });
    const before = timeline.transitions[0]?.endSec ?? Number.NaN;
    expect(stateAt(commands, before).find((command) => command.control === "filter" && command.deck === "A")).toEqual({ control: "filter", deck: "A", value: 1 });
  });
});
