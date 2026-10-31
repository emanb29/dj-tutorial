import { describe, expect, it } from "vitest";
import type { MusicFolderSnapshot } from "@tracks";
import { folderCaption, folderCounts } from "./MusicFolderPanel.tsx";

const snapshot = (overrides: Partial<MusicFolderSnapshot> = {}): MusicFolderSnapshot => ({
  version: 1,
  canPick: true,
  folder: "Music",
  access: "granted",
  scanning: false,
  refresh: "polling",
  found: 0,
  analysed: 0,
  failed: 0,
  skipped: 0,
  truncated: false,
  problem: null,
  ...overrides,
});

describe("music folder captions", () => {
  it("asks for a folder, or an import where the browser cannot pick one", () => {
    expect(folderCaption(snapshot({ access: "none", folder: null }))).toBe("Pick your music folder. New tracks show up by themselves.");
    expect(folderCaption(snapshot({ access: "none", folder: null, canPick: false }))).toBe("Import your music folder.");
  });

  it("says one click is needed to read a remembered folder again", () => {
    expect(folderCaption(snapshot({ access: "needs-permission" }))).toBe("“Music”: the browser needs one click to read it again.");
  });

  it("counts as it looks, then sums up briefly", () => {
    expect(folderCaption(snapshot({ scanning: true, found: 1 }))).toBe("Looking in “Music”… 1 track so far");
    expect(folderCaption(snapshot({ found: 1200, analysed: 30, failed: 2, skipped: 1 }))).toBe("“Music”: 1,200 tracks · BPM for 30 · 2 with no BPM · 1 unreadable");
  });

  it("says when a huge folder was cut short", () => {
    expect(folderCounts(snapshot({ found: 20_000, truncated: true }))).toContain("first 20,000 only");
  });
});
