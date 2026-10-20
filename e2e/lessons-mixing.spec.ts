import { expect, test, type Page } from "@playwright/test";
import { caption, checkPlayingPast, keysAtBeats, learner, openLesson, readyFromPhraseStart, resultCard, seedPassed, type LessonWindow } from "./lesson-support.ts";

// Lessons 4–7 end to end, muted, on the synthetic groove (124 BPM, first beat at 0 s, bar 1 on beat 0).
// The synthetic groove peaks at −6 dBFS. Engine commands sent from the test stand in for knob drags.

const FIRST_SIX = ["deck-basics", "beats-and-bars", "phrases", "gain-staging", "headphone-cue", "cue-point"];

async function command(page: Page, sent: Record<string, unknown>): Promise<void> {
  const ok = await page.evaluate((payload) => (window as LessonWindow).learnToDjLesson?.engine.command(payload, { device: "trackpad" }).ok, sent);
  expect(ok, JSON.stringify(sent)).toBe(true);
}

test("gain-staging: trim each deck into the zone, Ready, 8 bars, pass", async ({ page }) => {
  test.setTimeout(90_000);
  const learnerId = learner("gain");
  await seedPassed(page, learnerId, ["deck-basics"]);
  await openLesson(page, learnerId, "gain-staging");

  // The hook moves on once deck A's meter is in the zone, not when TRIM is merely touched.
  await expect(caption(page)).toContainText("Turn TRIM A");
  await command(page, { control: "trim", deck: "A", value: 1 / 3 });
  await expect(caption(page)).toContainText("Press , to play B", { timeout: 5000 });
  // B waits paused, so the first press plays it.
  await page.keyboard.press("Comma");
  await expect(caption(page)).toContainText("Turn TRIM B to match A");

  await page.keyboard.press("Enter");
  await expect(page.locator(".lesson-cue")).toHaveText("Trim A into the zone, then R");
  // +3 dB on each deck: the −6 dBFS groove peaks at −3.
  await command(page, { control: "trim", deck: "A", value: 1 / 3 });
  await page.waitForTimeout(500);
  await page.keyboard.press("KeyR");
  await expect(page.locator(".lesson-cue")).toHaveText("Hands off A. Trim B to match, then R");
  await command(page, { control: "trim", deck: "B", value: 1 / 3 });
  await page.waitForTimeout(500);
  await page.keyboard.press("KeyR");
  await expect(page.locator(".lesson-cue")).toHaveText("Hold it: 8 bars");

  const card = resultCard(page);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card, await card.innerText()).toHaveAttribute("data-outcome", "passed");
  await expect(card).toContainText(/Deck A peak: −[1-5]\.\d dBFS/);
  await expect(card).toContainText("A and B loudness:");
  await expect(card).toContainText("Unlocked: Listen before they hear it");
});

test("headphone-cue: the one-time headphones check, then tapping B's beat in the headphones passes", async ({ page }) => {
  test.setTimeout(90_000);
  const learnerId = learner("cue");
  await seedPassed(page, learnerId, ["deck-basics"]);
  await openLesson(page, learnerId, "headphone-cue", { waitForHook: false });

  // The check: headphones on, then a click in each ear. "Both" means the OS plays mono.
  const gate = page.getByRole("region", { name: "Headphones check" });
  await gate.getByRole("button", { name: "They're on" }).click();
  await gate.getByRole("button", { name: "Both" }).click();
  await expect(gate).toContainText("Play stereo audio as mono");
  await gate.getByRole("button", { name: "Test again" }).click();
  await gate.getByRole("button", { name: "Left" }).click();
  await gate.getByRole("button", { name: "Right" }).click();
  await expect(gate).toBeHidden();
  await expect(caption(page)).toContainText("Turn on CUE 🎧 on channel B");
  // Kept in the profile: never asked again.
  await expect
    .poll(async () => page.evaluate(async (id) => ((await (await fetch(`/api/learners/${id}/profile`)).json()) as { data: { headphones?: unknown } }).data.headphones, learnerId))
    .toMatchObject({ checkedAt: expect.any(String) });

  // The Check: A on the speakers from bar 5, B a third of a beat ahead in the headphones, fader down.
  await page.keyboard.press("Enter");
  await checkPlayingPast(page, 16.5, "B");
  await page.getByRole("button", { name: "Channel B headphone cue" }).click();
  // B's 32 beats of bars 9–16 (beats 32–63 on B's own grid).
  await keysAtBeats(page, Array.from({ length: 32 }, (_, index) => 32 + index), { deck: "B" });

  const card = resultCard(page);
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card, await card.innerText()).toHaveAttribute("data-outcome", "passed");
  await expect(card).toContainText(/B's beats: (2[89]|3[0-2]) of 32 on time/);
  await expect(card).toContainText("B off the speakers");
});

test("cue-point: the jog searches a paused deck, and three cue points on a 1 pass", async ({ page }) => {
  test.setTimeout(120_000);
  const learnerId = learner("cuepoint");
  await seedPassed(page, learnerId, ["deck-basics", "beats-and-bars", "headphone-cue"], { headphones: true });
  await openLesson(page, learnerId, "cue-point");

  // The hook: scrolling over the jog wheel of the paused deck moves its playhead, without playing it.
  await expect(caption(page)).toContainText("Turn the jog wheel");
  const before = await page.evaluate(() => (window as LessonWindow).learnToDjLesson?.engine.playhead("A").positionSec ?? 0);
  await page.locator(".deck-A .jog-surface, [aria-label^='Deck A jog wheel']").first().hover();
  await page.mouse.wheel(0, 120);
  await expect(caption(page)).toContainText("Find a kick. Press Z", { timeout: 10_000 });
  // The playhead read is the heard one: the search is heard an output latency after the scroll.
  await expect
    .poll(async () => page.evaluate(() => (window as LessonWindow).learnToDjLesson?.engine.playhead("A").positionSec ?? 0))
    .not.toBeCloseTo(before, 3);
  expect(await page.evaluate(() => (window as LessonWindow).learnToDjLesson?.engine.deckState("A").playing)).toBe(false);

  // The Check: three slices, each paused between beats. Search to its first 1, set the cue, Ready.
  await page.keyboard.press("Enter");
  for (const slice of [1, 2, 3]) {
    await page.waitForFunction((number) => (window as LessonWindow).learnToDjLesson?.deckTrack("A")?.trackId.endsWith(`#cue-${String(number)}`) === true, slice);
    await expect(page.locator(".lesson-cue")).toHaveText(`Cue ${String(slice)} of 3: a 1, by ear. R when happy`);
    const delta = await page.evaluate(() => {
      const lesson = (window as LessonWindow).learnToDjLesson;
      const grid = lesson?.deckTrack("A")?.grid;
      if (lesson === undefined || grid === undefined) throw new Error("No slice on deck A.");
      const beat = 60 / grid.bpm;
      const firstDownbeat = grid.firstBeat + (((grid.downbeatIndex % 4) + 4) % 4) * beat;
      return firstDownbeat + 0.004 - (lesson.engine.playhead("A").positionSec ?? 0);
    });
    await command(page, { control: "jog-search", deck: "A", value: delta });
    await page.keyboard.press("KeyZ");
    await page.keyboard.press("KeyR");
  }

  const card = resultCard(page);
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card, await card.innerText()).toHaveAttribute("data-outcome", "passed");
  await expect(card).toContainText("Cue points: worst");
  // One line per cue: each was set 4 ms after its 1.
  await expect(card.getByRole("list", { name: "Each cue" }).getByRole("listitem")).toHaveText(["Cue 1: 4 ms late ✓", "Cue 2: 4 ms late ✓", "Cue 3: 4 ms late ✓"]);
});

test("cue-point practice: each cue point shows its offset, the target narrows, and a hint follows two late misses", async ({ page }) => {
  test.setTimeout(90_000);
  const learnerId = learner("cueladder");
  await seedPassed(page, learnerId, ["deck-basics", "beats-and-bars", "headphone-cue"], { headphones: true });
  await openLesson(page, learnerId, "cue-point");
  // The hook from the test: search, set a cue point, hold CUE on it to preview, let go.
  await expect(caption(page)).toContainText("Turn the jog wheel");
  await command(page, { control: "jog-search", deck: "A", value: 0.1 });
  for (let press = 0; press < 2; press += 1) {
    await command(page, { control: "deck-cue", deck: "A", value: true });
    await command(page, { control: "deck-cue", deck: "A", value: false });
  }
  await expect(caption(page)).toContainText("Target ±40 ms · 0 of 2", { timeout: 5000 });

  /** Paused deck A to `ms` off the 1 of the grid's 9th bar, then CUE: a cue point there. */
  const cueAt = async (ms: number) => {
    const pos = await page.evaluate((offsetMs) => {
      const grid = (window as LessonWindow).learnToDjLesson?.deckTrack("A")?.grid;
      if (grid === undefined) throw new Error("No track on deck A.");
      return grid.firstBeat + (grid.downbeatIndex + 32) * (60 / grid.bpm) + offsetMs / 1000;
    }, ms);
    await command(page, { control: "seek", deck: "A", value: pos });
    await command(page, { control: "deck-cue", deck: "A", value: true });
    await command(page, { control: "deck-cue", deck: "A", value: false });
  };
  const feedback = page.getByRole("status", { name: "Practice feedback" });
  await cueAt(34);
  await expect(feedback).toHaveText("Cue: 34 ms late ✓");
  await expect(caption(page)).toContainText("Target ±40 ms · 1 of 2");
  await cueAt(-8);
  await expect(feedback).toHaveText("Cue: 8 ms early ✓");
  await expect(caption(page)).toContainText("Target ±30 ms · 0 of 2");
  await cueAt(34);
  await cueAt(45);
  await expect(feedback).toHaveText("Cue: 45 ms late");
  await expect(caption(page)).toContainText("Target ±40 ms · 0 of 2");
  await expect(page.getByLabel("Practice hint")).toHaveText("Late? Scrub slower over the last few ticks; stop just before the thump.");
});

test("cut-on-phrase: CUE B, fader B up, then PLAY B and cut A on the phrase start, passes", async ({ page }) => {
  test.setTimeout(90_000);
  const learnerId = learner("cut");
  await seedPassed(page, learnerId, FIRST_SIX, { headphones: true });
  await openLesson(page, learnerId, "cut-on-phrase");
  await expect(caption(page)).toContainText("Turn on CUE 🎧 on channel B");

  // Set up off the clock, A looping phrase 2 (bar 9, beat 32). Once set it goes on by itself (no R)
  // where the phrase comes round: a whole phrase, and the cut on phrase 3 (bar 17, beat 64); B waits
  // on its cue point.
  await page.keyboard.press("Enter");
  await expect(page.locator(".lesson-cue")).toHaveText("Set up: CUE 🎧 B on, fader B up, trims matched");
  await page.getByRole("button", { name: "Channel B headphone cue" }).click();
  await page.keyboard.press("KeyO");
  await readyFromPhraseStart(page, "check", 32, { byItself: true });
  await expect(page.locator(".lesson-cue")).toHaveText("Count this phrase: cut on the next 1");
  // On the 1, as heard: B's Play is graded from the press, however late a headless browser's audio starts.
  await keysAtBeats(page, [64], { codes: ["Comma", "KeyS"] });

  const card = resultCard(page);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card, await card.innerText()).toHaveAttribute("data-outcome", "passed");
  await expect(card).toContainText(/Cut: \d+ ms from the phrase start/);
  await expect(card).toContainText("CUE B on");
});

test("a profile save that fails says 'not saved' instead of a silent pass, and Retry saves it", async ({ page }) => {
  const learnerId = learner("unsaved");
  await openLesson(page, learnerId, "deck-basics");
  await page.route(`**/api/learners/${learnerId}/profile`, (route) => (route.request().method() === "PUT" ? route.fulfill({ status: 500, body: "{}" }) : route.fallback()));

  await page.keyboard.press("Enter");
  await page.keyboard.press("KeyX");
  await page.waitForTimeout(300);
  await page.keyboard.press("KeyW");
  await page.waitForTimeout(1500);
  await page.keyboard.press("KeyS");

  const card = resultCard(page);
  await expect(card).toHaveAttribute("data-outcome", "passed", { timeout: 10_000 });
  await expect(card.getByRole("alert")).toContainText("Not saved");
  await expect(card).not.toContainText("Unlocked:");

  await page.unroute(`**/api/learners/${learnerId}/profile`);
  await card.getByRole("button", { name: "Retry save" }).click();
  await expect(card.getByRole("alert")).toBeHidden();
  await expect(card).toContainText("Unlocked: Find the beat and the one");
});
