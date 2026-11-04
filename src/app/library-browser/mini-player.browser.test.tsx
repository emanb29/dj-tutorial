// The library browser's mini player in a real Chromium page (muted: nothing sounds): ▶ plays a row's
// preview from where it says what it is, pauses, one at a time, jumps 16 bars, seeks with a tap on its
// bar, and lets go of each file it opened (the object URL is revoked) when it stops. A row that is
// never played is never read. Invented names; the audio is a generated tone.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import type { PreviewHints, TrackPreview } from "@tracks";
import { FocusNavigator } from "../controller/focus-navigation.ts";
import type { LibraryRow } from "./browse.ts";
import { LibraryBrowser } from "./LibraryBrowser.tsx";
import { PreviewPlayer } from "./preview-player.ts";
import { wavFile } from "./test-support.ts";

function row(key: string, title: string): LibraryRow {
  return { key, title, artist: "Ivy Marlow", album: null, genre: null, bpm: 120, camelot: null, lengthSec: 90, rating: null, playCount: null, gridReady: true };
}

const ROWS = [row("a", "Amber Pier"), row("b", "Brass Meadow"), row("c", "Cobalt Steps")];

/** 120 BPM, bar 1 at 0: 16 bars are 32 s. */
const HINTS: PreviewHints = { cues: [{ kind: "memory", name: "Drop", startSec: 8 }], grid: { bpm: 120, barOneSec: 0 } };

function setUp() {
  const created: string[] = [];
  const revoked: string[] = [];
  const opened: string[] = [];
  const player = new PreviewPlayer({
    objectUrls: {
      create: (file) => {
        const url = URL.createObjectURL(file);
        created.push(url);
        return url;
      },
      revoke: (url) => {
        revoked.push(url);
        URL.revokeObjectURL(url);
      },
    },
    route: () => Promise.resolve({ kind: "default" }),
  });
  const preview = (each: LibraryRow): TrackPreview | null =>
    each.key === "c"
      ? null
      : {
          media: {
            kind: "file",
            read: () => {
              opened.push(each.key);
              return Promise.resolve(wavFile(`${each.title}.wav`, 90));
            },
          },
          hints: () => Promise.resolve(HINTS),
        };
  const view = render(<LibraryBrowser picker="test" rows={ROWS} emptyText="No tracks." controllerHint="" onLoad={() => undefined} preview={preview} player={player} />);
  return { player, created, revoked, opened, view };
}

const rowOf = (title: string) => screen.getByRole("listitem", { name: title });
const previewState = (title: string) => rowOf(title).dataset["preview"];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the mini player", () => {
  it("plays a row from its Drop cue, pauses and goes on, and opens no other row's file", async () => {
    const { player, opened } = setUp();
    expect(screen.getByTestId("preview-hint").textContent).toContain("Space on a track: preview");

    await userEvent.click(screen.getByRole("button", { name: "Play a preview of Amber Pier" }));
    await waitFor(() => {
      expect(previewState("Amber Pier")).toBe("playing");
    });
    expect(opened).toEqual(["a"]);
    expect(player.snapshot()).toMatchObject({ key: "a", durationSec: 90, jump: "16 bars" });
    expect(player.snapshot().positionSec).toBeGreaterThanOrEqual(8);
    expect(screen.getByTestId("preview-elapsed").textContent).toMatch(/^0:0[89] \/ 1:30$/);

    fireEvent.click(screen.getByRole("button", { name: "Pause the preview of Amber Pier" }));
    expect(previewState("Amber Pier")).toBe("paused");
    fireEvent.click(screen.getByRole("button", { name: "Play a preview of Amber Pier" }));
    await waitFor(() => {
      expect(previewState("Amber Pier")).toBe("playing");
    });
    // Resuming opens nothing again; Cobalt Steps has no preview and its ▶ is off.
    expect(opened).toEqual(["a"]);
    expect(screen.getByRole("button", { name: "Play a preview of Cobalt Steps" })).toHaveProperty("disabled", true);
  });

  it("plays one at a time: starting another stops the first and revokes its object URL; leaving revokes the last", async () => {
    const { created, revoked, opened, view } = setUp();
    await userEvent.click(screen.getByRole("button", { name: "Play a preview of Amber Pier" }));
    await waitFor(() => {
      expect(previewState("Amber Pier")).toBe("playing");
    });

    // Space with the ring on another row.
    const brass = rowOf("Brass Meadow");
    brass.focus();
    fireEvent.keyDown(brass, { key: " " });
    await waitFor(() => {
      expect(previewState("Brass Meadow")).toBe("playing");
    });
    expect(previewState("Amber Pier")).toBeUndefined();
    expect(opened).toEqual(["a", "b"]);
    expect(created).toHaveLength(2);
    expect(revoked).toEqual([created[0]]);
    expect(screen.getAllByTestId("mini-player")).toHaveLength(1);

    view.unmount();
    expect(revoked).toEqual(created);
  });

  it("from the FLX4: BROWSE press on a row plays and pauses it, SHIFT + BROWSE turn jumps 16 bars, ← / → too", async () => {
    const { player } = setUp();
    const navigator = new FocusNavigator(document);
    // One real click on the page first: browsers do not count MIDI as a gesture.
    await userEvent.click(screen.getByTestId("preview-hint"));
    rowOf("Amber Pier").focus();

    act(() => {
      navigator.select();
    });
    await waitFor(() => {
      expect(previewState("Amber Pier")).toBe("playing");
    });
    const start = player.snapshot().positionSec;

    act(() => {
      navigator.jump(1);
    });
    expect(player.snapshot().positionSec).toBeCloseTo(start + 32, 0);
    fireEvent.keyDown(rowOf("Amber Pier"), { key: "ArrowLeft" });
    expect(player.snapshot().positionSec).toBeCloseTo(start, 0);

    act(() => {
      navigator.select();
    });
    expect(previewState("Amber Pier")).toBe("paused");
  });

  it("seeks where the bar is tapped", async () => {
    const { player } = setUp();
    await userEvent.click(screen.getByRole("button", { name: "Play a preview of Amber Pier" }));
    await waitFor(() => {
      expect(previewState("Amber Pier")).toBe("playing");
    });
    const bar = screen.getByRole("slider", { name: "Where in Amber Pier" });
    const box = bar.getBoundingClientRect();
    fireEvent.click(bar, { clientX: box.left + box.width * 0.75, clientY: box.top + box.height / 2 });
    expect(player.snapshot().positionSec).toBeCloseTo(67.5, 0);
    // A tap on the bar is not a press of the row: it still plays.
    expect(previewState("Amber Pier")).toBe("playing");
  });

  it("with no preview playing, SHIFT + BROWSE turn moves the ring as BROWSE turn does", () => {
    setUp();
    const navigator = new FocusNavigator(document);
    rowOf("Amber Pier").focus();
    navigator.jump(1);
    expect(document.activeElement).not.toBe(rowOf("Amber Pier"));
  });
});
