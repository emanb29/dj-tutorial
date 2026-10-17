import { expect, test, type Page } from "@playwright/test";

// The dev playground exposes its engine and a command log on window.learnToDjPlayground.
interface LoggedCommand {
  readonly command: { readonly control: string; readonly deck?: string; readonly value?: unknown };
  readonly device: string;
  readonly gestureEnd: boolean;
  readonly rejected: unknown;
}

interface PlaygroundWindow {
  learnToDjPlayground?: {
    engine: { deckState(deck: "A" | "B"): { playing: boolean } };
    commands: LoggedCommand[];
  };
}

/** Production builds serve the playground only with the explicit `playground` flag. */
async function openPlayground(page: Page, options = ""): Promise<void> {
  await page.goto(`/playground?playground${options === "" ? "" : `&${options}`}`);
  await page.waitForFunction(() => (window as PlaygroundWindow).learnToDjPlayground !== undefined);
}

function commands(page: Page): Promise<LoggedCommand[]> {
  return page.evaluate(() => (window as PlaygroundWindow).learnToDjPlayground?.commands.map((entry) => ({ ...entry })) ?? []);
}

function deckPlaying(page: Page, deck: "A" | "B"): Promise<boolean> {
  return page.evaluate((which) => (window as PlaygroundWindow).learnToDjPlayground?.engine.deckState(which).playing ?? false, deck);
}

/** Drags vertically from the middle of an element by `dy` pixels in small steps, as a hand would. */
async function dragVertically(page: Page, label: string, dy: number): Promise<void> {
  const box = await page.getByRole("slider", { name: label, exact: true }).boundingBox();
  if (box === null) throw new Error(`The "${label}" slider has no box; is it rendered?`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + dy, { steps: 8 });
  await page.mouse.up();
}

test("the playground renders both decks and the mixer, all unlocked", async ({ page }) => {
  await openPlayground(page);

  await expect(page.getByRole("region", { name: "Deck A" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Mixer" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Deck B" })).toBeVisible();
  await expect(page.getByRole("slider", { name: "CROSSFADER" })).toBeVisible();
  await expect(page.locator('[data-locked="true"]')).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "Keyboard keys" })).toBeVisible();
});

test("the X key plays deck A and the play button lights", async ({ page }) => {
  await openPlayground(page);
  expect(await deckPlaying(page, "A")).toBe(false);

  await page.keyboard.press("KeyX");

  await expect(page.getByRole("button", { name: "Deck A play/pause" })).toHaveAttribute("aria-pressed", "true");
  expect(await deckPlaying(page, "A")).toBe(true);
  const sent = await commands(page);
  expect(sent.at(-1)).toMatchObject({ command: { control: "play", deck: "A" }, device: "keyboard", rejected: null });
});

test("dragging a channel fader sends fader commands and ends with gestureEnd", async ({ page }) => {
  await openPlayground(page);

  await dragVertically(page, "CH A", 60);

  const fader = (await commands(page)).filter((entry) => entry.command.control === "channel-fader" && entry.command.deck === "A");
  expect(fader.length).toBeGreaterThanOrEqual(3);
  expect(fader.slice(0, -1).every((entry) => !entry.gestureEnd)).toBe(true);
  expect(fader.at(-1)?.gestureEnd).toBe(true);
  expect(fader.every((entry) => entry.device === "mouse" && entry.rejected === null)).toBe(true);
  // Dragging down closes the fader from fully open.
  expect(fader.at(-1)?.command.value).toBeLessThan(1);
});

test("the ? key toggles the key legend", async ({ page }) => {
  await openPlayground(page);
  const legend = page.getByRole("complementary", { name: "Keyboard keys" });

  await page.keyboard.press("Slash");
  await expect(legend).toHaveCount(0);
  await page.keyboard.press("Slash");
  await expect(legend).toBeVisible();
});

test("locked controls are dimmed and ignore keys, drags and clicks", async ({ page }) => {
  await openPlayground(page, "unlocks=A.play");

  await expect(page.locator('[data-control="B.play"]')).toHaveAttribute("data-locked", "true");
  await expect(page.locator('[data-control="A.play"]')).toHaveAttribute("data-locked", "false");

  await page.keyboard.press("Comma");
  await page.keyboard.press("KeyS");
  await dragVertically(page, "CH A", 60);
  const playB = await page.locator('[data-control="B.play"]').boundingBox();
  if (playB === null) throw new Error("Deck B's play button has no box.");
  await page.mouse.click(playB.x + playB.width / 2, playB.y + playB.height / 2);

  expect(await commands(page)).toEqual([]);
  expect(await deckPlaying(page, "B")).toBe(false);

  // The unlocked control still works.
  await page.keyboard.press("KeyX");
  expect(await deckPlaying(page, "A")).toBe(true);
});

test("Space still taps after clicking PLAY, instead of pressing PLAY again (H1)", async ({ page }) => {
  await openPlayground(page);

  await page.getByRole("button", { name: "Deck A play/pause" }).click();
  await page.keyboard.press("Space");

  const sent = (await commands(page)).map((entry) => entry.command.control);
  expect(sent).toEqual(["play", "tap"]);
  expect(await deckPlaying(page, "A")).toBe(true);
});

test("a held CUE key is released when the window loses focus (H3)", async ({ page }) => {
  await openPlayground(page);

  await page.keyboard.down("KeyZ");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));

  const cue = (await commands(page)).filter((entry) => entry.command.control === "deck-cue");
  expect(cue.map((entry) => [entry.command.value, entry.gestureEnd])).toEqual([
    [true, false],
    [false, true],
  ]);
  await page.keyboard.up("KeyZ");
  expect((await commands(page)).filter((entry) => entry.command.control === "deck-cue")).toHaveLength(2);
});

// Screenshots for the docs, taken only on request: SCREENSHOTS=1 npm run test:e2e -- -g screenshot
for (const [width, height] of [
  [1440, 900],
  [1280, 800],
] as const) {
  test(`screenshot of the playground at ${String(width)}×${String(height)}`, async ({ page }) => {
    test.skip(process.env["SCREENSHOTS"] === undefined, "Set SCREENSHOTS=1 to refresh docs/screenshots.");
    await page.setViewportSize({ width, height });
    await openPlayground(page);
    await page.keyboard.press("KeyX");
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `docs/screenshots/playground-${String(width)}x${String(height)}.png` });
  });
}
