import { expect, test, type Page } from "@playwright/test";
import { caption, commandsAtBeats, keysAtBeats, learner, openLesson, readyFromPhraseStart, resultCard, seedPassed, type LessonWindow } from "./lesson-support.ts";

// Lessons 12–13 end to end, muted, on the synthetic grooves: deck A 124 BPM, deck B a 121 BPM groove
// synced to it; both have the first beat at 0 s and bar 1 on beat 0. After a set-up off the clock (A
// looping phrase 2 until R), A plays from bar 9 (beat 32), a whole phrase; B comes in on bar 17 (beat
// 64) and the handover is on bar 25 (beat 96). Engine commands from the test
// stand in for knob and fader drags; keys are pressed where the Lesson has one (PLAY B, A's fader closed).

const BEFORE = ["deck-basics", "beats-and-bars", "phrases", "gain-staging", "headphone-cue", "cue-point", "cut-on-phrase", "tempo-fader", "sync-blend", "eq-basics"];

async function command(page: Page, sent: Record<string, unknown>): Promise<void> {
  const ok = await page.evaluate((payload) => (window as LessonWindow).learnToDjLesson?.engine.command(payload, { device: "trackpad" }).ok, sent);
  expect(ok, JSON.stringify(sent)).toBe(true);
}

/** Fader B up over a bar from `beat`, a step every 0.4 beats, as a trackpad drag sends it. */
const faderBUp = (beat: number) => Array.from({ length: 11 }, (_, step) => ({ beat: beat + step * 0.4, command: { control: "channel-fader", deck: "B", value: step / 10 } }));

test("bass-swap: LOW B cut, PLAY B on A's phrase start, the LOWs swapped on the next, passes", async ({ page }) => {
  test.setTimeout(180_000);
  const learnerId = learner("bassswap");
  await seedPassed(page, learnerId, BEFORE, { headphones: true });
  await openLesson(page, learnerId, "bass-swap");
  expect(await page.evaluate(() => (window as LessonWindow).learnToDjLesson?.deckTrack("B")?.grid.bpm)).toBe(121);

  // The hook: LOW B down, PLAY B, then a swap.
  await expect(caption(page)).toContainText("Turn LOW B all the way down");
  await command(page, { control: "eq-low", deck: "B", value: -1 });
  await expect(caption(page)).toContainText("On the phrase's 1: Press , and push fader B up");
  await command(page, { control: "play", deck: "B" });
  await expect(caption(page)).toContainText("Swap: LOW A down, LOW B up");
  await command(page, { control: "eq-low", deck: "A", value: -1 });
  await command(page, { control: "eq-low", deck: "B", value: 0 });
  await expect(page.locator("main.lesson")).toHaveAttribute("data-phase", "practice");
  await expect(caption(page)).toContainText("swap the LOWs on the next phrase's 1");

  // Practice cues the decks again, every EQ centred, and waits for its set-up (LOW B cut), then R. One swap on the 1 is enough.
  await command(page, { control: "eq-low", deck: "B", value: -1 });
  await readyFromPhraseStart(page, "practice", 32);
  await keysAtBeats(page, [64], { codes: ["Comma"] });
  await commandsAtBeats(page, [
    ...faderBUp(64.2),
    { beat: 95.85, command: { control: "eq-low", deck: "A", value: -1 } },
    { beat: 96.15, command: { control: "eq-low", deck: "B", value: 0 } },
  ]);
  await expect(caption(page)).toContainText("Ready? This one counts.");

  await page.keyboard.press("Enter");
  await expect(page.locator(".lesson-cue")).toHaveText("Set up: CUE 🎧 B on, LOW B all the way down — then R");
  await page.getByRole("button", { name: "Channel B headphone cue" }).click();
  await command(page, { control: "eq-low", deck: "B", value: -1 });
  await readyFromPhraseStart(page, "check", 32);
  await keysAtBeats(page, [64], { codes: ["Comma"] });
  await commandsAtBeats(page, [
    ...faderBUp(64.2),
    { beat: 95.85, command: { control: "eq-low", deck: "A", value: -1 } },
    { beat: 96.15, command: { control: "eq-low", deck: "B", value: 0 } },
  ]);
  await keysAtBeats(page, [104], { codes: ["KeyS"] });
  await commandsAtBeats(page, [{ beat: 105, command: { control: "eq-low", deck: "A", value: 0 } }]);

  const card = resultCard(page);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card, await card.innerText()).toHaveAttribute("data-outcome", "passed");
  await expect(card).toContainText("LOW B as B came in: all the way down");
  await expect(card).toContainText(/Bass swap 0\.\d\d beats from the phrase start/);
  await expect(card).toContainText("Two basslines at once: 0.00 beats");
});

test("filter-transition: CFX A swept to high-pass over 10 bars, B in on the phrase, A out, CFX back, passes", async ({ page }) => {
  test.setTimeout(180_000);
  const learnerId = learner("filter");
  await seedPassed(page, learnerId, BEFORE, { headphones: true });
  await openLesson(page, learnerId, "filter-transition");

  // The hook: CFX A right, left, then back to the middle; CFX B unlocks with the last step.
  await expect(caption(page)).toContainText("Turn CFX A right");
  await expect(page.locator('[data-control="A.filter"]')).toHaveAttribute("data-locked", "false");
  await expect(page.locator('[data-control="B.filter"]')).toHaveAttribute("data-locked", "true");
  await command(page, { control: "filter", deck: "A", value: 0.8 });
  await expect(caption(page)).toContainText("Now turn CFX A left");
  await command(page, { control: "filter", deck: "A", value: -0.8 });
  await expect(caption(page)).toContainText("CFX A back to the middle");
  await command(page, { control: "filter", deck: "A", value: 0 });
  await expect(page.locator("main.lesson")).toHaveAttribute("data-phase", "practice");
  await expect(page.locator('[data-control="B.filter"]')).toHaveAttribute("data-locked", "false");

  // CFX A from 2 bars before B (beat 56) to 85% by beat 88; PLAY B on beat 64 and fader B up.
  const sweep = Array.from({ length: 81 }, (_, step) => ({ beat: 56 + step * 0.4, command: { control: "filter", deck: "A", value: 0.06 + (0.79 * step) / 80 } }));
  const timed = [...sweep, { beat: 64, command: { control: "play", deck: "B" } }, ...faderBUp(64.2)].sort((a, b) => a.beat - b.beat);

  // Practice cues the decks again, CFX centred, and waits for R: one filter-out of 10 bars is enough.
  await readyFromPhraseStart(page, "practice", 32);
  await commandsAtBeats(page, timed);
  await keysAtBeats(page, [96], { codes: ["KeyS"] });
  await expect(caption(page)).toContainText("Ready? This one counts.");

  await page.keyboard.press("Enter");
  await expect(page.locator(".lesson-cue")).toHaveText("Set up: CUE 🎧 B on — then R");
  await page.getByRole("button", { name: "Channel B headphone cue" }).click();
  await readyFromPhraseStart(page, "check", 32);
  await commandsAtBeats(page, timed);
  await keysAtBeats(page, [96], { codes: ["KeyS"] });
  await commandsAtBeats(page, [{ beat: 97, command: { control: "filter", deck: "A", value: 0 } }]);

  const card = resultCard(page);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card, await card.innerText()).toHaveAttribute("data-outcome", "passed");
  await expect(card).toContainText("CFX A: up to 85% high-pass (need 70%)");
  await expect(card).toContainText(/Filter on (9|10)\.\d bars before A went out \(need 8–16\)/);
  await expect(card).toContainText(/CFX A back 0\.\d\d bars after A went out/);
});
