import { devices, expect, test, type Page } from "@playwright/test";
import { learner, seedPassed } from "./lesson-support.ts";

// The one-time "Set up your library" card on the Lesson list (ISS-97): offered after a pass,
// answered with a tap or click big enough for a finger, kept in the profile so it never comes back.

const TOUCH_TARGET_PX = 44;

async function answerLibraryCard(page: Page, name: string): Promise<void> {
  const id = learner(name);
  await seedPassed(page, id, ["deck-basics"]);
  await page.goto(`/?learner=${id}`);
  const card = page.getByRole("region", { name: "Set up your library" });
  await expect(card).toBeVisible();
  await expect(card.getByText("Music/DJ/00 Inbox")).toBeVisible();
  for (const label of ["Done it", "Not now"]) {
    const box = await card.getByRole("button", { name: label }).boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(TOUCH_TARGET_PX);
    expect(box?.width).toBeGreaterThanOrEqual(TOUCH_TARGET_PX);
  }
  await card.getByRole("button", { name: "Done it" }).click();
  await expect(card).toBeHidden();

  await expect
    .poll(async () => page.evaluate(async (learnerId) => ((await (await fetch(`/api/learners/${learnerId}/profile`)).json()) as { data?: { rekordbox?: unknown } }), id))
    .toMatchObject({ data: { rekordbox: { library: { choice: "done" } } } });
  await page.reload();
  await expect(page.getByRole("region", { name: "Lessons" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Set up your library" })).toBeHidden();
}

test("desktop: the library card is offered once and remembered", async ({ page }) => {
  await answerLibraryCard(page, "rekordbox-desktop");
});

test.describe("phone", () => {
  test.use({ userAgent: devices["Pixel 7"].userAgent, isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });

  test("the library card fits and answers by touch", async ({ page }) => {
    await answerLibraryCard(page, "rekordbox-phone");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
