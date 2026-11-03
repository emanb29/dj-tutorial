import { expect, test, type Page } from "@playwright/test";
import { ensureProfile, learner } from "./lesson-support.ts";
import { libraryTracks, pickGrooveFolder, stubGrooveFolder } from "./mix-editor-support.ts";

// The Mix Editor (ISS-187) end to end, muted: build a plan by keyboard from an in-memory folder of
// synthetic grooves, make a Transition hard (the warning shows, and the plan still saves), shape it on
// the timeline, and preview it. Then the same page at phone width: the set, read-only, no sideways scroll.

interface EditorWindow {
  djTutorialMixEditor?: { plan(): { name: string; transitions: { recipe: string; lengthBeats: number }[] } | null; previewBeat(): number | null };
}

const editorPlan = (page: Page) => page.evaluate(() => (window as EditorWindow).djTutorialMixEditor?.plan() ?? null);

/** From the Lesson list: a new plan of the three grooves, picked by keyboard, opened in the Mix Editor. */
async function buildPlan(page: Page, id: string): Promise<void> {
  await stubGrooveFolder(page);
  await ensureProfile(page, id);
  await page.goto(`/?learner=${id}`);
  await pickGrooveFolder(page);
  await page.getByRole("button", { name: "Mix plans" }).click();
  await page.getByRole("button", { name: "New plan" }).click();
  await expect(libraryTracks(page)).toHaveCount(3);
  await libraryTracks(page).first().focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator("ol.plans-order > li")).toHaveText([/A · Copper Tide/, /B · Glass Orchard/, /A · Low Lanterns/]);
  const make = page.getByRole("button", { name: "Make the plan" });
  await make.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Transition editor" })).toBeVisible({ timeout: 60_000 });
}

test("Mix Editor: build a plan by keyboard, make a Transition hard, see the warning, save, shape it and preview it", async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await buildPlan(page, learner("mix-editor"));
  await expect(page).toHaveURL(/\/plans\/[\w-]+/);

  const set = page.getByRole("list", { name: "Set" });
  await expect(set.locator(".me-set-track")).toHaveCount(3);
  await expect(set.locator(".me-set-transition")).toHaveText([/Crossfade, 16 bars at Phrase 3, 16 bars/, /Crossfade, 16 bars at Phrase 3, 16 bars/]);
  const editor = page.getByRole("region", { name: "Transition editor" });
  await expect(editor.getByTestId("pair")).toHaveText("Track 1 → Track 2");
  // Both grooves' grids are found (rekordbox's), so Preview is offered.
  await expect(editor.getByRole("button", { name: /Preview/ })).toBeEnabled({ timeout: 60_000 });

  // A bass swap is hard for a Learner who has not learned the EQ yet: the one-line warning, never a block.
  await expect(editor.getByTestId("hard-warning")).toHaveCount(0);
  await editor.getByRole("button", { name: "Bass swap" }).click();
  await expect(editor.getByTestId("hard-warning")).toContainText("Hard to play live:");
  await expect(set.locator(".me-set-transition").first()).toContainText("Bass swap at Phrase 3, 16 bars");
  await expect(page.getByTestId("save-status")).toHaveText("Saved on this device");

  // Its reasons and the Execution strip open on demand, from the chip.
  await editor.getByRole("button", { name: /Complexity rating 5 of 5, very hard: why/ }).click();
  const strip = editor.getByRole("region", { name: "How you'd play it" });
  await expect(strip.getByRole("list", { name: "Right hand" })).toContainText("LOW B");

  // Zoom in, then shape a keyframe by keyboard on the timeline: the Transition becomes custom.
  const zoomText = editor.getByTestId("zoom-level");
  const before = await zoomText.textContent();
  await editor.getByRole("button", { name: "Zoom in" }).click();
  await expect(zoomText).not.toHaveText(before ?? "");
  await editor.getByRole("button", { name: "Edit moves" }).click();
  const keyframe = editor.locator('[data-lane="incoming:volume"] .me-kf').nth(1);
  await keyframe.focus();
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(editor.locator(".me-recipe-custom")).toBeVisible();
  await expect(set.locator(".me-set-transition").first()).toContainText("Custom at Phrase 3, 16 bars");
  await expect(page.getByTestId("save-status")).toHaveText("Saved on this device");

  // The plan is kept on this device: open it again and the edits are there.
  await page.reload();
  await expect(page.getByRole("region", { name: "Transition editor" })).toBeVisible({ timeout: 30_000 });
  const saved = await editorPlan(page);
  expect(saved?.transitions.map((each) => each.recipe)).toEqual(["custom", "crossfade-16"]);

  // One-tap preview (the folder is in memory, so after the reload it is picked again first).
  await page.getByRole("button", { name: /Mix plans/ }).click();
  await page.getByRole("button", { name: /Lessons/ }).click();
  await pickGrooveFolder(page);
  await page.getByRole("button", { name: "Mix plans" }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).first().click();
  const again = page.getByRole("region", { name: "Transition editor" });
  const preview = again.getByRole("button", { name: /Preview/ });
  await expect(preview).toBeEnabled({ timeout: 60_000 });
  await preview.click();
  await expect(again.getByRole("button", { name: /Stop/ })).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => ((window as EditorWindow).djTutorialMixEditor?.previewBeat() ?? -1000) > -31);
  await again.getByRole("button", { name: /Stop/ }).click();
  await expect(again.getByRole("button", { name: /Preview/ })).toBeVisible();

  // Next pair, and back to the set with Esc.
  await again.getByRole("button", { name: "Next pair ▶" }).click();
  await expect(page.getByRole("region", { name: "Transition editor" }).getByTestId("pair")).toHaveText("Track 2 → Track 3");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("region", { name: "Transition editor" })).toHaveCount(0);
});

test("Mix Editor at phone width: the set, read-only, with no sideways scroll", async ({ page }) => {
  test.setTimeout(150_000);
  await buildPlan(page, learner("mix-editor-phone"));
  await page.setViewportSize({ width: 360, height: 740 });
  await expect(page.getByText("Planning is best on a laptop")).toBeVisible();
  await expect(page.getByRole("region", { name: "Transition editor" })).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Set" }).locator(".me-set-transition")).toHaveCount(2);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
