import { describe, expect, it } from "vitest";
import type { MusicFolderSnapshot } from "@tracks";
import { SERVER_LINE, folderCaption, folderCounts, refreshLine, rekordboxLine } from "./MusicFolderPanel.tsx";

const snapshot = (overrides: Partial<MusicFolderSnapshot> = {}): MusicFolderSnapshot => ({
  version: 1,
  source: "device",
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
  rekordbox: null,
  ...overrides,
});

const rekordbox = (overrides: Partial<NonNullable<MusicFolderSnapshot["rekordbox"]>> = {}): NonNullable<MusicFolderSnapshot["rekordbox"]> => ({
  version: 1,
  from: "folder",
  name: "Music/rekordbox.xml",
  reading: false,
  tracks: 4000,
  skipped: 0,
  needsPermission: false,
  canPickFile: true,
  problem: null,
  matched: 0,
  ...overrides,
});

describe("rekordbox caption", () => {
  it("says how many of the folder's tracks rekordbox knows", () => {
    expect(rekordboxLine(snapshot({ found: 130, rekordbox: rekordbox({ matched: 120 }) }))).toBe("rekordbox: matched 120 of 130");
    expect(rekordboxLine(snapshot({ found: 1, rekordbox: rekordbox({ matched: 1, skipped: 3 }) }))).toBe("rekordbox: matched 1 of 1 · 3 entries skipped");
  });

  it("says when it is reading, or needs a click, and nothing without a collection", () => {
    expect(rekordboxLine(snapshot({ rekordbox: rekordbox({ reading: true }) }))).toBe("rekordbox: reading “Music/rekordbox.xml”…");
    expect(rekordboxLine(snapshot({ rekordbox: rekordbox({ from: "file", needsPermission: true }) }))).toBe("rekordbox.xml: the browser needs one click to read it again.");
    expect(rekordboxLine(snapshot({ rekordbox: rekordbox({ from: null, name: null }) }))).toBeNull();
    expect(rekordboxLine(snapshot())).toBeNull();
  });
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

describe("the server's library", () => {
  const server = (overrides: Partial<MusicFolderSnapshot> = {}) => snapshot({ source: "server", canPick: false, ...overrides });

  it("names the folder as the server's, with the same counts", () => {
    expect(folderCaption(server({ found: 120, analysed: 30 }))).toBe("“Music” on the server: 120 tracks · BPM for 30");
    expect(folderCaption(server({ scanning: true, found: 50 }))).toBe("Looking in “Music” on the server… 50 tracks so far");
  });

  it("says it can't be read when the server has a library it could not list", () => {
    expect(folderCaption(server({ folder: null, access: "none" }))).toBe("The server's music library can't be read.");
  });

  it("says the server sets it, and how often it is checked", () => {
    expect(refreshLine(server())).toBe(SERVER_LINE);
    expect(refreshLine(server({ access: "none", folder: null }))).toBeNull();
  });
});
