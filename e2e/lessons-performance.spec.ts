import { expect, test, type Page } from "@playwright/test";
import { caption, keysAtBeats, learner, openLesson, playingPast, readyFromPhraseStart, resultCard, seedPassed, type LessonWindow } from "./lesson-support.ts";

// Lessons 17–19 end to end, muted, on the synthetic groove (124 BPM, first beat at 0 s, bar 1 on beat
// 0, so bar n starts on beat 4(n − 1)). Keys are pressed on beats of the engine's own heard playhead;
// engine commands stand in for knob turns and the jog wheel.

const FIRST_SIX = ["deck-basics", "beats-and-bars", "phrases", "gain-staging", "headphone-cue", "cue-point"];
const TO_SYNC_BLEND = [...FIRST_SIX, "cut-on-phrase", "tempo-fader", "sync-blend"];
const BEAT_SEC = 60 / 124;

async function command(page: Page, sent: Record<string, unknown>): Promise<void> {
  const ok = await page.evaluate((payload) => (window as LessonWindow).djTutorialLesson?.engine.command(payload, { device: "trackpad" }).ok, sent);
  expect(ok, JSON.stringify(sent)).toBe(true);
}

/**
 * Presses a key on the next pass through a looping deck's loop start: when its heard playhead next
 * reaches `loopEndBeat` (and wraps back). The event carries that moment as its timeStamp, as
 * keysAtBeats does.
 */
async function keyAtLoopWrap(page: Page, loopEndBeat: number, code: string): Promise<void> {
  await playingPast(page, "check", loopEndBeat - 3, { before: loopEndBeat });
  await page.evaluate(
    async ({ end, key }) => {
      const lesson = (window as LessonWindow).djTutorialLesson;
      if (lesson === undefined) throw new Error("No Lesson is open.");
      const beatMs = 60_000 / lesson.track.grid.bpm;
      const now = performance.now();
      const heard = lesson.engine.heardTime(now);
      const beat = heard.ok && heard.ctx !== undefined ? lesson.engine.playheadAt("A", heard.ctx)?.beat : null;
      if (beat == null) throw new Error("Deck A has no playhead reading.");
      const atMs = now + (end - beat) * beatMs;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, atMs - performance.now() - 2)));
      for (const type of ["keydown", "keyup"] as const) {
        const event = new KeyboardEvent(type, { code: key });
        Object.defineProperty(event, "timeStamp", { value: atMs });
        window.dispatchEvent(event);
      }
    },
    { end: loopEndBeat, key: code },
  );
}

/** Sends engine commands (knob turns) on the next pass through deck A's loop start, as keyAtLoopWrap presses a key. */
async function commandsAtLoopWrap(page: Page, loopEndBeat: number, commands: readonly Record<string, unknown>[]): Promise<void> {
  await playingPast(page, "check", loopEndBeat - 3, { before: loopEndBeat });
  const refused = await page.evaluate(
    async ({ end, sent }) => {
      const lesson = (window as LessonWindow).djTutorialLesson;
      if (lesson === undefined) throw new Error("No Lesson is open.");
      const beatMs = 60_000 / lesson.track.grid.bpm;
      const reading = lesson.engine.playhead("A");
      const beat = reading.ok ? reading.beat : null;
      if (beat == null) throw new Error("Deck A has no playhead reading.");
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, (end - beat) * beatMs - 2)));
      return sent.filter((each) => !lesson.engine.command(each, { device: "trackpad" }).ok);
    },
    { end: loopEndBeat, sent: commands },
  );
  expect(refused, "commands the engine refused").toEqual([]);
}

test("hot-cues: three pads set at the stops, then pressed on A's phrase starts, passes", async ({ page }) => {
  test.setTimeout(150_000);
  const learnerId = learner("hotcues");
  await seedPassed(page, learnerId, FIRST_SIX);
  await openLesson(page, learnerId, "hot-cues");

  await expect(caption(page)).toContainText("Press 2: pad 2 keeps this spot");
  await page.keyboard.press("Digit2");
  await expect(caption(page)).toContainText("Press 2 again");
  await page.keyboard.press("Digit2");
  await expect(page.locator("main.lesson")).toHaveAttribute("data-phase", "practice");
  await expect(caption(page)).toContainText("Pad 1 is the drop");

  // The Check parks A just before the drop, the groove and the outro (1.37, 2.62, 0.71 beats early):
  // jog to each 1, press the pad, then R.
  await page.keyboard.press("Enter");
  const cue = page.locator(".lesson-cue");
  for (const [index, lead] of [1.37, 2.62, 0.71].entries()) {
    await expect(cue).toContainText(`Pad ${String(index + 1)}:`);
    await expect.poll(async () => page.evaluate(() => (window as LessonWindow).djTutorialLesson?.engine.deckState("A").playing)).toBe(false);
    await command(page, { control: "jog-search", deck: "A", value: lead * BEAT_SEC });
    await page.keyboard.press(`Digit${String(index + 1)}`);
    await page.keyboard.press("KeyR");
  }

  // A plays from bar 9 (beat 32), a whole phrase. Pad 1 on bar 17 (beat 64) jumps to the drop (bar 49, beat 192); pad 2 on
  // bar 57 (beat 224) back to the groove (beat 64); pad 3 on bar 25 (beat 96) to the outro.
  await playingPast(page, "check", 32.5, { before: 44 });
  await keysAtBeats(page, [64], { codes: ["Digit1"] });
  await playingPast(page, "check", 192.5, { before: 210 });
  await keysAtBeats(page, [224], { codes: ["Digit2"] });
  await playingPast(page, "check", 64.5, { before: 80 });
  await keysAtBeats(page, [96], { codes: ["Digit3"] });

  const card = resultCard(page);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card, await card.innerText()).toHaveAttribute("data-outcome", "passed");
  await expect(card).toContainText(/Hot cues: worst \d+ ms off a phrase start/);
  await expect(card).toContainText(/Pad presses: worst \d+ ms from the phrase start/);
});

test("loop-transition: LOOP IN and OUT over A's outro, B on the loop's 1, EXIT on the next, passes", async ({ page }) => {
  test.setTimeout(120_000);
  const learnerId = learner("loop");
  await seedPassed(page, learnerId, TO_SYNC_BLEND, { headphones: true });
  await openLesson(page, learnerId, "loop-transition");

  await expect(caption(page)).toContainText("Press G: a 4-beat loop");
  await page.keyboard.press("KeyG");
  await expect(caption(page)).toContainText("Press G again: EXIT");
  await expect(caption(page)).toContainText("Press G again: EXIT");
  await page.keyboard.press("KeyG");
  await expect(caption(page)).toContainText("LOOP IN on a 1 (D)");
  await page.keyboard.press("KeyD");
  await expect(caption(page)).toContainText("LOOP OUT on a 1");
  await page.waitForTimeout(600);
  await page.keyboard.press("KeyF");
  await expect(page.locator("main.lesson")).toHaveAttribute("data-phase", "practice");

  // In practice, every loop control is open. On a 4 BEAT loop, ½X (5, CUE/LOOP CALL ◀) halves it and 2X
  // (on screen, ▶) doubles it back. Shift + D is the FLX4's IN ADJ, not in v1: "not yet", the loop stays.
  const loopSec = async () =>
    page.evaluate(() => {
      const loop = (window as LessonWindow).djTutorialLesson?.engine.deckState("A").loop;
      return loop === null || loop === undefined ? null : loop.end - loop.start;
    });
  if ((await loopSec()) === null) await page.keyboard.press("KeyG");
  await expect.poll(loopSec).not.toBeNull();
  const startSec = (await loopSec()) ?? 0;
  await page.keyboard.press("Digit5");
  await expect.poll(loopSec).toBeCloseTo(startSec / 2, 3);
  await page.getByRole("button", { name: "Deck A loop 2X" }).click();
  await expect.poll(loopSec).toBeCloseTo(startSec, 3);
  await page.keyboard.press("Shift+KeyD");
  await expect(page.locator('[data-control="A.loop-in"] .not-yet')).toBeVisible();
  expect(await loopSec()).toBeCloseTo(startSec, 3);

  // Set up off the clock (A looping bars 57–64, beats 224–256), then go: A from bar 57 (beat 224), a whole
  // phrase; LOOP IN on the outro's phrase start (bar 65, beat 256), LOOP OUT 4 bars on (beat 272).
  await page.keyboard.press("Enter");
  await expect(page.locator(".lesson-cue")).toHaveText("Set up: CUE 🎧 B on");
  await page.getByRole("button", { name: "Channel B headphone cue" }).click();
  await readyFromPhraseStart(page, "check", 224);
  await keysAtBeats(page, [256], { codes: ["KeyD"] });
  await keysAtBeats(page, [272], { codes: ["KeyF"] });
  await expect.poll(async () => page.evaluate(() => (window as LessonWindow).djTutorialLesson?.engine.deckState("A").loop)).not.toBeNull();
  // B on the loop's 1 (the next wrap), EXIT on the one after; then fader A down.
  await keyAtLoopWrap(page, 272, "Comma");
  await keyAtLoopWrap(page, 272, "KeyG");
  await page.waitForTimeout(500);
  await page.keyboard.press("KeyS");

  const card = resultCard(page);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card, await card.innerText()).toHaveAttribute("data-outcome", "passed");
  await expect(card).toContainText(/Loop: 4\.00 bars/);
  await expect(card).toContainText("B in: on the loop's 1, on B's phrase");
});

test("loop-transition after the bass swap: LOW B cut, B on the loop's 1, the bass swapped on the next, EXIT, passes with no warning", async ({ page }) => {
  test.setTimeout(120_000);
  const learnerId = learner("loopswap");
  await seedPassed(page, learnerId, [...TO_SYNC_BLEND, "eq-basics", "bass-swap", "nudge-phase", "tempo-by-ear", "blend-by-ear"], { headphones: true });
  await openLesson(page, learnerId, "loop-transition");
  await expect(caption(page)).toContainText("Press G: a 4-beat loop");
  await page.keyboard.press("KeyG");
  await expect(caption(page)).toContainText("Press G again: EXIT");
  await page.keyboard.press("KeyG");
  await expect(caption(page)).toContainText("LOOP IN on a 1 (D)");
  await page.keyboard.press("KeyD");
  await expect(caption(page)).toContainText("LOOP OUT on a 1");
  await page.waitForTimeout(600);
  await page.keyboard.press("KeyF");
  await expect(page.locator("main.lesson")).toHaveAttribute("data-phase", "practice");
  // Practice may leave the loop on: the Check's set-up cues A from before it anyway.

  const cue = page.locator(".lesson-cue");
  await page.keyboard.press("Enter");
  await expect(cue).toHaveText("Set up: CUE 🎧 B on, LOW B all the way down");
  await page.getByRole("button", { name: "Channel B headphone cue" }).click();
  await command(page, { control: "eq-low", deck: "B", value: -1 });
  await readyFromPhraseStart(page, "check", 224);
  await keysAtBeats(page, [256], { codes: ["KeyD"] });
  await keysAtBeats(page, [272], { codes: ["KeyF"] });
  await keyAtLoopWrap(page, 272, "Comma");
  await expect(cue).toHaveText("Next loop's 1: swap the bass. LOW A down, LOW B up");
  await commandsAtLoopWrap(page, 272, [
    { control: "eq-low", deck: "A", value: -1 },
    { control: "eq-low", deck: "B", value: 0 },
  ]);
  await expect(cue).toHaveText("Next loop's 1: EXIT (G)");
  await keyAtLoopWrap(page, 272, "KeyG");
  await page.waitForTimeout(500);
  await page.keyboard.press("KeyS");
  await page.waitForTimeout(300);
  await command(page, { control: "eq-low", deck: "A", value: 0 });

  const card = resultCard(page);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card, await card.innerText()).toHaveAttribute("data-outcome", "passed");
  await expect(card).toContainText(/Loop: 4\.00 bars/);
  // one-bass is graded (blend-by-ear passed): following the captions, nothing is missed, not even a warning.
  await expect(card.locator('li[data-status="notMet"]')).toHaveCount(0);
});

test("echo-out: ECHO on, A cut on the last bar's 1, B on the phrase's 1, FX off as it fades, passes", async ({ page }) => {
  test.setTimeout(120_000);
  const learnerId = learner("echo");
  await seedPassed(page, learnerId, TO_SYNC_BLEND, { headphones: true });
  await openLesson(page, learnerId, "echo-out");

  await expect(caption(page)).toContainText("Press V: BEAT FX on");
  await expect(page.locator('[data-control="beat-fx-channel"]')).toHaveAttribute("data-locked", "false");
  await page.keyboard.press("KeyV");
  await expect(caption(page)).toContainText("Turn DEPTH");
  await command(page, { control: "beat-fx-depth", value: 0.8 });
  await expect(caption(page)).toContainText("Press ] for longer echoes");
  await page.keyboard.press("BracketRight");
  await expect(caption(page)).toContainText("Pull the fader down (S)");
  await page.keyboard.press("KeyS");
  await expect(page.locator("main.lesson")).toHaveAttribute("data-phase", "practice");

  // Set up off the clock (CUE B, ECHO on), then go: A from bar 9 (beat 32), two phrases; cut on bar 24
  // (beat 92); B on bar 25 (beat 96); FX off 2 bars later.
  await page.keyboard.press("Enter");
  await expect(page.locator(".lesson-cue")).toHaveText("Set up: CUE 🎧 B on, ECHO on (V)");
  await page.getByRole("button", { name: "Channel B headphone cue" }).click();
  await page.keyboard.press("KeyV");
  await readyFromPhraseStart(page, "check", 32);
  await keysAtBeats(page, [92], { codes: ["KeyS"] });
  await keysAtBeats(page, [96], { codes: ["Comma"] });
  await keysAtBeats(page, [103], { codes: ["KeyV"] });

  const card = resultCard(page);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card, await card.innerText()).toHaveAttribute("data-outcome", "passed");
  await expect(card).toContainText(/Echo cut: 0\.\d\d beats off the 1/);
  await expect(card).toContainText(/FX off/);
});
