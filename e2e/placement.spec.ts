import { devices, expect, test, type Page } from "@playwright/test";
import { keysAtBeats, learner, type LessonWindow } from "./lesson-support.ts";

// Placement end to end (docs/placement-design.md), muted, on the synthetic groove (124 BPM, first beat
// at 0 s, bar 1 on beat 0; 8-bar phrases, the drop on phrase 7). A first-run Learner types a Mission,
// passes the headphones check, says Not yet to the three hardest group tasks, passes the phrases task
// (tapping phrases 5–7 and naming the drop, pad 4), and says Not yet to cue-point (the one narrowing
// task left: nudge-phase and sync-blend sit on the cut-on-phrase task just missed). The Summary credits
// Lessons 1–3 and starts at Lesson 4, and the profile and Curriculum say so too.
//
// Screenshots land in test-results/placement/ for review (gitignored).

const SHOTS = "test-results/placement";
/** Phrase n starts on beat (n − 1) · 32 of the synthetic groove. */
const phraseBeat = (phrase: number) => (phrase - 1) * 32;

const caption = (page: Page) => page.getByRole("status", { name: "Placement caption" });
const placementMain = (page: Page) => page.locator("main.placement");

/** Waits until `task` is on screen and its attempt (the music) is running. */
async function taskPlaying(page: Page, task: string): Promise<void> {
  await expect(page.locator("main.placement")).toHaveAttribute("data-task", task, { timeout: 20_000 });
  await page.waitForFunction(() => (window as LessonWindow).learnToDjLesson?.phase() === "check", undefined, { timeout: 20_000 });
}

/** Waits until deck A's heard playhead is past `beat` in the running task. */
async function pastBeat(page: Page, beat: number): Promise<void> {
  await page.waitForFunction(
    (past) => {
      const reading = (window as LessonWindow).learnToDjLesson?.engine.playhead("A");
      return reading?.ok === true && (reading.beat ?? 0) > past;
    },
    beat,
    { timeout: 90_000 },
  );
}

async function profileOf(page: Page, learnerId: string) {
  return page.evaluate(async (id) => {
    const body = (await (await fetch(`/api/learners/${id}/profile`)).json()) as {
      data: {
        mission: string;
        curriculum: string[] | null;
        headphones?: { checkedAt: string };
        placements?: { endReason: string; tasks: { lessonId: string; outcome: string }[] }[];
        skillProfile: { lessons: Record<string, { passedVia: string | null; passedAt: string | null }>; criteria: Record<string, { retention: { state: string } | null }> };
      };
    };
    return body.data;
  }, learnerId);
}

async function expectPlacedProfile(page: Page, learnerId: string): Promise<void> {
  await expect.poll(async () => (await profileOf(page, learnerId)).placements?.length ?? 0, { timeout: 10_000 }).toBe(1);
  const profile = await profileOf(page, learnerId);
  expect(profile.mission).toBe("post my own mixes");
  expect(profile.headphones?.checkedAt).toEqual(expect.any(String));
  expect(profile.placements?.[0]?.tasks.map((task) => [task.lessonId, task.outcome])).toEqual([
    ["blend-by-ear", "notYet"],
    ["bass-swap", "notYet"],
    ["cut-on-phrase", "notYet"],
    ["phrases", "passed"],
    ["cue-point", "notYet"],
  ]);
  expect(profile.placements?.[0]?.endReason).toBe("noTaskLeft");
  for (const id of ["deck-basics", "beats-and-bars", "phrases"]) expect(profile.skillProfile.lessons[id]?.passedVia, id).toBe("placement");
  expect(profile.skillProfile.lessons["cut-on-phrase"]?.passedAt ?? null).toBeNull();
  // Credited means passed, never retained.
  expect(profile.skillProfile.criteria["phrases.phrase-taps"]?.retention?.state).toBe("passed");
  expect(Object.values(profile.skillProfile.criteria).some((record) => record.retention?.state === "retained")).toBe(false);
  // The Curriculum (deterministic now, the Coach's no-key fallback after) starts at the Start Lesson.
  expect(profile.curriculum?.[0]).toBe("gain-staging");
}

test.describe("Placement on a laptop (1440×900, keyboard)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("Mission, three Not yets, a phrases pass, Summary: Lessons 1–3 credited, Start opens Lesson 4", async ({ page }) => {
    test.setTimeout(180_000);
    const learnerId = learner("placement-desk");
    await page.goto(`/?learner=${learnerId}&track=synthetic`);

    // First run: no profile yet, so Placement opens on the Mission.
    const mission = page.getByLabel("Why do you want to DJ?");
    await expect(mission).toBeFocused();
    await expect(page.getByText("Sent to Anthropic's API so the Coach can tailor your optional Lessons.")).toBeVisible();
    await mission.fill("post my own mixes");
    await page.screenshot({ path: `${SHOTS}/desktop-1-mission.png` });
    await mission.press("Enter");

    // The first task uses the headphone cue: the one-time headphones check first.
    const gate = page.getByRole("region", { name: "Headphones check" });
    await gate.getByRole("button", { name: "They're on" }).click();
    await gate.getByRole("button", { name: "Left" }).click();
    await gate.getByRole("button", { name: "Right" }).click();
    await expect(gate).toBeHidden();

    // blend-by-ear: the music is already playing, one caption line, the controller in full view.
    await taskPlaying(page, "blend-by-ear");
    await expect(caption(page)).toContainText("Match by ear");
    await expect(page.locator('[data-control="B.sync"]')).toHaveAttribute("data-locked", "true");
    await expect(page.locator('[data-control="B.tempo"]')).toHaveAttribute("data-locked", "false");
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${SHOTS}/desktop-2-task.png` });
    await page.keyboard.press("KeyN");

    // bass-swap, then cut-on-phrase: Not yet (N).
    await taskPlaying(page, "bass-swap");
    await expect(caption(page)).toContainText("swap bass");
    await page.keyboard.press("KeyN");
    await taskPlaying(page, "cut-on-phrase");
    await expect(caption(page)).toContainText("Cue B by ear");
    await page.keyboard.press("KeyN");

    // phrases: the music starts on phrase 4; tap the first beat of phrases 5, 6 and 7, then name the drop.
    await taskPlaying(page, "phrases");
    await expect(caption(page)).toContainText("Tap the first beat of every phrase");
    // The attempt cues deck A to phrase 4 just after the task appears: time the taps from there.
    await pastBeat(page, phraseBeat(4));
    await keysAtBeats(page, [phraseBeat(5) + 0.05, phraseBeat(6) + 0.05, phraseBeat(7) + 0.05]);
    await expect(page.getByRole("region", { name: "Questions" })).toBeVisible({ timeout: 30_000 });
    await expect(caption(page)).toContainText("Which one was the drop?");
    await page.keyboard.press("Digit4");

    const card = page.getByRole("region", { name: "Result" });
    await expect(card).toHaveAttribute("data-outcome", "passed", { timeout: 10_000 });
    await expect(card).toContainText("You've got phrases");
    await page.screenshot({ path: `${SHOTS}/desktop-3-card.png` });
    await page.keyboard.press("Space");

    // Narrowing: cue-point (Foundations); nudge-phase and sync-blend are skipped.
    await taskPlaying(page, "cue-point");
    await expect(caption(page)).toContainText("Cue on a 1 by ear");
    await page.keyboard.press("KeyN");

    const summary = page.getByRole("main", { name: "Placement summary" });
    await expect(summary).toBeVisible();
    await expect(summary.getByRole("list", { name: "Credited" })).toContainText("Play a track out loud");
    await expect(summary.getByRole("list", { name: "Credited" })).toContainText("Count phrases");
    await expect(summary).toContainText("Next: Lesson 4 · Set the level");
    await page.screenshot({ path: `${SHOTS}/desktop-4-summary.png` });
    await expectPlacedProfile(page, learnerId);

    // Start is live at once: Enter opens Lesson 4.
    await page.keyboard.press("Enter");
    await expect(page.locator("main.lesson h1")).toHaveText("Set the level", { timeout: 20_000 });
    await page.keyboard.press("Escape");
    await expect(page.locator('li[data-lesson="gain-staging"]')).toHaveAttribute("data-start", "true");
    await expect(page.locator('li[data-lesson="phrases"]')).toHaveAttribute("data-standing", "passed");
    await expect(page.getByRole("button", { name: "Re-take Placement" })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/desktop-5-list.png` });
  });

  test("Esc at the Mission skips Placement: nothing credited, Start opens Lesson 1", async ({ page }) => {
    const learnerId = learner("placement-skip");
    await page.goto(`/?learner=${learnerId}&track=synthetic`);
    await page.getByLabel("Why do you want to DJ?").press("Escape");
    const summary = page.getByRole("main", { name: "Placement summary" });
    await expect(summary).toContainText("Next: Lesson 1 · Play a track out loud");
    await expect.poll(async () => (await profileOf(page, learnerId)).placements?.[0]?.endReason, { timeout: 10_000 }).toBe("skippedAtMission");
    await page.keyboard.press("Enter");
    await expect(page.locator("main.lesson h1")).toHaveText("Play a track out loud", { timeout: 20_000 });
  });
});

test.describe("Placement on a phone (412×915, touch)", () => {
  test.use({ userAgent: devices["Pixel 7"].userAgent, isMobile: true, hasTouch: true, deviceScaleFactor: 1, viewport: { width: 412, height: 915 } });

  test("the same run by touch: buttons instead of keys, TAP for the phrases, pad 4 for the drop", async ({ page }) => {
    test.setTimeout(180_000);
    const learnerId = learner("placement-phone");
    await page.goto(`/?learner=${learnerId}&track=synthetic`);
    await page.getByLabel("Why do you want to DJ?").fill("post my own mixes");
    await page.screenshot({ path: `${SHOTS}/phone-1-mission.png` });
    await page.getByRole("button", { name: "Show me what you can do" }).tap();

    const gate = page.getByRole("region", { name: "Headphones check" });
    await gate.getByRole("button", { name: "They're on" }).tap();
    await gate.getByRole("button", { name: "Left" }).tap();
    await gate.getByRole("button", { name: "Right" }).tap();

    const notYet = page.getByRole("button", { name: "Not yet" });
    await taskPlaying(page, "blend-by-ear");
    await expect(notYet).toBeInViewport();
    const box = await notYet.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${SHOTS}/phone-2-task.png` });
    await notYet.tap();
    for (const task of ["bass-swap", "cut-on-phrase"]) {
      await taskPlaying(page, task);
      await notYet.tap();
    }

    await taskPlaying(page, "phrases");
    // Touch wording: the caption names TAP, not Space.
    await expect(caption(page)).toContainText("(TAP)");
    const tap = page.getByRole("button", { name: "Tap the beat" });
    for (const phrase of [5, 6, 7]) {
      // A phrase tap counts within a beat of the phrase start (≈ 480 ms): a tap a little after it is in.
      await pastBeat(page, phraseBeat(phrase) - 0.15);
      await tap.tap();
    }
    const questions = page.getByRole("region", { name: "Questions" });
    await expect(questions).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: `${SHOTS}/phone-3-question.png` });
    await questions.getByRole("button", { name: "4" }).tap();

    const card = page.getByRole("region", { name: "Result" });
    await expect(card).toHaveAttribute("data-outcome", "passed", { timeout: 10_000 });
    await expect(card).toBeInViewport();
    await page.screenshot({ path: `${SHOTS}/phone-4-card.png` });
    await card.getByRole("button", { name: "Next" }).tap();

    await taskPlaying(page, "cue-point");
    // The cue-point task's R is a finger-sized Ready button on a touchscreen.
    await expect(page.getByRole("button", { name: "Ready", exact: true })).toBeInViewport();
    await notYet.tap();

    const summary = page.getByRole("main", { name: "Placement summary" });
    await expect(summary).toContainText("Next: Lesson 4 · Set the level");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, "no sideways scroll").toBeLessThanOrEqual(0);
    await page.screenshot({ path: `${SHOTS}/phone-5-summary.png` });
    await expectPlacedProfile(page, learnerId);
    await summary.getByRole("button", { name: "Start Lesson 4" }).tap();
    await expect(placementMain(page)).toHaveCount(0);
    await expect(page.locator("main.lesson h1")).toHaveText("Set the level", { timeout: 20_000 });
  });
});
