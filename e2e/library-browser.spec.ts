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
      Location="file://localhost/Users/dj/Music/Mira%20Vale%20-%20Copper%20Tide.mp3"><TEMPO Inizio="0.05" Bpm="122.00" Metro="4/4" Battito="1"/><POSITION_MARK Name="Drop" Type="0" Start="24.000" Num="-1"/></TRACK>
    <TRACK Name="Glass Orchard" Artist="Mira Vale" Genre="Deep House" AverageBpm="124.50" Tonality="9A" TotalTime="300"
      Location="file://localhost/Users/dj/Music/Mira%20Vale%20-%20Glass%20Orchard.mp3"><TEMPO Inizio="0.05" Bpm="124.50" Metro="4/4" Battito="1"/></TRACK>
    <TRACK Name="Low Lanterns" Artist="Otto Fenn" Genre="Techno" AverageBpm="132.00" Tonality="C" TotalTime="420"
      Location="file://localhost/Users/dj/Music/Otto%20Fenn%20-%20Low%20Lanterns.mp3"><TEMPO Inizio="0.05" Bpm="132.00" Metro="4/4" Battito="1"/></TRACK>
    <TRACK Name="Paper Comets" Artist="Juno Reyes-Park" Genre="Disco" AverageBpm="118.00" Tonality="3A" TotalTime="240"
      Location="file://localhost/Users/dj/Music/Juno%20Reyes-Park%20-%20Paper%20Comets.mp3"/>
  </COLLECTION>
</DJ_PLAYLISTS>`;

/** A file the init script makes into a real WAV of this many seconds (a quiet tone), for the mini player. */
const WAV_SECONDS = "wav:120";

const FILES: Readonly<Record<string, string>> = {
  "Mira Vale - Copper Tide.mp3": WAV_SECONDS,
  "Mira Vale - Glass Orchard.mp3": WAV_SECONDS,
  "Otto Fenn - Low Lanterns.mp3": "not music",
  "Juno Reyes-Park - Paper Comets.mp3": "not music",
  "Nobody - Unknown Signal.mp3": "not music",
  "rekordbox.xml": REKORDBOX_XML,
};

/** Replaces the folder picker with an in-memory folder named "Music". A file whose text is "wav:N" is an N-second WAV. */
async function stubPicker(page: Page, files: Readonly<Record<string, string>>): Promise<void> {
  await page.addInitScript((initial: Record<string, string>) => {
    // 8 kHz mono 16-bit: a quiet 220 Hz tone. Chromium runs muted; nothing sounds.
    const wav = (seconds: number): ArrayBuffer => {
      const rate = 8000;
      const samples = seconds * rate;
      const bytes = new DataView(new ArrayBuffer(44 + samples * 2));
      const text = (at: number, value: string) => {
        for (let index = 0; index < value.length; index += 1) bytes.setUint8(at + index, value.charCodeAt(index));
      };
      text(0, "RIFF");
      bytes.setUint32(4, 36 + samples * 2, true);
      text(8, "WAVEfmt ");
      bytes.setUint32(16, 16, true);
      bytes.setUint16(20, 1, true);
      bytes.setUint16(22, 1, true);
      bytes.setUint32(24, rate, true);
      bytes.setUint32(28, rate * 2, true);
      bytes.setUint16(32, 2, true);
      bytes.setUint16(34, 16, true);
      text(36, "data");
      bytes.setUint32(40, samples * 2, true);
      for (let index = 0; index < samples; index += 1) bytes.setInt16(44 + index * 2, Math.round(1000 * Math.sin((2 * Math.PI * 220 * index) / rate)), true);
      return bytes.buffer;
    };
    const contents = new Map<string, BlobPart>();
    const contentOf = (text: string): BlobPart => {
      const known = contents.get(text);
      if (known !== undefined) return known;
      const made = text.startsWith("wav:") ? wav(Number(text.slice(4))) : text;
      contents.set(text, made);
      return made;
    };
    const entries = Object.entries(initial).map(([name, text], index) => ({ name, text, lastModified: 1_700_000_000_000 + index * 1000 }));
    const root = {
      kind: "directory",
      name: "Music",
      async *values() {
        for (const entry of entries) {
          yield await Promise.resolve({ kind: "file", name: entry.name, getFile: () => Promise.resolve(new File([contentOf(entry.text)], entry.name, { lastModified: entry.lastModified })) });
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

const trackRow = (page: Page, title: string) => tracks(page).filter({ hasText: title });
const whereIn = (page: Page, title: string) => trackRow(page, title).getByRole("slider", { name: `Where in ${title}` });
const secondsIn = async (page: Page, title: string) => Number(await whereIn(page, title).getAttribute("aria-valuenow"));

test("Mix plans: the mini player previews a track from its Drop cue, jumps 16 bars, seeks, and plays one at a time", async ({ page }) => {
  test.setTimeout(90_000);
  await openNewPlan(page, learner("library-preview"));
  const library = browserRegion(page);
  await expect(library.getByTestId("preview-hint")).toContainText("Space on a track: preview");

  // ▶ opens the file and plays from rekordbox's "Drop" memory cue at 0:24.
  const copper = trackRow(page, "Copper Tide");
  await copper.getByRole("button", { name: "Play a preview of Copper Tide" }).click();
  await expect(copper).toHaveAttribute("data-preview", "playing");
  await expect(copper.getByTestId("preview-elapsed")).toHaveText(/^0:2\d \/ 2:00$/);
  expect(await secondsIn(page, "Copper Tide")).toBeGreaterThanOrEqual(24);

  // → jumps 16 bars (122 BPM: 31.5 s), ← back.
  await copper.focus();
  const before = await secondsIn(page, "Copper Tide");
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => secondsIn(page, "Copper Tide")).toBeGreaterThanOrEqual(before + 30);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => secondsIn(page, "Copper Tide")).toBeLessThan(before + 10);

  // A click on the bar seeks there (90 % of 2:00 is 1:48).
  const bar = await whereIn(page, "Copper Tide").boundingBox();
  if (bar === null) throw new Error("the progress bar is not on screen");
  await page.mouse.click(bar.x + bar.width * 0.9, bar.y + bar.height / 2);
  await expect.poll(() => secondsIn(page, "Copper Tide")).toBeGreaterThanOrEqual(100);
  await expect(copper).toHaveAttribute("data-preview", "playing");

  // Space on another row: that one plays, the first stops; Space again pauses it.
  const glass = trackRow(page, "Glass Orchard");
  await glass.focus();
  await page.keyboard.press("Space");
  await expect(glass).toHaveAttribute("data-preview", "playing");
  await expect(copper).not.toHaveAttribute("data-preview");
  await expect(library.getByTestId("mini-player")).toHaveCount(1);
  await page.keyboard.press("Space");
  await expect(glass).toHaveAttribute("data-preview", "paused");

  // Picking still adds to the play order.
  await page.keyboard.press("Enter");
  await expect(playOrder(page)).toHaveText([/A · Glass Orchard/]);
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

  // A finger-sized ▶; the playing row's bar and time take its second line, and nothing scrolls sideways.
  const play = first.getByRole("button", { name: "Play a preview of Copper Tide" });
  const box = await play.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);
  await play.click();
  await expect(first).toHaveAttribute("data-preview", "playing");
  await expect(first.getByTestId("preview-elapsed")).toBeVisible();
  await expect(first.getByRole("slider", { name: "Where in Copper Tide" })).toBeVisible();
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(sideways).toBeLessThanOrEqual(0);
});

/** Right edges of the New plan card, the browser and its list; and how far the page scrolls sideways. */
async function edges(page: Page) {
  return page.evaluate(() => {
    const right = (selector: string) => {
      const element = document.querySelector(selector);
      if (element === null) throw new Error(`${selector} is not on the page`);
      return element.getBoundingClientRect().right;
    };
    const card = document.querySelector('section[aria-label="New plan"]');
    const inner = card === null ? 0 : card.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(card).paddingRight);
    return {
      card: inner,
      library: right('section[aria-label="Library browser"]'),
      list: right('section[aria-label="Library browser"] .lb-scroll'),
      sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
}

/** Each header's left edge against its cell's in the first drawn row, px apart. */
async function headerOffsets(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const row = document.querySelector("li[data-library]");
    return Object.fromEntries(
      Array.from(document.querySelectorAll<HTMLElement>(".lb-head [data-column]"), (head) => {
        const column = head.dataset["column"] ?? "";
        const cell = row?.querySelector(`.lb-col-${column}`);
        return [column, cell == null ? Number.POSITIVE_INFINITY : Math.abs(cell.getBoundingClientRect().left - head.getBoundingClientRect().left)];
      }),
    );
  });
}

async function expectInsideCard(page: Page): Promise<void> {
  const fits = await edges(page);
  expect(fits.library).toBeLessThanOrEqual(fits.card + 0.5);
  expect(fits.list).toBeLessThanOrEqual(fits.card + 0.5);
  expect(fits.sideways).toBeLessThanOrEqual(0);
}

// A 1440p monitor, at 100 % and at 150 % scaling: the page uses the width, the play order sits beside
// the library, and the browser has one row of columns with album and genre under aligned headers.
for (const { width, height } of [
  { width: 2560, height: 1440 },
  { width: 1707, height: 960 },
]) {
  test(`Mix plans at ${String(width)}×${String(height)}: one row of columns, headers over their cells, the play order beside the library`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height });
    await openNewPlan(page, learner(`library-browser-${String(width)}`));
    const library = browserRegion(page);
    await expect(library.getByTestId("library-count")).toHaveText("5 tracks");

    await expect(library).toHaveAttribute("data-layout", "wide");
    await expect(library.locator(".lb-head [data-column]")).toHaveText([/Title/, "Artist", "Album", "Genre", "BPM", "Key", "Length", "Rating", "Plays", "Grid"]);
    for (const [column, apart] of Object.entries(await headerOffsets(page))) expect(apart, column).toBeLessThanOrEqual(1);
    await expect(tracks(page).first().locator(".lb-col-album")).toHaveText("Low Sun");
    await expect(tracks(page).first().locator(".lb-col-genre")).toHaveText("Deep House");
    await expectInsideCard(page);

    // The play order to the left of the library, level with it.
    const order = await page.locator(".plans-new-order").boundingBox();
    const browser = await page.locator(".plans-new-library").boundingBox();
    if (order === null || browser === null) throw new Error("the play order or the library is not on screen");
    expect(order.x + order.width).toBeLessThanOrEqual(browser.x);
    expect(Math.abs(order.y - browser.y)).toBeLessThanOrEqual(1);

    // Picking still works from the keyboard, the FLX4's way: Enter on a row adds it.
    await tracks(page).first().focus();
    await page.keyboard.press("Enter");
    await expect(playOrder(page)).toHaveText([/A · Copper Tide/]);
  });
}

// A laptop and a narrow window: whichever layout fits, inside the card; headers aligned when shown.
for (const { width, height } of [
  { width: 1440, height: 900 },
  { width: 963, height: 1037 },
]) {
  test(`Mix plans at ${String(width)}×${String(height)}: the browser stays inside its card, and its rows match its header`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height });
    await openNewPlan(page, learner(`library-browser-${String(width)}`));
    const library = browserRegion(page);
    await expect(library.getByTestId("library-count")).toHaveText("5 tracks");
    await expectInsideCard(page);

    if ((await library.getAttribute("data-layout")) === "wide") {
      for (const [column, apart] of Object.entries(await headerOffsets(page))) expect(apart, column).toBeLessThanOrEqual(1);
    } else {
      // Two lines a track, and no column headers over them.
      await expect(library.locator(".lb-head")).toHaveCount(0);
    }

    // The filters open from a control that shows, and still fit the card.
    const toggle = library.locator("summary", { hasText: "Filters" });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(library.getByLabel("Genre filter")).toBeVisible();
    await expectInsideCard(page);
  });
}
