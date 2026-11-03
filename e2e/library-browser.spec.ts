import { expect, test, type Page } from "@playwright/test";
import { ensureProfile, learner } from "./lesson-support.ts";

// The library browser (ISS-194) as the Mix plans track picker, by keyboard, then at phone width. The
// folder picker is replaced (init script) by an in-memory folder with a hand-written rekordbox.xml,
// so no real music and no real disk folder are involved. Every name below is invented.

const REKORDBOX_XML = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="7.0.0" Company="AlphaTheta"/>
  <COLLECTION Entries="4">
    <TRACK Name="Copper Tide" Artist="Mira Vale" Album="Low Sun" Genre="Deep House" AverageBpm="122.00" Tonality="Am" TotalTime="360" Rating="204" PlayCount="12"
      Location="file://localhost/Users/dj/Music/Mira%20Vale%20-%20Copper%20Tide.mp3"><TEMPO Inizio="0.05" Bpm="122.00" Metro="4/4" Battito="1"/></TRACK>
    <TRACK Name="Glass Orchard" Artist="Mira Vale" Genre="Deep House" AverageBpm="124.50" Tonality="9A" TotalTime="300"
      Location="file://localhost/Users/dj/Music/Mira%20Vale%20-%20Glass%20Orchard.mp3"><TEMPO Inizio="0.05" Bpm="124.50" Metro="4/4" Battito="1"/></TRACK>
    <TRACK Name="Low Lanterns" Artist="Otto Fenn" Genre="Techno" AverageBpm="132.00" Tonality="C" TotalTime="420"
      Location="file://localhost/Users/dj/Music/Otto%20Fenn%20-%20Low%20Lanterns.mp3"><TEMPO Inizio="0.05" Bpm="132.00" Metro="4/4" Battito="1"/></TRACK>
    <TRACK Name="Paper Comets" Artist="Juno Reyes-Park" Genre="Disco" AverageBpm="118.00" Tonality="3A" TotalTime="240"
      Location="file://localhost/Users/dj/Music/Juno%20Reyes-Park%20-%20Paper%20Comets.mp3"/>
  </COLLECTION>
</DJ_PLAYLISTS>`;

const FILES: Readonly<Record<string, string>> = {
  "Mira Vale - Copper Tide.mp3": "not music",
  "Mira Vale - Glass Orchard.mp3": "not music",
  "Otto Fenn - Low Lanterns.mp3": "not music",
  "Juno Reyes-Park - Paper Comets.mp3": "not music",
  "Nobody - Unknown Signal.mp3": "not music",
  "rekordbox.xml": REKORDBOX_XML,
};

/** Replaces the folder picker with an in-memory folder named "Music". */
async function stubPicker(page: Page, files: Readonly<Record<string, string>>): Promise<void> {
  await page.addInitScript((initial: Record<string, string>) => {
    const entries = Object.entries(initial).map(([name, text], index) => ({ name, text, lastModified: 1_700_000_000_000 + index * 1000 }));
    const root = {
      kind: "directory",
      name: "Music",
      async *values() {
        for (const entry of entries) {
          yield await Promise.resolve({ kind: "file", name: entry.name, getFile: () => Promise.resolve(new File([entry.text], entry.name, { lastModified: entry.lastModified })) });
        }
      },
      queryPermission: () => Promise.resolve("granted"),
      requestPermission: () => Promise.resolve("granted"),
    };
    Object.assign(window, { showDirectoryPicker: () => Promise.resolve(root) });
  }, files);
}

/** Picks the folder on the Controller page, then opens a new Mix plan, all without a reload (the folder is in memory). */
async function openNewPlan(page: Page, id: string): Promise<void> {
  await stubPicker(page, FILES);
  await ensureProfile(page, id);
  await page.goto(`/?learner=${id}`);
  await page.getByRole("link", { name: "Controller" }).click();
  const setting = page.getByRole("region", { name: "Music folder" });
  await setting.getByRole("button", { name: "Pick a folder" }).click();
  await expect(setting.getByTestId("rekordbox-status")).toHaveText("rekordbox: matched 4 of 5");
  await page.getByRole("button", { name: /Lessons/ }).click();
  await page.getByRole("button", { name: "Mix plans" }).click();
  await page.getByRole("button", { name: "New plan" }).click();
}

const browserRegion = (page: Page) => page.getByRole("region", { name: "Library browser" });
const tracks = (page: Page) => browserRegion(page).getByRole("list", { name: "Tracks" }).getByRole("listitem");
const playOrder = (page: Page) => page.locator("ol.plans-order > li");

test("Mix plans: browse the library by keyboard, sort, filter, browse by genre and pick tracks into the play order", async ({ page }) => {
  test.setTimeout(90_000);
  await openNewPlan(page, learner("library-browser"));
  const library = browserRegion(page);
  await expect(library.getByTestId("library-count")).toHaveText("5 tracks");
  // Sorted by title; the file rekordbox does not know shows only what its name says.
  await expect(tracks(page)).toHaveText([/Copper Tide/, /Glass Orchard/, /Low Lanterns/, /Paper Comets/, /Unknown Signal/]);
  await expect(tracks(page).first()).toContainText("8A · Am");
  await expect(tracks(page).first()).toContainText("122.0 BPM");
  await expect(tracks(page).last()).toContainText("BPM ?");

  // Sort by BPM, high to low: unknown last.
  const sort = library.getByLabel("Sort", { exact: true });
  await sort.focus();
  await sort.selectOption("bpm");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Space");
  await expect(tracks(page)).toHaveText([/Low Lanterns/, /Glass Orchard/, /Copper Tide/, /Paper Comets/, /Unknown Signal/]);

  // The search needs the keyboard, and says so while it has the ring.
  await library.getByLabel("Search the library").focus();
  await expect(library.getByTestId("library-typing")).toContainText("Typing needs the keyboard");
  await page.keyboard.type("mira");
  await expect(library.getByTestId("library-count")).toHaveText(/2 of 5 tracks/);
  await library.getByRole("button", { name: "Clear filters" }).click();
  await expect(library.getByTestId("library-count")).toHaveText("5 tracks");

  // Filters: a key with its compatible keys, then ± % of a BPM.
  await library.locator("summary", { hasText: "Filters" }).click();
  await library.getByLabel("Key filter").selectOption("8A");
  await library.getByLabel("and the keys that mix with it").check();
  await expect(tracks(page)).toHaveText([/Low Lanterns/, /Glass Orchard/, /Copper Tide/]);
  await library.getByLabel("BPM filter").selectOption("near");
  await library.getByLabel("BPM to mix with").selectOption("122");
  await library.getByLabel("How far from it").selectOption("2");
  await expect(tracks(page)).toHaveText([/Copper Tide/]);
  await library.getByRole("button", { name: "Clear filters" }).click();

  // Browse by genre: counts, Esc goes back, picking one filters the tracks and rings the first.
  const browseBy = library.getByLabel("Browse by");
  await browseBy.selectOption("genre");
  const genres = library.getByRole("list", { name: "Genres" }).getByRole("listitem");
  await expect(genres).toHaveText([/Every genre/, /Deep House\s*2/, /Disco\s*1/, /Techno\s*1/]);
  await genres.nth(1).focus();
  await page.keyboard.press("Escape");
  await expect(library.getByRole("list", { name: "Genres" })).toHaveCount(0);
  await expect(page.locator("main.plans-page")).toBeVisible();
  await browseBy.selectOption("genre");
  await genres.nth(1).focus();
  await page.keyboard.press("Enter");
  await expect(tracks(page)).toHaveText([/Glass Orchard/, /Copper Tide/]);
  await expect(tracks(page).first()).toBeFocused();

  // Pick by keyboard: Enter adds the row with the ring, ↓ moves on, Shift + Enter adds too.
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await expect(tracks(page).nth(1)).toBeFocused();
  await page.keyboard.press("Shift+Enter");
  await expect(playOrder(page)).toHaveText([/A · Glass Orchard/, /B · Copper Tide/]);
});

test("Mix plans at phone width: the browser fits the screen and a tap on + Add adds a track", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 360, height: 740 });
  await openNewPlan(page, learner("library-browser-phone"));
  const library = browserRegion(page);
  await expect(library.getByTestId("library-count")).toHaveText("5 tracks");

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  // Two lines a track: the title, then the artist, BPM, key and length.
  const first = tracks(page).first();
  await expect(first.locator(".lb-col-title")).toBeVisible();
  await expect(first.locator(".lb-col-key")).toBeVisible();
  await expect(first.locator(".lb-col-album")).toBeHidden();
  await first.getByRole("button", { name: "Add Copper Tide" }).click();
  await expect(playOrder(page)).toHaveText([/A · Copper Tide/]);
});
