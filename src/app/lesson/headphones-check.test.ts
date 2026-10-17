import { describe, expect, it } from "vitest";
import { emptyLearnerRecord, withHeadphonesChecked } from "@shared/learner.ts";
import { headphonesCheck, HEADPHONES_START, needsHeadphonesCheck, type HeadphonesStep } from "./headphones-check.ts";

const play = (events: Parameters<typeof headphonesCheck>[1][]): HeadphonesStep => events.reduce(headphonesCheck, HEADPHONES_START);

describe("the one-time headphones check", () => {
  it("asks for headphones, then a click in the left ear, then the right, and passes", () => {
    expect(HEADPHONES_START).toEqual({ kind: "plug-in" });
    expect(play([{ type: "plugged-in" }])).toEqual({ kind: "ear", ear: "left" });
    expect(play([{ type: "plugged-in" }, { type: "heard", ear: "left" }])).toEqual({ kind: "ear", ear: "right" });
    expect(play([{ type: "plugged-in" }, { type: "heard", ear: "left" }, { type: "heard", ear: "right" }])).toEqual({ kind: "passed" });
  });

  it("detects OS mono: a one-ear click heard in both ears", () => {
    expect(play([{ type: "plugged-in" }, { type: "heard", ear: "both" }])).toEqual({ kind: "mono" });
    expect(play([{ type: "plugged-in" }, { type: "heard", ear: "left" }, { type: "heard", ear: "both" }])).toEqual({ kind: "mono" });
  });

  it("spots headphones on the wrong way round", () => {
    expect(play([{ type: "plugged-in" }, { type: "heard", ear: "right" }])).toEqual({ kind: "swapped" });
  });

  it("starts the ear test over after a fix", () => {
    expect(play([{ type: "plugged-in" }, { type: "heard", ear: "both" }, { type: "retry" }])).toEqual({ kind: "ear", ear: "left" });
    expect(play([{ type: "plugged-in" }, { type: "heard", ear: "right" }, { type: "retry" }])).toEqual({ kind: "ear", ear: "left" });
  });

  it("is needed once, for Lessons that use the headphone cue", () => {
    const fresh = emptyLearnerRecord("default");
    expect(needsHeadphonesCheck({ headphones: true }, fresh)).toBe(true);
    expect(needsHeadphonesCheck({}, fresh)).toBe(false);
    expect(needsHeadphonesCheck({ headphones: true }, withHeadphonesChecked(fresh, "2026-10-17T10:00:00.000Z"))).toBe(false);
  });
});
