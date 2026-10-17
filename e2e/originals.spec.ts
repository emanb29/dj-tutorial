import { appendFile, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

// The Originals player (/originals), muted, against its own API and preview (4182/4181 by default, in
// playwright.config.ts) serving a tiny fixture folder this file writes: three 20-second quiet tracks
// in two genres. A fourth is added mid-test to check the page picks it up without a reload.
// Screenshots land in test-results/originals-*.png.

const BASE = process.env["E2E_ORIGINALS_BASE_URL"];
if (BASE === undefined) throw new Error("E2E_ORIGINALS_BASE_URL is unset: run through npm run test:e2e (playwright.config.ts sets it).");
const fixtureDir = process.env["E2E_ORIGINALS_DIR"];
if (fixtureDir === undefined) throw new Error("E2E_ORIGINALS_DIR is unset: run through npm run test:e2e (playwright.config.ts sets it).");
const root = join(fixtureDir, "originals");
const MP3 = join(import.meta.dirname, "fixtures", "original.mp3");

const track = (id: string, title: string, genre: string, subgenre: string, topic: string) => ({
  id,
  title,
  topic,
  genre,
  subgenre,
  bpm: 124,
  key: "A minor",
  camelot: "8A",
  durationSec: 20,
  bars: 3,
  introBars: 1,
  outroBars: 1,
});

async function addTrack(entry: ReturnType<typeof track>): Promise<void> {
  const folder = `${entry.id}-${entry.title.toLowerCase().replaceAll(" ", "-")}`;
  await mkdir(join(root, folder), { recursive: true });
  await copyFile(MP3, join(root, folder, "track.mp3"));
  await writeFile(join(root, folder, "meta.json"), JSON.stringify({ ...entry, firstDownbeatSec: 0, phrases: [] }));
  await appendFile(join(root, "index.jsonl"), `${JSON.stringify({ ...entry, path: `/elsewhere/${folder}` })}\n`);
}

async function noHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "the page scrolls sideways").toBeLessThanOrEqual(0);
}

test.beforeEach(async () => {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  await addTrack(track("001", "Lamplight Moths", "house", "deep house", "moths circling a streetlamp on a warm night"));
  await addTrack(track("002", "Rink Lights Return", "techno", "peak time", "a roller rink reopening after a long winter"));
  await addTrack(track("003", "Calving Season", "house", "afro house", "a glacier calving into a fjord at dawn"));
});

const sizes = [
  { name: "phone", viewport: { width: 412, height: 915 }, touch: true },
  { name: "laptop", viewport: { width: 1440, height: 900 }, touch: false },
] as const;

for (const size of sizes) {
  test.describe(`at ${size.name} size (${String(size.viewport.width)}×${String(size.viewport.height)})`, () => {
    test.use({ viewport: size.viewport, hasTouch: size.touch, isMobile: size.touch, baseURL: BASE });

    test("lists the Originals newest first, plays one, and picks up a new one without a reload", async ({ page }) => {
      await page.clock.install();
      await page.goto("/originals");

      const list = page.getByRole("list", { name: "Originals" });
      const rows = list.getByRole("listitem");
      await expect(rows).toHaveCount(3);
      await expect(page.getByLabel("Track count")).toHaveText("3 tracks");
      await expect(rows.first()).toContainText("Calving Season");
      await expect(rows.first()).toContainText("a glacier calving into a fjord at dawn");
      await expect(rows.first()).toContainText("house · afro house");
      await expect(rows.first()).toContainText("124 BPM");
      await expect(rows.first()).toContainText("A minor · 8A");
      await expect(rows.first()).toContainText("0:20");
      // Touch screens get tap controls and no key hints; a laptop gets both.
      await expect(page.getByLabel("Keyboard shortcuts")).toHaveCount(size.touch ? 0 : 1);
      await expect(page.getByRole("button", { name: "Next track" })).toBeVisible();
      await noHorizontalScroll(page);

      // Every control is at least 44 px.
      for (const control of await page.locator(".originals button, .originals input").all()) {
        const box = await control.boundingBox();
        expect(box?.height ?? 0, await control.evaluate((element) => element.outerHTML.slice(0, 80))).toBeGreaterThanOrEqual(44);
      }

      await page.screenshot({ path: `test-results/originals-${size.name}-list.png` });

      // Play the newest track: the <audio> element starts (Chromium runs with --mute-audio).
      await rows.first().getByRole("button", { name: "Play Calving Season" }).click();
      await expect.poll(() => page.evaluate(() => document.querySelector("audio")?.paused)).toBe(false);
      await expect(page.locator("audio")).toHaveAttribute("src", "/api/originals/003/audio");
      await expect(page.getByRole("region", { name: "Now playing" })).toContainText("003 · Calving Season");
      await expect(rows.first().getByRole("button", { name: "Pause Calving Season" })).toBeVisible();

      // The composer finishes a track; the next poll (fast-forwarded past 20 s) shows it at the top.
      await addTrack(track("004", "Mind the Pigeons", "techno", "minimal", "pigeons commuting on the underground"));
      await page.clock.fastForward(21_000);
      await expect(rows).toHaveCount(4);
      await expect(rows.first()).toContainText("Mind the Pigeons");
      await expect(rows.first().getByText("new", { exact: true })).toBeVisible();
      await expect(page.getByLabel("Track count")).toHaveText("4 tracks");
      // The update did not interrupt playback.
      expect(await page.evaluate(() => document.querySelector("audio")?.paused)).toBe(false);
      await expect(page.locator("audio")).toHaveAttribute("src", "/api/originals/003/audio");
      await noHorizontalScroll(page);
      await page.waitForTimeout(500);
      await page.screenshot({ path: `test-results/originals-${size.name}-playing.png`, fullPage: true });
    });

    test("filters by genre and moves to the next track", async ({ page }) => {
      await page.goto("/originals");
      const rows = page.getByRole("list", { name: "Originals" }).getByRole("listitem");
      await expect(rows).toHaveCount(3);

      await page.getByRole("group", { name: "Filter by genre" }).getByRole("button", { name: "house" }).click();
      await expect(rows).toHaveCount(2);
      await expect(page.getByLabel("Track count")).toHaveText("2 of 3");

      await page.getByRole("button", { name: "Next track" }).click();
      await expect(page.locator("audio")).toHaveAttribute("src", "/api/originals/003/audio");
      await page.getByRole("button", { name: "Next track" }).click();
      await expect(page.locator("audio")).toHaveAttribute("src", "/api/originals/001/audio");
      await expect.poll(() => page.evaluate(() => document.querySelector("audio")?.paused)).toBe(false);
      await expect(page.getByLabel("Elapsed")).not.toHaveText("0:00", { timeout: 5000 });

      // When a track ends, the next one down plays.
      await page.getByRole("button", { name: "Previous track" }).click();
      await expect(page.locator("audio")).toHaveAttribute("src", "/api/originals/003/audio");
      await expect.poll(() => page.evaluate(() => Number.isFinite(document.querySelector("audio")?.duration))).toBe(true);
      await page.evaluate(() => {
        const audio = document.querySelector("audio");
        if (audio !== null) audio.currentTime = audio.duration - 0.3;
      });
      await expect(page.locator("audio")).toHaveAttribute("src", "/api/originals/001/audio", { timeout: 5000 });

      if (!size.touch) {
        await page.keyboard.press("KeyK");
        await expect(page.locator("audio")).toHaveAttribute("src", "/api/originals/003/audio");
        await page.locator("body").click({ position: { x: 1, y: 1 } });
        await page.keyboard.press("Space");
        await expect.poll(() => page.evaluate(() => document.querySelector("audio")?.paused)).toBe(true);
        await page.keyboard.press("KeyJ");
        await expect(page.locator("audio")).toHaveAttribute("src", "/api/originals/001/audio");
      }
    });
  });
}

test("says how to fix it when the API isn't answering", async ({ page }) => {
  await page.route("**/api/originals", (route) => route.fulfill({ status: 502, body: "" }));
  await page.goto(`${BASE}/originals`);

  await expect(page.getByRole("alert")).toContainText("The API isn't answering.");
  await expect(page.getByRole("alert")).toContainText("npm run dev");
});
