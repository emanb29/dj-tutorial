import { describe, expect, it } from "vitest";
import type { Candidate, SongFindings } from "./finder.ts";
import { renderReport, reportData, scriptJson } from "./report.ts";

const candidate = (id: string, title: string): Candidate => ({
  platform: "soundcloud",
  id,
  title,
  uploader: "someone",
  durationSec: 240,
  url: `https://soundcloud.com/${id}`,
  plays: null,
  kind: "remix",
  remixer: null,
  djFriendly: true,
  variantKey: id,
  analysis: { status: "ok", version: 1, bpm: 124, bpmConfidence: 0.9, bpmMethod: "beat-this", key: { tonic: 9, mode: "minor", camelot: "8A", name: "A minor", confidence: 0.2 }, clip: { startSec: 60, seconds: 60, source: "stream" } },
  measuredFrom: null,
});

const findings: SongFindings = {
  song: { spotifyId: "AAAAAAAAAAAAAAAAAAAAAA", title: "Song", artists: ["Artist"], durationSec: 200, previewUrl: null },
  original: { status: "ok", version: 1, bpm: 120, bpmConfidence: 0.9, bpmMethod: "beat-this", key: { tonic: 0, mode: "major", camelot: "8B", name: "C major", confidence: 0.2 }, clip: { startSec: 0, seconds: 30, source: "preview" } },
  candidates: [candidate("sc:1", "Song (A Remix)"), candidate("sc:2", "Song (B Remix) </script><script>alert(1)</script>")],
  queries: ["Artist Song remix"],
  problems: [],
};

describe("reportData", () => {
  it("marks the agent's picks with their rank and reason, and the key's fit", () => {
    const data = reportData({ playlistName: "P", generatedAt: "2026-11-04T00:00:00Z", findings: [findings], picks: new Map([[0, { picks: [{ candidateId: "sc:2", reason: "Peak-time" }], note: null }]]), summary: null, notes: [] });
    expect(data.songs[0]?.variants.map((v) => [v.id, v.pick, v.reason, v.harmony])).toEqual([
      ["sc:1", null, null, "relative"],
      ["sc:2", 0, "Peak-time", "relative"],
    ]);
  });
});

describe("renderReport", () => {
  it("cannot be broken out of by a title", () => {
    const html = renderReport({ playlistName: "P", generatedAt: "2026-11-04T00:00:00Z", findings: [findings], picks: null, summary: null, notes: [] });
    expect(html).not.toContain("</script><script>alert(1)");
    expect(scriptJson("</script>\u2028")).toBe('"\\u003c/script>\\u2028"');
  });
});
