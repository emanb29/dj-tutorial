import { expect, test, type Page } from "@playwright/test";

// Screenshots of the app shell for the docs, taken only on request (muted, synthetic groove):
//   SCREENSHOTS=1 npm run test:e2e -- screenshots
// SCREENSHOT_TAG=before adds a suffix, for before/after pairs in a change.
const WIDTH = 1280;
const HEIGHT = 800;
const tag = process.env["SCREENSHOT_TAG"];
const path = (name: string) => `docs/screenshots/${name}-${String(WIDTH)}x${String(HEIGHT)}${tag === undefined ? "" : `-${tag}`}.png`;

test.use({ viewport: { width: WIDTH, height: HEIGHT } });
test.skip(process.env["SCREENSHOTS"] === undefined, "Set SCREENSHOTS=1 to refresh docs/screenshots.");

async function noPageScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  expect(overflow, "the page scrolls at 1280×800").toBeLessThanOrEqual(0);
}

test("screenshot of the Lesson list", async ({ page }) => {
  await page.goto(`/?learner=e2e-shots-list-${String(Date.now())}`);
  await expect(page.locator('li[data-lesson="deck-basics"]')).toBeVisible();
  await page.screenshot({ path: path("lesson-list") });
});

test("screenshots of a Lesson: the hook and the result card", async ({ page }) => {
  await page.goto(`/?learner=e2e-shots-lesson-${String(Date.now())}&track=synthetic`);
  await page.locator('li[data-lesson="deck-basics"]').getByRole("button").click();
  await expect(page.getByRole("status", { name: "Lesson caption" })).toContainText("Press X");
  await page.waitForTimeout(500);
  await page.screenshot({ path: path("lesson-hook") });

  await page.keyboard.press("Enter");
  await page.keyboard.press("KeyX");
  await page.waitForTimeout(300);
  await page.keyboard.press("KeyW");
  await page.waitForTimeout(1500);
  await page.keyboard.press("KeyS");
  const card = page.getByRole("region", { name: "Result" });
  await expect(card).toHaveAttribute("data-outcome", "passed", { timeout: 10_000 });
  await expect(card.getByLabel("Coach")).not.toHaveText(/^\s*$/, { timeout: 3000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path("lesson-result") });
  if (tag === undefined) await noPageScroll(page);

  // A failed attempt: the fader comes up too late (after 4 bars).
  await page.keyboard.press("Enter");
  await page.keyboard.press("KeyX");
  await page.waitForTimeout(9000);
  await page.keyboard.press("KeyW");
  await page.waitForTimeout(800);
  await page.keyboard.press("KeyS");
  await expect(card).toHaveAttribute("data-outcome", "failed", { timeout: 10_000 });
  await expect(card.getByLabel("Coach")).not.toHaveText(/^\s*$/, { timeout: 3000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path("lesson-result-failed") });
});

test("screenshot of the phrases Check at its halfway checkpoint", async ({ page }) => {
  // The checkpoint comes 32 bars into the Check: about 70 s of real time.
  test.setTimeout(150_000);
  test.skip(tag !== undefined, "The checkpoint is new in this change: there is no 'before'.");
  const learnerId = `e2e-shots-phrases-${String(Date.now())}`;
  await page.goto(`/?learner=${learnerId}`);
  const at = new Date().toISOString();
  const lessons = Object.fromEntries(
    ["deck-basics", "beats-and-bars"].map((lessonId) => [lessonId, { lessonId, passedAt: at, passedVia: "lesson", attempts: 1, reviewSuggestedAt: null, reviewDeclinedAt: null }]),
  );
  const record = { schemaVersion: 1, learnerId, mission: "", missionTags: [], curriculum: null, skillProfile: { schemaVersion: 1, learnerId, lessons, criteria: {}, courseCompletedAt: null } };
  // From the page, so the API sees the app's own Origin.
  const status = await page.evaluate(
    async ({ id, body }) => (await fetch(`/api/learners/${id}/profile`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).status,
    { id: learnerId, body: record },
  );
  expect(status).toBe(200);

  await page.goto(`/?learner=${learnerId}&track=synthetic`);
  await page.locator('li[data-lesson="phrases"]').getByRole("button").click();
  await expect(page.getByRole("status", { name: "Lesson caption" })).toContainText("Tap Space");
  await page.keyboard.press("Enter");
  await expect(page.locator(".lesson-cue")).toHaveAttribute("data-checkpoint", "true", { timeout: 120_000 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path("lesson-phrases-halfway") });
  await noPageScroll(page);
});
