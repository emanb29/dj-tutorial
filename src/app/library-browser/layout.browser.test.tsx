// The library browser's layout in a real Chromium page, inside a card narrower than the window (the Mix
// plans page at about 963 px, a phone, a wide screen): it never spills past its card, it picks one row
// of columns or two lines from its own width (not the window's), and the header's columns sit over the
// rows' cells. Invented tracks only.
import { act, cleanup, render, screen } from "@testing-library/react";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FocusNavigator } from "../controller/focus-navigation.ts";
import "../theme.css";
import type { LibraryRow } from "./browse.ts";
import { LibraryBrowser } from "./LibraryBrowser.tsx";

const frames = async (count = 3) => {
  for (let index = 0; index < count; index += 1) await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => { resolve(); })));
};

function row(key: string, extra: Partial<LibraryRow> = {}): LibraryRow {
  return { key, title: key, artist: null, album: null, genre: null, bpm: null, camelot: null, lengthSec: null, rating: null, playCount: null, gridReady: false, ...extra };
}

const ARTISTS = ["Mira Vale", "Otto Fenn", "Juno Reyes-Park", "Cinder & Ash"];
const GENRES = ["Deep House", "Melodic House & Techno", "Disco", "UK Garage"];

/** A library like a real one: albums and genres on some tracks, ratings and plays on none. */
const LIBRARY: readonly LibraryRow[] = Array.from({ length: 120 }, (_, index) =>
  row(`t${String(index).padStart(3, "0")}`, {
    title: `Glass Orchard ${String(index)}${index % 5 === 0 ? " (Extended Mix)" : ""}`,
    artist: ARTISTS[index % ARTISTS.length] ?? null,
    album: index % 3 === 0 ? "Low Sun EP" : null,
    genre: index % 4 === 1 ? null : (GENRES[index % GENRES.length] ?? null),
    bpm: 118 + (index % 14) + 0.5,
    camelot: index % 2 === 0 ? "12A" : "8B",
    lengthSec: 200 + index,
    gridReady: index % 2 === 0,
  }),
);

/** The browser in a card `cardPx` wide, in a window `windowPx` wide, with two buttons a row (→ A, → B). */
async function inCard(windowPx: number, cardPx: number, rows: readonly LibraryRow[] = LIBRARY) {
  await page.viewport(windowPx, 900);
  render(
    <div data-testid="card" style={{ width: `${String(cardPx)}px`, padding: "16px", boxSizing: "border-box", display: "grid" }}>
      <LibraryBrowser
        picker="layout"
        rows={rows}
        emptyText="No tracks."
        controllerHint="LOAD A or LOAD B loads it"
        onLoad={() => undefined}
        actions={(each) => (
          <>
            <button type="button" className="btn" tabIndex={-1} data-nav-skip aria-label={`Load ${each.title} onto deck A`}>
              → A
            </button>
            <button type="button" className="btn" tabIndex={-1} data-nav-skip aria-label={`Load ${each.title} onto deck B`}>
              → B
            </button>
          </>
        )}
      />
    </div>,
  );
  await frames();
  const card = screen.getByTestId("card");
  const browser = screen.getByRole("region", { name: "Library browser" });
  return { card, browser };
}

const right = (element: Element) => element.getBoundingClientRect().right;
const left = (element: Element) => element.getBoundingClientRect().left;

/** Everything drawn in the browser that sticks out past the card's inner edge, by class and px. */
function spills(card: HTMLElement, browser: HTMLElement): string[] {
  const edge = right(card) - Number.parseFloat(getComputedStyle(card).paddingRight) + 0.5;
  return [browser, ...browser.querySelectorAll<HTMLElement>("*")]
    .filter((element) => element.getClientRects().length > 0 && right(element) > edge)
    .map((element) => `${element.tagName.toLowerCase()}.${element.className}${element.hasAttribute("aria-label") ? ` "${element.getAttribute("aria-label") ?? ""}"` : ""} by ${String(Math.round(right(element) - edge))} px`);
}

const header = (browser: HTMLElement) => browser.querySelector<HTMLElement>(".lb-head");
const firstRow = (browser: HTMLElement) => browser.querySelector<HTMLElement>("li[data-library]");

beforeEach(() => {
  localStorage.clear();
});

afterEach(async () => {
  cleanup();
  await page.viewport(414, 896);
});

describe("in a card narrower than the window", () => {
  it("stays inside a 670 px card in a 963 px window: no part of it sticks out, and nothing scrolls sideways", async () => {
    const { card, browser } = await inCard(963, 670);

    expect(spills(card, browser)).toEqual([]);
    expect(browser.scrollWidth).toBeLessThanOrEqual(browser.clientWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth);

    // With the filters open too (a genre's long name in its list).
    screen.getByText(/^Filters/, { selector: "summary" }).click();
    await frames();
    expect(spills(card, browser)).toEqual([]);
  });

  it("chooses its layout from its own width, not the window's: two lines in that card, with no header over them", async () => {
    const { browser } = await inCard(963, 670);

    expect(browser.dataset["layout"]).toBe("narrow");
    expect(header(browser)).toBeNull();
    const cells = firstRow(browser);
    if (cells === null) throw new Error("no row was drawn");
    const title = cells.querySelector(".lb-col-title");
    const artist = cells.querySelector(".lb-col-artist");
    if (title === null || artist === null) throw new Error("the row has no title or artist");
    // The title on line 1, the artist under it.
    expect(artist.getBoundingClientRect().top).toBeGreaterThan(title.getBoundingClientRect().bottom - 1);
  });

  it("at phone width, stays inside its card, in two lines", async () => {
    const { card, browser } = await inCard(360, 360);

    expect(browser.dataset["layout"]).toBe("narrow");
    expect(spills(card, browser)).toEqual([]);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth);
    screen.getByText(/^Filters/, { selector: "summary" }).click();
    await frames();
    expect(spills(card, browser)).toEqual([]);
  });
});

describe("one row of columns, when they fit", () => {
  it("puts each header over its column in every drawn row, and stays inside its card", async () => {
    const { card, browser } = await inCard(1440, 1300);

    expect(browser.dataset["layout"]).toBe("wide");
    expect(spills(card, browser)).toEqual([]);
    const head = header(browser);
    if (head === null) throw new Error("no header in the wide layout");
    const columns = [...head.querySelectorAll<HTMLElement>("[data-column]")];
    expect(columns.map((each) => each.dataset["column"])).toEqual(["title", "artist", "album", "genre", "bpm", "key", "length", "gridReady"]);
    const rows = [...browser.querySelectorAll<HTMLElement>("li[data-library]")].slice(0, 5);
    expect(rows.length).toBe(5);
    for (const each of rows) {
      for (const column of columns) {
        const cell = each.querySelector<HTMLElement>(`.lb-col-${column.dataset["column"] ?? ""}`);
        if (cell === null) throw new Error(`row ${each.dataset["library"] ?? ""} has no ${column.dataset["column"] ?? ""} cell`);
        expect(Math.abs(left(cell) - left(column)), `${column.dataset["column"] ?? ""} in ${each.dataset["library"] ?? ""}`).toBeLessThanOrEqual(1);
        // One line: every cell on the row's first line.
        expect(cell.getBoundingClientRect().top - each.getBoundingClientRect().top).toBeLessThan(28);
      }
    }
  });

  it("switches when its card is resized, with the window left as it is", async () => {
    const { card, browser } = await inCard(1440, 1300);
    expect(browser.dataset["layout"]).toBe("wide");

    card.style.width = "600px";
    await frames();
    expect(browser.dataset["layout"]).toBe("narrow");
    expect(spills(card, browser)).toEqual([]);

    card.style.width = "1300px";
    await frames();
    expect(browser.dataset["layout"]).toBe("wide");
  });
});

describe("columns no track fills", () => {
  it("leaves out Rating and Plays, header and cells, when no track has either, and shows them when one does", async () => {
    const { browser } = await inCard(1440, 1300);
    expect(browser.querySelector('.lb-head [data-column="rating"]')).toBeNull();
    expect(browser.querySelector('.lb-head [data-column="playCount"]')).toBeNull();
    expect(browser.querySelector("li[data-library] .lb-col-rating")).toBeNull();
    expect(browser.querySelector("li[data-library] .lb-col-playCount")).toBeNull();
    expect([...screen.getByLabelText<HTMLSelectElement>("Sort").options].map((option) => option.value)).not.toContain("rating");
    cleanup();

    const rated = [row("rated", { title: "Rated one", rating: 4, playCount: 7 }), ...LIBRARY.slice(0, 10)];
    const again = await inCard(1440, 1300, rated);
    expect(again.browser.querySelector('.lb-head [data-column="rating"]')).not.toBeNull();
    expect(again.browser.querySelector('.lb-head [data-column="playCount"]')).not.toBeNull();
  });
});

describe("the filters", () => {
  it("are folded behind a control that shows, and that BROWSE reaches and opens", async () => {
    await inCard(963, 670);
    const toggle = screen.getByText(/^Filters/, { selector: "summary" });
    const box = toggle.getBoundingClientRect();
    expect(box.width).toBeGreaterThan(40);
    expect(box.height).toBeGreaterThanOrEqual(44);
    // It looks like something to press: a border and an arrow that says it opens.
    expect(getComputedStyle(toggle).borderTopStyle).not.toBe("none");
    expect(getComputedStyle(toggle, "::before").content).toContain("▸");
    expect(screen.queryByLabelText("BPM filter")).not.toBeVisible();

    const navigator = new FocusNavigator(document);
    screen.getByLabelText("Sort").focus();
    navigator.move(1); // the sort direction
    navigator.move(1);
    expect(document.activeElement).toBe(toggle);
    act(() => {
      navigator.select();
    });
    expect(screen.getByLabelText("BPM filter")).toBeVisible();
    expect(getComputedStyle(toggle, "::before").content).toContain("▾");
  });
});
