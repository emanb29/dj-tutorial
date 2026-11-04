import { describe, expect, it } from "vitest";
import { previewRoute } from "./preview-route.ts";

describe("where a preview plays", () => {
  it("in the headphones when the output mode has a headphone path of its own", () => {
    expect(previewRoute({ kind: "two-devices", sinkId: "speakers", masterLabel: "Speakers", headphoneSinkId: "phones", headphoneLabel: "Phones", headphoneOffsetMs: 0 })).toEqual({ kind: "device", sinkId: "phones" });
    expect(previewRoute({ kind: "controller", sinkId: "flx4", label: "DDJ-FLX4" })).toEqual({ kind: "controller-phones", sinkId: "flx4" });
    for (const kind of ["computer-and-controller-phones", "dual-master"] as const) {
      expect(previewRoute({ kind, sinkId: "speakers", masterLabel: "Speakers", controllerSinkId: "flx4", controllerLabel: "DDJ-FLX4", headphoneOffsetMs: 0 })).toEqual({ kind: "controller-phones", sinkId: "flx4" });
    }
  });

  it("on the default output in split cue, fallen back or chosen", () => {
    expect(previewRoute({ kind: "split-cue", sinkId: null, fallback: null })).toEqual({ kind: "default" });
    expect(previewRoute({ kind: "split-cue", sinkId: null, fallback: "Phones not found" })).toEqual({ kind: "default" });
  });
});
