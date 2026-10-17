import { expect, test, type Page } from "@playwright/test";

// Lessons 1–3 end to end, muted, on the synthetic practice groove (?track=synthetic): 124 BPM, the
// first beat at 0 s, bar 1 on beat 0, so every beat and downbeat is known. Each test has its own
// Learner, so they never share a Skill profile.

interface LessonWindow {
  learnToDjLesson?: {
    engine: {
      playhead(deck: "A"): { ok: boolean; beat?: number | null };
      deckState(deck: "A"): { playing: boolean };
    };
    track: { grid: { bpm: number } };
    phase(): string;
  };
}

const learner = (name: string) => `e2e-${name}-${String(Date.now())}`;

async function openLesson(page: Page, learnerId: string, lessonId: string): Promise<void> {
  await page.goto(`/?learner=${learnerId}&track=synthetic`);
  await page.locator(`li[data-lesson="${lessonId}"]`).getByRole("button").click();
  await page.waitForFunction(() => (window as LessonWindow).learnToDjLesson !== undefined);
  await expect(page.locator("main.lesson")).not.toHaveAttribute("data-phase", "loading");
}

/** Seeds a profile with Lessons passed, through the app's own API, so a later Lesson is open. */
async function seedPassed(page: Page, learnerId: string, lessonIds: readonly string[]): Promise<void> {
  await page.goto(`/?learner=${learnerId}`);
  const status = await page.evaluate(
    async ({ id, passed }) => {
      const at = new Date().toISOString();
      const lessons = Object.fromEntries(
        passed.map((lessonId) => [lessonId, { lessonId, passedAt: at, passedVia: "lesson", attempts: 1, reviewSuggestedAt: null, reviewDeclinedAt: null }]),
      );
      const record = {
        schemaVersion: 1,
        learnerId: id,
        mission: "",
        missionTags: [],
        curriculum: null,
        skillProfile: { schemaVersion: 1, learnerId: id, lessons, criteria: {}, courseCompletedAt: null },
      };
      const response = await fetch(`/api/learners/${id}/profile`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(record) });
      return response.status;
    },
    { id: learnerId, passed: lessonIds },
  );
  expect(status).toBe(200);
}

/** Taps Space on each beat of the track's grid, timed in the page from the engine's own heard playhead. */
async function tapAtBeats(page: Page, beats: readonly number[]): Promise<void> {
  await page.evaluate(async (targets) => {
    const lesson = (window as LessonWindow).learnToDjLesson;
    if (lesson === undefined) throw new Error("No Lesson is open.");
    const beatMs = 60_000 / lesson.track.grid.bpm;
    const heardBeat = () => {
      const reading = lesson.engine.playhead("A");
      if (!reading.ok || reading.beat == null) throw new Error("Deck A has no playhead reading.");
      return reading.beat;
    };
    for (const beat of targets) {
      // Re-read the heard playhead before every tap: the audio clock may drift from performance.now().
      for (let remainingMs = (beat - heardBeat()) * beatMs; remainingMs > 0.5; remainingMs = (beat - heardBeat()) * beatMs) {
        if (remainingMs > 12) await new Promise((resolve) => setTimeout(resolve, remainingMs - 8));
      }
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", key: " " }));
      window.dispatchEvent(new KeyboardEvent("keyup", { code: "Space", key: " " }));
    }
  }, beats);
}

/** Waits until the Check is running and the heard playhead has moved past `beat`. */
async function checkPlayingPast(page: Page, beat: number): Promise<void> {
  await page.waitForFunction((past) => {
    const lesson = (window as LessonWindow).learnToDjLesson;
    const reading = lesson?.engine.playhead("A");
    return lesson?.phase() === "check" && reading?.ok === true && (reading.beat ?? 0) > past;
  }, beat);
}

test("deck-basics: the hook starts on PLAY, and a fade in and out by keyboard passes the Check", async ({ page }) => {
  const learnerId = learner("deck");
  await openLesson(page, learnerId, "deck-basics");

  // Hands-on at once: the first caption asks for the X key, and PLAY pulses.
  await expect(page.getByRole("status", { name: "Lesson caption" })).toContainText("Press X");
  await page.keyboard.press("KeyX");
  await expect(page.getByRole("status", { name: "Lesson caption" })).toContainText("That's PLAY");

  // Straight into the Check: Play, fader up, wait to be heard, fader down. The attempt ends itself.
  await page.keyboard.press("Enter");
  await expect(page.locator("main.lesson")).toHaveAttribute("data-phase", "check");
  await page.keyboard.press("KeyX");
  await page.waitForTimeout(300);
  await page.keyboard.press("KeyW");
  await page.waitForTimeout(1500);
  await page.keyboard.press("KeyS");

  const card = page.getByRole("region", { name: "Result" });
  await expect(card).toHaveAttribute("data-outcome", "passed", { timeout: 10_000 });
  await expect(card).toContainText("Fade in: heard after");
  await expect(card).toContainText("Fade out: fader ended at 0%");
  // The Coach line (no API key in tests: the built-in line) fills within the 1.2 s deadline.
  await expect(card.getByLabel("Coach")).not.toHaveText(/^\s*$/, { timeout: 3000 });
  await expect(card).toContainText("Unlocked: Find the beat and the one");

  // The list shows the pass, and the next Lesson is open.
  await page.keyboard.press("Escape");
  await expect(page.locator('li[data-lesson="deck-basics"]')).toHaveAttribute("data-standing", "passed");
  await expect(page.locator('li[data-lesson="beats-and-bars"]')).toHaveAttribute("data-standing", "ready");
});

test("beats-and-bars: taps on every beat, then on every 1, pass the Check", async ({ page }) => {
  test.setTimeout(120_000);
  const learnerId = learner("beats");
  await seedPassed(page, learnerId, ["deck-basics"]);
  await openLesson(page, learnerId, "beats-and-bars");
  await expect(page.getByRole("status", { name: "Lesson caption" })).toContainText("Tap Space on every kick");

  await page.keyboard.press("Enter");
  // Anchor only once the heard playhead is moving (past the count-in's first beat, 28): Play takes
  // effect after the output latency, and a stationary reading would put every tap early.
  await checkPlayingPast(page, 28.5);

  // The Check counts in on bar 8 (beat 28): every beat of bars 9–16 (beats 32–63), then only the 1s
  // of bars 17–24 (beats 64, 68 … 92).
  await tapAtBeats(page, [...Array.from({ length: 32 }, (_, index) => 32 + index), ...Array.from({ length: 8 }, (_, index) => 64 + 4 * index)]);

  const card = page.getByRole("region", { name: "Result" });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card, await card.innerText()).toHaveAttribute("data-outcome", "passed");
  // A headless timer can still miss a tap now and then; the pass is what matters.
  await expect(card).toContainText(/Beats: (29|3[0-2]) of 32 on time/);
  await expect(card).toContainText(/Downbeats: [78] of 8 on time/);
  await expect(card).toContainText("Unlocked: Count phrases");
});

test("phrases: a tap on each phrase start across two halves, a halfway tick, then the sections named, pass the Check", async ({ page }) => {
  // 66 bars at 124 BPM: about 2 minutes of real time.
  test.setTimeout(240_000);
  const learnerId = learner("phrases");
  await seedPassed(page, learnerId, ["deck-basics", "beats-and-bars"]);
  await openLesson(page, learnerId, "phrases");
  await expect(page.getByRole("status", { name: "Lesson caption" })).toContainText("Tap Space when something changes");

  // The synthetic groove: phrase k starts on beat 32·(k − 1). The Check leads in from bar 7 (beat 24)
  // and taps phrases 2–9 (beats 32 … 256): the breakdown is the 4th tapped phrase, the drop the 6th.
  await page.keyboard.press("Enter");
  await checkPlayingPast(page, 24.5);
  const caption = page.getByRole("status", { name: "Lesson caption" });
  await expect(caption).toContainText("Tap each new phrase");

  // First half: phrases 2–5, then the first phrase of the second half (beat 160).
  await tapAtBeats(page, [32, 64, 96, 128, 160]);
  // Halfway: a tick and one caption, while the music keeps playing.
  const cue = page.locator(".lesson-cue");
  await expect(cue).toHaveAttribute("data-checkpoint", "true", { timeout: 3000 });
  await expect(cue).toHaveText("Halfway: keep tapping each phrase");
  expect(await page.evaluate(() => (window as LessonWindow).learnToDjLesson?.engine.deckState("A").playing)).toBe(true);
  await expect(page.locator("main.lesson")).toHaveAttribute("data-phase", "check");

  // Second half; the tick goes away after a few bars, and the attempt ends by itself.
  await tapAtBeats(page, [192, 224, 256]);
  await expect(cue).toHaveAttribute("data-checkpoint", "false");
  const questions = page.getByRole("region", { name: "Questions" });
  await expect(questions).toBeVisible({ timeout: 30_000 });
  const lineRequest = page.waitForRequest((request) => request.url().endsWith(`/api/learners/${learnerId}/coach/line`));
  const curriculumRequest = page.waitForRequest((request) => request.url().endsWith(`/api/learners/${learnerId}/coach/curriculum`));
  await page.keyboard.press("Digit4");
  await page.keyboard.press("Digit6");

  const card = page.getByRole("region", { name: "Result" });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card, await card.innerText()).toHaveAttribute("data-outcome", "passed");
  await expect(card).toContainText(/Phrase starts: [78] of 8 on time/);
  await expect(card).toContainText("Sections named: 2 of 2 right");

  // The Coach line hears the retention change (a first pass: next check-in in 1 day) and the
  // Mission tags; passing phrases completes the Timing skip group, so the Curriculum is re-planned.
  const line = (await lineRequest).postDataJSON() as { context: Record<string, unknown> };
  expect(line.context).toMatchObject({ retentionChange: "passed, next in 1 day", missionTags: [], focusHistory: [], bestMarginBefore: null });
  const curriculum = (await curriculumRequest).postDataJSON() as Record<string, unknown>;
  expect(curriculum).toMatchObject({ reason: "skipGroupPassed", demonstrated: ["deck-basics", "beats-and-bars", "phrases"] });
});

test("the Lesson screen fits a 13-inch laptop (1280×800) with the controller, without page scroll", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openLesson(page, learner("fit"), "deck-basics");
  await expect(page.locator(".controller")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("a Lesson whose prerequisites are not passed is locked in the list", async ({ page }) => {
  await page.goto(`/?learner=${learner("locked")}`);
  await expect(page.locator('li[data-lesson="deck-basics"]')).toHaveAttribute("data-standing", "ready");
  await expect(page.locator('li[data-lesson="phrases"]')).toHaveAttribute("data-standing", "locked");
});
