import { describe, expect, it } from "vitest";
import type { Observation, PracticeDrill } from "@lessons";
import { DrillRunner, type LiveReading } from "./practice-drill.ts";

const TEMPO_DRILL: PracticeDrill = { kind: "tempo-ear", apartPercents: [1.5], matchBpm: 0.1, giveUpBars: 24, revealMs: 2500 };

/** Deck A at 124 BPM; each round puts B 1.5% off it, and the Learner's tempo moves set B. */
function runner() {
  const decks = { bpmB: 124 };
  const observed: Observation[] = [];
  const read = (): LiveReading => ({ nowMs: 0, phaseMs: null, bpmA: 124, bpmB: decks.bpmB, barMs: 1935 });
  const drill = new DrillRunner(TEMPO_DRILL, read, {
    observe: (observation) => observed.push(observation),
    status: () => undefined,
    startRound: (round) => {
      decks.bpmB = 124 * (1 + round.apartPercent / 100);
    },
  });
  const moveB = (bpm: number) => {
    decks.bpmB = bpm;
    drill.tempoMoved("B");
  };
  return { drill, observed, moveB };
}

describe("DrillRunner, tempo by ear", () => {
  it("takes the first tempo move of a round as the guess, even before the first tick (ISS-103)", () => {
    const { observed, moveB } = runner();
    moveB(124.5);
    expect(observed).toEqual([{ kind: "tempo-guess", right: true }]);
  });

  it("takes the first move after a round waited for the controller as the guess, too", () => {
    const { drill, observed, moveB } = runner();
    drill.tick();
    drill.restartRound();
    moveB(127);
    expect(observed).toEqual([{ kind: "tempo-guess", right: false }]);
  });
});
