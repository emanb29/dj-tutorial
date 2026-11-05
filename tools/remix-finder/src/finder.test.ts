import { describe, expect, it } from "vitest";
import type { Analysis } from "./audio.ts";
import { borrowMeasurements, defaultQueries, harmonyWithOriginal, toCandidates, type Candidate } from "./finder.ts";
import type { SearchResult } from "./search.ts";

const song = { spotifyId: "AAAAAAAAAAAAAAAAAAAAAA", title: "Loser", artists: ["Tame Impala"], durationSec: 223, previewUrl: null };

const result = (id: string, title: string, uploader = "Tame Impala"): SearchResult => ({
  platform: id.startsWith("youtube") ? "youtube" : "soundcloud",
  id,
  title,
  uploader,
  durationSec: 240,
  url: `https://example.com/${id}`,
  plays: null,
});

const ok = (bpm: number, camelot: string): Analysis => ({
  status: "ok",
  version: 1,
  bpm,
  bpmConfidence: 0.9,
  bpmMethod: "beat-this",
  key: { tonic: 0, mode: "major", camelot, name: "x", confidence: 0.2 },
  clip: { startSec: 60, seconds: 60, source: "stream" },
});

describe("toCandidates", () => {
  it("keeps variants once each and drops the original and the noise", () => {
    const found = toCandidates(song, [
      result("soundcloud:1", "Loser (Fcukers Remix)"),
      result("soundcloud:1", "Loser (Fcukers Remix)"),
      result("youtube:a", "Tame Impala - Loser (Official Video)"),
      result("youtube:b", "Dracula - Tame Impala (JENNIE Remix)", "ANNA"),
      result("youtube:c", "Tame Impala - Loser (slowed + reverb)", "someone"),
    ]);
    expect(found.map((candidate) => [candidate.id, candidate.kind, candidate.remixer, candidate.djFriendly])).toEqual([
      ["soundcloud:1", "remix", "Fcukers", true],
      ["youtube:c", "slowed", null, false],
    ]);
  });

  it("searches by the main artist and the core title", () => {
    expect(defaultQueries({ ...song, title: "Loser - Remastered 2011" })).toEqual(["Tame Impala loser remix", "Tame Impala loser edit bootleg"]);
  });
});

describe("borrowMeasurements", () => {
  it("lends a DRM-locked result its twin's numbers", () => {
    const [drm, twin] = toCandidates(song, [result("soundcloud:1", "Loser (Fcukers Remix)"), result("youtube:a", "Tame Impala - Loser (Fcukers Remix - Official Audio)")]);
    if (drm === undefined || twin === undefined) throw new Error("expected two candidates");
    const candidates: Candidate[] = [
      { ...drm, analysis: { status: "unavailable", version: 1, reason: "DRM" }, measuredFrom: null },
      { ...twin, analysis: ok(124, "8A"), measuredFrom: null },
    ];
    expect(borrowMeasurements(candidates)[0]).toMatchObject({ measuredFrom: "youtube:a", analysis: { bpm: 124 } });
  });
});

describe("harmonyWithOriginal", () => {
  it("compares keys when both are known", () => {
    expect(harmonyWithOriginal(ok(120, "8A"), ok(124, "9A"))).toBe("neighbour");
    expect(harmonyWithOriginal(null, ok(124, "9A"))).toBeNull();
  });
});
