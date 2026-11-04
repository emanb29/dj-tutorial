// Synthetic names only (the repo is public).
import { describe, expect, it } from "vitest";
import { artistAgreement, buildEnrichReport, creditsAgreement, type EnrichTrack } from "./enrich-names-report.ts";

const track = (rawName: string, artist = "", fileName: string | null = null): EnrichTrack => ({ rawName, fileName, tags: { artist } });

describe("artistAgreement", () => {
  it("agrees on the same set of names, whatever the order, case and joiners", () => {
    expect(artistAgreement("Moss Harbor & Kit Lane", "kit lane, MOSS HARBOR")).toBe("agree");
    expect(artistAgreement("Moss Harbor x Kit Lane", "Moss Harbor and Kit Lane")).toBe("agree");
    expect(artistAgreement("Bishøp", "Bishøp")).toBe("agree");
  });

  it("is partial when only some names are shared, and disagrees otherwise", () => {
    expect(artistAgreement("Moss Harbor & Kit Lane", "Moss Harbor")).toBe("partial");
    expect(artistAgreement("Glass Rivers", "Moss Harbor")).toBe("disagree");
  });
});

describe("creditsAgreement", () => {
  it("agrees when the tag lists the featured artist or the remixer too, as tags often do", () => {
    expect(creditsAgreement({ artist: "Moss Harbor", featuring: "Kit Lane", remixer: null }, "Moss Harbor feat. Kit Lane")).toBe("agree");
    expect(creditsAgreement({ artist: "Moss Harbor", featuring: null, remixer: "Tinwhistle" }, "Moss Harbor, Tinwhistle")).toBe("agree");
  });

  it("is partial when a parsed artist is missing from the tag, or the tag names someone the parse does not", () => {
    expect(creditsAgreement({ artist: "Moss Harbor & Kit Lane", featuring: null, remixer: null }, "Moss Harbor")).toBe("partial");
    expect(creditsAgreement({ artist: "Moss Harbor", featuring: null, remixer: null }, "Moss Harbor, Someone")).toBe("partial");
  });

  it("disagrees when the parsed artist is not in the tag at all", () => {
    expect(creditsAgreement({ artist: "Glass Rivers", featuring: null, remixer: "Moss Harbor" }, "Moss Harbor")).toBe("disagree");
  });
});

describe("buildEnrichReport", () => {
  const tracks = [
    track("Moss Harbor - Glass Rivers (Tinwhistle Remix) [FREE DL] [1234567890]"),
    track("Paper Lanterns [987654321]"),
    track("Call Back (VIP)", "Jakob Ory & Snailfish", "Jakob Ory & Snailfish - Call Back (VIP) [221700001].m4a"),
    track("Night Bus", "Della Vane", "Night Bus (Orrin Flip) - Della Vane ft. Kip Rowe [1926700001].m4a"),
    // The tag is an uploader the name never mentions: nothing to compare.
    track("Lumen - Harbour Lights", "Someone Else"),
    // The tag is the remixer, not the artist.
    track("Kit Lane - Paper Boats (Tinwhistle Remix)", "Tinwhistle"),
    // A real disagreement: the tag is in the name, on the other side.
    track("Glass Rivers - Moss Harbor", "Moss Harbor"),
    track("Plain Things - KIT, Tayla Rue [2228600001]"),
  ];
  const report = buildEnrichReport(tracks, { sources: { xml: "collection.xml", folder: null } });

  it("counts each field before and after, per band", () => {
    expect(report.trackCount).toBe(8);
    expect(report.fields.artist.before).toBe(5);
    // Five tags kept; Moss Harbor (high) and Plain Things (medium) parsed.
    expect(report.fields.artist.after).toMatchObject({ existing: 5, high: 1, medium: 1, low: 0, total: 7 });
    expect(report.fields.sourceId.after.total).toBe(5);
    expect(report.fields.remixer.after.total).toBeGreaterThanOrEqual(1);
    expect(report.flags["free-download"]).toBe(1);
  });

  it("counts titles that change", () => {
    expect(report.fields.title.changed).toBeGreaterThanOrEqual(3);
  });

  it("lists the most common rules, most used first", () => {
    expect(report.topRules.length).toBeGreaterThan(0);
    expect(report.topRules.length).toBeLessThanOrEqual(30);
    const counts = report.topRules.map((rule) => rule.count);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  it("calibrates the parsed artist against tracks that already have one, per band", () => {
    // Jakob Ory & Snailfish (from the file, agrees), Della Vane (reversed, agrees), Someone Else (not in
    // the name), Tinwhistle (the remixer), Glass Rivers vs Moss Harbor (disagrees).
    expect(report.calibration.tracksWithArtistTag).toBe(5);
    const all = Object.values(report.calibration.bands);
    const sum = (key: "proposed" | "agree" | "disagree" | "tagIsRemixer" | "tagNotInName") => all.reduce((total, band) => total + band[key], 0);
    expect(sum("proposed")).toBe(5);
    expect(sum("agree")).toBe(2);
    expect(sum("tagNotInName")).toBe(1);
    expect(sum("tagIsRemixer")).toBe(1);
    expect(sum("disagree")).toBe(1);
    const high = report.calibration.bands.high;
    expect(high.precision).toBeCloseTo(high.agree / high.proposed);
    expect(high.comparablePrecision).toBeCloseTo(high.agree / (high.agree + high.partial + high.disagree));
  });

  it("samples diffs across bands, only of tracks that change", () => {
    expect(report.samples.length).toBeGreaterThan(0);
    expect(report.samples.length).toBeLessThanOrEqual(40);
    expect(new Set(report.samples.map((sample) => sample.band)).size).toBeGreaterThan(1);
    expect(report.samples.every((sample) => sample.after.title !== sample.before.title || sample.after.artist?.source !== "tag")).toBe(true);
  });

  it("is a dry run: it says so", () => {
    expect(report.dryRun).toBe(true);
  });
});
