import { describe, expect, it } from "vitest";
import { testGrid } from "@shared/mix-plan-test-support.ts";
import { transitionFromRecipe } from "@shared/mix-plan-recipes.ts";
import {
  beatOfX,
  fitZoom,
  gridLineBeats,
  MAX_PX_PER_BEAT,
  pairSpan,
  phraseMarks,
  snapBeat,
  snapStep,
  transitionFocus,
  viewOf,
  xOfBeat,
  zoomAround,
} from "./timeline.ts";

// 120 BPM, bar 1 at 0.1 s, 60 s long: 119.8 beats from bar 1.
const GRID = testGrid({ durationSec: 60 });
const TRANSITION = transitionFromRecipe("crossfade-8", { outgoingAt: { bar: 17, beat: 1 }, incomingAt: { bar: 1, beat: 1 } });

describe("the Transition editor's timeline", () => {
  it("spans both tracks against the Transition", () => {
    expect(pairSpan(TRANSITION, GRID, GRID)).toEqual({ fromBeat: -64, toBeat: 119.8 });
    // Not found yet: the Transition and a phrase either side.
    expect(pairSpan(TRANSITION, null, null)).toEqual({ fromBeat: -64, toBeat: 64 });
  });

  it("opens on the Transition with a phrase either side, never before the track starts", () => {
    expect(transitionFocus(TRANSITION)).toEqual({ fromBeat: -32, toBeat: 64 });
    expect(transitionFocus({ ...TRANSITION, outgoingAt: { bar: 3, beat: 1 } })).toEqual({ fromBeat: -8, toBeat: 64 });
  });

  it("maps beats to pixels and back", () => {
    const span = { fromBeat: -64, toBeat: 120 };
    expect(xOfBeat(0, span, 10)).toBe(640);
    expect(beatOfX(640, span, 10)).toBe(0);
  });

  it("zooms around the pointer, between the whole pair and a beat at its widest", () => {
    const span = { fromBeat: -64, toBeat: 120 };
    const whole = fitZoom(span, 920);
    expect(whole).toBe(5);
    const view = { pxPerBeat: 10, scrollPx: 300 };
    const closer = zoomAround(view, 2, 340, span, whole, 920);
    expect(closer.pxPerBeat).toBe(20);
    // The beat under the pointer stays under it.
    expect(beatOfX(closer.scrollPx + 340, span, 20)).toBeCloseTo(beatOfX(300 + 340, span, 10));
    expect(zoomAround(view, 1e-6, 0, span, whole, 920)).toEqual({ pxPerBeat: whole, scrollPx: 0 });
    expect(zoomAround(view, 1e6, 0, span, whole, 920).pxPerBeat).toBe(MAX_PX_PER_BEAT);
  });

  it("opens a view on the focus", () => {
    const span = { fromBeat: -64, toBeat: 120 };
    expect(viewOf({ fromBeat: -32, toBeat: 64 }, span, 960, 1)).toEqual({ pxPerBeat: 10, scrollPx: 320 });
  });

  it("snaps to beats, and to half beats when zoomed right in", () => {
    expect(snapStep(10)).toBe(1);
    expect(snapStep(60)).toBe(0.5);
    expect(snapBeat(3.4, 1)).toBe(3);
    expect(snapBeat(3.4, 0.5)).toBe(3.5);
  });

  it("draws beats, bars or phrases as the zoom allows", () => {
    expect(gridLineBeats(12)).toBe(1);
    expect(gridLineBeats(4)).toBe(4);
    expect(gridLineBeats(1)).toBe(32);
  });

  it("numbers the outgoing track's phrases in view", () => {
    expect(phraseMarks(TRANSITION, -40, 40)).toEqual([
      { beat: -32, phrase: 2 },
      { beat: 0, phrase: 3 },
      { beat: 32, phrase: 4 },
    ]);
    expect(phraseMarks(TRANSITION, -100, -60)[0]).toEqual({ beat: -64, phrase: 1 });
  });
});
