// Synthetic tracks only (the repo is public).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyProposals, readDecisions, resolveField, rollback, type Decision } from "./apply.ts";
import type { Proposal, StoreItem, TrackBase } from "./store.ts";

const BASE: TrackBase = { trackId: "1", name: "Moss Harbor - Glass Rivers (Tinwhistle Remix)", fileName: "a.m4a", artist: "", genre: "", year: "0", comments: "", remixer: "", mix: "" };

const proposal = (field: Proposal["field"], value: string, band: Proposal["band"], step: Proposal["step"] = "names"): Proposal => ({ field, value, band, step, stepVersion: 1, source: "name", rule: "test", evidence: [] });

function item(proposals: Proposal[], base: Partial<TrackBase> = {}): StoreItem {
  return {
    hash: "h1",
    paths: ["/music/a.m4a"],
    base: { ...BASE, ...base },
    steps: { names: { version: 1, inputKey: "k", ranAt: "2026-01-01T00:00:00.000Z", proposals: proposals.filter((each) => each.step === "names") }, soundcloud: { version: 1, inputKey: "k", ranAt: "2026-01-01T00:00:00.000Z", proposals: proposals.filter((each) => each.step === "soundcloud") } },
    applied: {},
  };
}

const decision = (field: Decision["field"], value: string, verdict: Decision["decision"]): Decision => ({ hash: "h1", field, value, decision: verdict, at: "2026-01-02T00:00:00.000Z" });

describe("resolveField", () => {
  it("picks the surest proposal across steps", () => {
    const resolved = resolveField(item([proposal("genre", "house", "low"), proposal("genre", "tech house", "high", "soundcloud")]), "genre", []);
    expect(resolved).toMatchObject({ value: "tech house", band: "high" });
  });

  it("sends a winner to review when another value is nearly as sure", () => {
    const resolved = resolveField(item([proposal("artist", "Kit Lane", "high"), proposal("artist", "Moss Harbor", "medium", "soundcloud")]), "artist", []);
    expect(resolved).toMatchObject({ value: "Kit Lane", band: "medium", rule: "test+conflict" });
  });

  it("never proposes a rejected value again, and falls back to the next one", () => {
    const candidate = item([proposal("artist", "Kit Lane", "high"), proposal("artist", "Moss Harbor", "low", "soundcloud")]);
    expect(resolveField(candidate, "artist", [decision("artist", "Kit Lane", "reject")])).toMatchObject({ value: "Moss Harbor" });
    expect(resolveField(candidate, "artist", [decision("artist", "Kit Lane", "reject"), decision("artist", "Moss Harbor", "reject")])).toBeNull();
  });
});

describe("applyProposals and rollback", () => {
  it("fills only empty fields, high band or accepted, and journals each change", () => {
    const items = {
      h1: item([proposal("artist", "Tinwhistle", "high"), proposal("genre", "techno", "medium", "soundcloud"), proposal("year", "2023", "medium", "soundcloud")], { genre: "" }),
      h2: { ...item([proposal("artist", "Kit Lane", "high")], { artist: "Hand Set" }), hash: "h2" },
    };
    const { journal } = applyProposals(items, [decision("genre", "techno", "accept")], { run: "r1", fields: ["artist", "genre", "year"] });
    expect(items.h1.applied).toMatchObject({ artist: { value: "Tinwhistle", run: "r1" }, genre: { value: "techno" } });
    // Medium and not accepted: not applied.
    expect(items.h1.applied.year).toBeUndefined();
    // A hand-set artist wins.
    expect(items.h2.applied.artist).toBeUndefined();
    expect(journal.map((line) => [line.hash, line.field, line.old, line.new?.value])).toEqual([
      ["h1", "artist", null, "Tinwhistle"],
      ["h1", "genre", null, "techno"],
    ]);

    // Again: nothing new to do.
    expect(applyProposals(items, [decision("genre", "techno", "accept")], { run: "r2", fields: ["artist", "genre", "year"] }).journal).toEqual([]);

    const undone = rollback(items, journal);
    expect(undone).toEqual({ reverted: 2, skipped: 0 });
    expect(items.h1.applied).toEqual({});
  });

  it("only applies the fields it is asked to", () => {
    const items = { h1: item([proposal("artist", "Tinwhistle", "high"), proposal("title", "Glass Rivers", "high")]) };
    applyProposals(items, [], { run: "r1", fields: ["artist"] });
    expect(Object.keys(items.h1.applied)).toEqual(["artist"]);
  });

  it("skips, in a rollback, a field that changed since that run", () => {
    const items = { h1: item([proposal("artist", "Tinwhistle", "high")]) };
    const { journal } = applyProposals(items, [], { run: "r1", fields: ["artist"] });
    items.h1.applied.artist = { ...proposal("artist", "Someone Else", "high"), run: "r9" };
    expect(rollback(items, journal)).toEqual({ reverted: 0, skipped: 1 });
    expect(items.h1.applied.artist.value).toBe("Someone Else");
  });
});

describe("readDecisions", () => {
  it("reads a JSONL log, the last decision on a value winning, and lists every bad line", () => {
    const folder = mkdtempSync(join(tmpdir(), "enrich-decisions-"));
    const path = join(folder, "decisions.jsonl");
    writeFileSync(
      path,
      [JSON.stringify(decision("artist", "Kit Lane", "accept")), "not json", JSON.stringify({ hash: "h1", field: "colour", value: "x", decision: "accept" }), JSON.stringify(decision("artist", "Kit Lane", "reject")), ""].join("\n"),
    );
    const read = readDecisions(path);
    expect(read.decisions.map((each) => each.decision)).toEqual(["accept", "reject"]);
    expect(read.problems).toHaveLength(2);
    expect(read.problems[0]).toMatch(/line 2/);
  });

  it("is empty when there is no log yet", () => {
    expect(readDecisions(join(tmpdir(), "no-such-decisions.jsonl"))).toEqual({ decisions: [], problems: [] });
  });
});
