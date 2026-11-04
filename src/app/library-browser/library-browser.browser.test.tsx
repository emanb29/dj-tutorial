// The library browser in a real Chromium page: it draws only the rows in view of a 10,000-track folder,
// reads no file and decodes nothing while it lists, filters and sorts, and works from the keyboard and
// from the FLX4's BROWSE and LOAD (through the app's own FocusNavigator, as ControllerNavigation drives it).
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FocusNavigator } from "../controller/focus-navigation.ts";
import type { LibraryRow } from "./browse.ts";
import { folderRows } from "./folder-rows.ts";
import { LibraryBrowser, type Deck } from "./LibraryBrowser.tsx";
import { storageKey } from "./remembered.ts";
import { LARGE_LIBRARY_SIZE, largeLibrary, type LargeLibrary } from "./test-support.ts";

/** Lets scrolling and React's renders settle, as the time between two BROWSE detents does. */
const frames = async (count = 2) => {
  for (let index = 0; index < count; index += 1) await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => { resolve(); })));
};

const drawnRows = () => document.querySelectorAll("li[data-library]");
const focusedRow = () => (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("li[data-library]") ?? null;

function row(key: string, extra: Partial<LibraryRow> = {}): LibraryRow {
  return { key, title: key, artist: null, album: null, genre: null, bpm: null, camelot: null, lengthSec: null, rating: null, playCount: null, gridReady: false, ...extra };
}

const SMALL: readonly LibraryRow[] = [
  row("b", { title: "Brass Meadow", artist: "Ivy Marlow", genre: "House", bpm: 124, camelot: "8A" }),
  row("a", { title: "Amber Pier", artist: "Ivy Marlow", genre: "Techno", bpm: 130, camelot: "9A" }),
  row("c", { title: "Cobalt Steps", artist: "Rafe Linden", genre: "House", bpm: 122, camelot: "3B" }),
];

function browser(rows: readonly LibraryRow[], picker = "test") {
  const loads: [string, Deck][] = [];
  const view = render(
    <>
      <button type="button">Before</button>
      <LibraryBrowser
        picker={picker}
        rows={rows}
        navStart
        emptyText="No tracks."
        controllerHint="LOAD A or LOAD B adds it"
        onLoad={(picked, deck) => {
          loads.push([picked.title, deck]);
        }}
      />
      <button type="button">After</button>
    </>,
  );
  return { loads, view };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("a 10,000-track library on screen", () => {
  // The slow step is the set-up, not the browser: writing, scanning and matching 10,000 files to a
  // rekordbox.xml takes 3–4 s alone and 20 s under load (measured), and each test built it again inside
  // its 15 s browser-test timeout. It is built once, in a hook with its own budget; the tests only read
  // it, and each still checks that its browsing opened no file and decoded nothing beyond the scan.
  // The browsing itself takes under 1 s alone and about 2.5 s under load; under a load average of 25 the
  // page has still stalled for several seconds right after the set-up (likely collecting its garbage),
  // so each test also gets 30 s, twice the default.
  const LOADED_TIMEOUT_MS = 30_000;
  let library: LargeLibrary;
  beforeAll(async () => {
    library = await largeLibrary();
  }, 60_000);

  it("draws only the rows in view, and lists, searches and sorts with no file read and nothing decoded", async () => {
    const { music, folder, decoded, openedByScan } = library;
    browser(folderRows(music));

    expect(screen.getByTestId("library-count").textContent).toContain(`${LARGE_LIBRARY_SIZE.toLocaleString()} tracks`);
    expect(drawnRows().length).toBeGreaterThan(0);
    expect(drawnRows().length).toBeLessThan(60);

    fireEvent.change(screen.getByLabelText("Search the library"), { target: { value: "artist 7" } });
    expect(screen.getByTestId("library-count").textContent).toMatch(/^[\d,]+ of 10,000 tracks/);
    fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "bpm" } });
    fireEvent.click(screen.getByRole("button", { name: /Sorted low to high/ }));
    fireEvent.change(screen.getByLabelText("Browse by"), { target: { value: "genre" } });
    expect(screen.getByRole("list", { name: "Genres" }).querySelectorAll("li").length).toBeGreaterThan(1);
    await frames();

    expect(drawnRows().length + document.querySelectorAll("li[data-facet]").length).toBeLessThan(60);
    expect(folder.opened).toBe(openedByScan);
    expect(decoded).toEqual([]);
  }, LOADED_TIMEOUT_MS);

  it("scrolls to the end and back from the keyboard, drawing the rows it reaches", async () => {
    const { music, folder, decoded, openedByScan } = library;
    browser(folderRows(music));
    const first = drawnRows()[0] as HTMLElement;
    first.focus();

    fireEvent.keyDown(first, { key: "End" });
    await frames();
    expect(focusedRow()?.dataset["index"]).toBe(String(LARGE_LIBRARY_SIZE - 1));
    expect(drawnRows().length).toBeLessThan(60);

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Home" });
    await frames();
    expect(focusedRow()?.dataset["index"]).toBe("0");
    expect(folder.opened).toBe(openedByScan);
    expect(decoded).toEqual([]);
  }, LOADED_TIMEOUT_MS);
});

describe("the keyboard", () => {
  it("moves through the rows with ↑ / ↓ and picks with Enter (A) and Shift + Enter (B)", async () => {
    const { loads } = browser(SMALL);
    const rows = [...drawnRows()] as HTMLElement[];
    expect(rows.map((each) => each.getAttribute("aria-label"))).toEqual(["Amber Pier", "Brass Meadow", "Cobalt Steps"]);
    const first = rows[0];
    if (first === undefined) throw new Error("no row was drawn");
    first.focus();

    fireEvent.keyDown(first, { key: "ArrowDown" });
    await frames();
    expect(focusedRow()?.getAttribute("aria-label")).toBe("Brass Meadow");
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Enter" });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Enter", shiftKey: true });

    expect(loads).toEqual([
      ["Brass Meadow", "A"],
      ["Brass Meadow", "B"],
    ]);
  });

  it("keeps the arrow keys from the page (the decks' keys) while the ring is on a row", () => {
    browser(SMALL);
    const heard: string[] = [];
    window.addEventListener("keydown", (event) => heard.push(event.key), { once: true });
    const first = drawnRows()[0] as HTMLElement;
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(heard).toEqual([]);
  });

  it("says the search box needs the keyboard while the ring is on it", () => {
    browser(SMALL);
    expect(screen.queryByTestId("library-typing")).toBeNull();
    fireEvent.focus(screen.getByLabelText("Search the library"));
    expect(screen.getByTestId("library-typing").textContent).toContain("Typing needs the keyboard or the screen");
  });
});

describe("the FLX4", () => {
  it("starts on the first row, turns through every row past the ones drawn at first, and LOAD A / LOAD B pick", async () => {
    const rows = Array.from({ length: 200 }, (_, index) => row(`t${String(index).padStart(3, "0")}`, { title: `Tune ${String(index).padStart(3, "0")}` }));
    const { loads } = browser(rows);
    const navigator = new FocusNavigator(document);
    const drawnAtFirst = drawnRows().length;
    expect(drawnAtFirst).toBeLessThan(rows.length);

    navigator.move(1);
    expect(focusedRow()?.getAttribute("aria-label")).toBe("Tune 000");
    for (let detent = 1; detent <= drawnAtFirst + 10; detent += 1) {
      navigator.move(1);
      await frames();
      expect(focusedRow()?.getAttribute("aria-label")).toBe(`Tune ${String(detent).padStart(3, "0")}`);
    }

    navigator.load("A", "Enter");
    navigator.load("B", "KeyR");
    const at = `Tune ${String(drawnAtFirst + 10).padStart(3, "0")}`;
    expect(loads).toEqual([
      [at, "A"],
      [at, "B"],
    ]);
  });

  it("opens a facet list from Browse by, picks a value with BROWSE press, and SHIFT + BROWSE goes back", async () => {
    browser(SMALL);
    const navigator = new FocusNavigator(document);
    const browseBy = screen.getByLabelText("Browse by");
    browseBy.focus();

    navigator.select();
    navigator.move(1);
    expect((browseBy as HTMLSelectElement).value).toBe("artist");
    act(() => {
      navigator.select();
    });
    const artists = screen.getByRole("list", { name: "Artists" });
    expect([...artists.querySelectorAll("li")].map((each) => each.getAttribute("aria-label"))).toEqual(["Every artist", "Ivy Marlow, 2 tracks", "Rafe Linden, 1 track"]);

    // SHIFT + BROWSE: back to the tracks, the ring on Browse by.
    act(() => {
      navigator.key("Escape");
    });
    expect(screen.queryByRole("list", { name: "Artists" })).toBeNull();
    expect(document.activeElement).toBe(browseBy);

    fireEvent.change(browseBy, { target: { value: "artist" } });
    screen.getByRole("listitem", { name: "Ivy Marlow, 2 tracks" }).focus();
    act(() => {
      navigator.select();
    });
    await frames();
    expect([...drawnRows()].map((each) => each.getAttribute("aria-label"))).toEqual(["Amber Pier", "Brass Meadow"]);
    expect(focusedRow()?.getAttribute("aria-label")).toBe("Amber Pier");
  });
});

describe("remembered per picker", () => {
  it("opens with the filter and sort the Learner left, and another picker keeps its own", () => {
    browser(SMALL, "mix-plans");
    fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "bpm" } });
    fireEvent.change(screen.getByLabelText("Search the library"), { target: { value: "house" } });
    cleanup();

    browser(SMALL, "mix-plans");
    expect(screen.getByLabelText<HTMLSelectElement>("Sort").value).toBe("bpm");
    expect([...drawnRows()].map((each) => each.getAttribute("aria-label"))).toEqual(["Cobalt Steps", "Brass Meadow"]);
    cleanup();

    browser(SMALL, "freestyle");
    expect(screen.getByLabelText<HTMLSelectElement>("Sort").value).toBe("title");
    expect(localStorage.getItem(storageKey("freestyle"))).not.toBeNull();
  });
});
