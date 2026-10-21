import { expect, test, type Page } from "@playwright/test";
import { ensureProfile, learner } from "./lesson-support.ts";

// Freestyle end to end, muted, on the synthetic set grooves (?track=synthetic): open it from the
// Lesson list, load a groove onto each deck, play deck A, see deck A refuse a new track while it plays.

const T1 = "Set Groove C (synthetic)";
const T2 = "Set Groove Am (synthetic)";

interface FreestyleWindow {
  learnToDjLesson?: {
    engine: { deckState(deck: "A" | "B"): { playing: boolean } };
    deckTrack(deck: "A" | "B"): string | null;
  };
}

const deckTrack = (page: Page, deck: "A" | "B") => page.evaluate((which) => (window as FreestyleWindow).learnToDjLesson?.deckTrack(which) ?? null, deck);

/** No sideways scrolling: the page fits the screen's width. */
async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, screen: window.innerWidth }));
  expect(widths.page).toBeLessThanOrEqual(widths.screen);
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 360, height: 740 }]) {
  test(`freestyle at ${String(viewport.width)} px: load a track onto each deck and play, with nothing graded`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(viewport);
    const id = learner("freestyle");
    await ensureProfile(page, id);
    await page.goto(`/?learner=${id}&track=synthetic`);
    await page.getByRole("button", { name: "Freestyle" }).click();
    await expect(page.getByRole("heading", { name: "Freestyle" })).toBeVisible();
    await expect(page.locator("main.freestyle")).toHaveAttribute("data-phase", "ready");

    const decks = page.getByRole("list", { name: "On the decks" });
    await expect(decks.locator('li[data-deck="A"]')).toContainText("Empty");
    await page.getByRole("button", { name: `Load ${T1} onto deck A` }).click();
    await expect(decks.locator('li[data-deck="A"]')).toContainText(T1);
    await page.getByRole("button", { name: `Load ${T2} onto deck B` }).click();
    await expect(decks.locator('li[data-deck="B"]')).toContainText(T2);
    expect(await deckTrack(page, "A")).not.toBeNull();
    expect(await deckTrack(page, "B")).not.toBeNull();

    // Every control is unlocked: deck A's PLAY works, and a playing deck takes no new track.
    await page.locator('[data-control="A.play"]').click();
    await page.waitForFunction(() => (window as FreestyleWindow).learnToDjLesson?.engine.deckState("A").playing === true);
    await expect(page.getByRole("button", { name: `Load ${T2} onto deck A` })).toBeDisabled();
    await expect(page.getByRole("button", { name: `Load ${T2} onto deck A` })).toHaveAttribute("title", "Pause deck A first");
    await expectNoSidewaysScroll(page);

    await page.keyboard.press("Escape");
    await expect(page.getByRole("region", { name: "Lessons" })).toBeVisible();
  });
}
