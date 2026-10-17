import { expect, test, type Page } from "@playwright/test";
import { caption, commandsAtBeats, keysAtBeats, learner, openLesson, playingPast, resultCard, seedPassed, type LessonWindow } from "./lesson-support.ts";

// Lessons 8–11 end to end, muted, on the synthetic grooves: deck A 124 BPM, and for the two-track
// Lessons a 121 BPM groove on deck B; both have the first beat at 0 s and bar 1 on beat 0. Engine
// commands from the test stand in for knob and fader drags; keys are pressed where the Lesson has one.

// The Check waits use a wide window: a busy machine can jump the heard playhead by a second or more,
// and the next steps are clicks or wait for a later beat anyway.
const FIRST_SEVEN = ["deck-basics", "beats-and-bars", "phrases", "gain-staging", "headphone-cue", "cue-point", "cut-on-phrase"];
const BPM = 124;

async function command(page: Page, sent: Record<string, unknown>): Promise<void> {
  const ok = await page.evaluate((payload) => (window as LessonWindow).learnToDjLesson?.engine.command(payload, { device: "trackpad" }).ok, sent);
  expect(ok, JSON.stringify(sent)).toBe(true);
}

/** The tempo fader (on the ±6% range) that plays the 124 BPM groove at `bpm`. */
const faderFor = (bpm: number) => ((bpm / BPM - 1) * 100) / 6;

test("tempo-fader: three BPMs set and confirmed with Ready, then both Master Tempo clips named, passes", async ({ page }) => {
  test.setTimeout(90_000);
  const learnerId = learner("tempo");
  await seedPassed(page, learnerId, ["deck-basics"]);
  await openLesson(page, learnerId, "tempo-fader");

  // The hook: TEMPO B, then MASTER TEMPO B, then the range. B plays from the start.
  await expect(caption(page)).toContainText("Slide TEMPO B");
  await expect(page.locator('[data-control="B.bpm"]')).toHaveAttribute("data-locked", "false");
  await command(page, { control: "tempo", deck: "B", value: 0.2 });
  await expect(caption(page)).toContainText("Press MASTER TEMPO B");
  await page.getByRole("button", { name: "Deck B master tempo" }).click();
  await expect(caption(page)).toContainText("Tap ±6% on B");
  await page.getByRole("button", { name: /Deck B tempo range/ }).click();
  await expect(caption(page)).toContainText("Set B to 126.0 BPM, then R");

  await page.keyboard.press("Enter");
  const cue = page.locator(".lesson-cue");
  for (const [index, bpm] of [127, 121.5, 125.5].entries()) {
    await expect(cue).toHaveText([`Set B to 127.0 BPM, then R`, "Now 121.5 BPM, then R", "Last one: 125.5 BPM, then R"][index] ?? "");
    await command(page, { control: "tempo", deck: "B", value: faderFor(bpm) });
    await expect(page.locator('[data-control="B.bpm"] .readout-number')).toHaveText(bpm.toFixed(1));
    await page.waitForTimeout(300);
    await page.keyboard.press("KeyR");
  }

  // The questions: each plays its clip; the test reads which Master Tempo the clip has.
  for (const number of [1, 2]) {
    const question = page.getByRole("group", { name: `Clip ${String(number)}: Master Tempo on or off?` });
    await expect(question).toBeVisible();
    await expect.poll(async () => page.evaluate(() => (window as LessonWindow).learnToDjLesson?.engine.deckState("B").playing)).toBe(true);
    const on = await page.evaluate(() => (window as LessonWindow).learnToDjLesson?.clip?.()?.masterTempo);
    expect(on).not.toBeUndefined();
    // The controller must not give the answer away: MASTER TEMPO B is unlit and locked while a clip plays.
    const masterTempoB = page.locator('[data-control="B.master-tempo"]');
    await expect(masterTempoB.locator("button")).toHaveAttribute("aria-pressed", "false");
    await expect(masterTempoB).toHaveAttribute("data-locked", "true");
    await question.getByRole("button", { name: on === true ? "On" : "Off" }).click();
  }

  const card = resultCard(page);
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card, await card.innerText()).toHaveAttribute("data-outcome", "passed");
  await expect(card).toContainText(/BPMs: worst 0\.0\d BPM off/);
  await expect(card).toContainText("Master Tempo clips: 2 of 2 right");
  await expect(card).toContainText("Unlocked: Blend with sync");
});

/** A blend on the channel faders over `bars`, in steps, B's amplitude rising as A's falls. */
function channelBlend(fromBeat: number, bars: number): { beat: number; command: Record<string, unknown> }[] {
  // A step every 0.4 beats (under 200 ms): one continuous drag, as a trackpad sends it.
  const steps = Math.round((bars * 4) / 0.4);
  return Array.from({ length: steps + 1 }, (_, step) => {
    const share = step / steps;
    const beat = fromBeat + (share * bars * 4);
    // Amplitude is position²: equal steps in amplitude keep the sum steady.
    return [
      { beat, command: { control: "channel-fader", deck: "B", value: Math.sqrt(share) } },
      { beat, command: { control: "channel-fader", deck: "A", value: Math.sqrt(1 - share) } },
    ];
  }).flat();
}

test("sync-blend: SYNC B, PLAY B on A's phrase start, a 10-bar channel-fader blend, passes", async ({ page }) => {
  test.setTimeout(120_000);
  const learnerId = learner("syncblend");
  await seedPassed(page, learnerId, [...FIRST_SEVEN, "tempo-fader"], { headphones: true });
  await openLesson(page, learnerId, "sync-blend");
  await expect(caption(page)).toContainText("Press BEAT SYNC on B");
  // Deck B holds the second groove, slower: SYNC has something to do.
  expect(await page.evaluate(() => (window as LessonWindow).learnToDjLesson?.deckTrack("B")?.grid.bpm)).toBe(121);

  // A leads in from bar 3 (beat 8); the blend starts on phrase 2 (bar 9, beat 32).
  await page.keyboard.press("Enter");
  await playingPast(page, "check", 8.5, { before: 20 });
  await page.getByRole("button", { name: "Channel B headphone cue" }).click();
  await page.getByRole("button", { name: "Deck B beat sync" }).click();
  await expect.poll(async () => page.evaluate(() => (window as LessonWindow).learnToDjLesson?.engine.deckState("B").syncOn)).toBe(true);
  await keysAtBeats(page, [32], { codes: ["Comma"] });
  await commandsAtBeats(page, channelBlend(32, 10));

  const card = resultCard(page);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card, await card.innerText()).toHaveAttribute("data-outcome", "passed");
  await expect(card).toContainText(/Blend start: 0\.\d\d beats from the phrase start/);
  await expect(card).toContainText(/Blend: (8|9)\.\d bars/);
  await expect(card).toContainText("TRIM left alone during the blend");
});

test("crossfader: a crossfader blend to B on the phrase, then a cut back to A with C, passes", async ({ page }) => {
  test.setTimeout(120_000);
  const learnerId = learner("crossfader");
  await seedPassed(page, learnerId, [...FIRST_SEVEN, "tempo-fader", "sync-blend"], { headphones: true });
  await openLesson(page, learnerId, "crossfader");
  await expect(caption(page)).toContainText("Press , to play B");

  // A from bar 3 (beat 8); the blend on bar 9 (beat 32); the cut back to A on bar 25 (beat 96).
  await page.keyboard.press("Enter");
  await playingPast(page, "check", 8.5, { before: 20 });
  await page.getByRole("button", { name: "Channel B headphone cue" }).click();
  await keysAtBeats(page, [32], { codes: ["Comma"] });
  // One slow, even move over the 10 bars asked (a step every 0.4 beats, as a trackpad drag): the
  // constant-power curve holds the loudness through the middle.
  const steps = Math.round(40 / 0.4);
  const blend = Array.from({ length: steps }, (_, step) => ({ beat: 32 + (step + 1) * 0.4, command: { control: "crossfader", value: (step + 1) / steps } }));
  await commandsAtBeats(page, blend);
  await page.getByRole("button", { name: "Channel A headphone cue" }).click();
  await keysAtBeats(page, [96], { codes: ["KeyC"] });

  const card = resultCard(page);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card, await card.innerText()).toHaveAttribute("data-outcome", "passed");
  await expect(card).toContainText("Crossfader blend: on the phrase");
  await expect(card).toContainText("Crossfader cut to A: on the phrase");
  await expect(card).toContainText("Channel faders: lowest at 100%");
});

test("eq-basics: LOW A cut on the phrase start and back on the next, EQs centred, passes", async ({ page }) => {
  test.setTimeout(90_000);
  const learnerId = learner("eq");
  await seedPassed(page, learnerId, ["deck-basics", "beats-and-bars", "phrases", "gain-staging"]);
  await openLesson(page, learnerId, "eq-basics");

  await expect(caption(page)).toContainText("Turn LOW A all the way down");
  await command(page, { control: "eq-low", deck: "A", value: -1 });
  await expect(caption(page)).toContainText("Turn LOW A back to the middle");
  await command(page, { control: "eq-low", deck: "A", value: 0 });
  await expect(page.locator("main.lesson")).toHaveAttribute("data-phase", "practice");

  // A from bar 15 (beat 56): LOW down on bar 17 (beat 64), back on bar 25 (beat 96).
  await page.keyboard.press("Enter");
  await playingPast(page, "check", 56.5, { before: 62 });
  await commandsAtBeats(page, [
    { beat: 63.9, command: { control: "eq-low", deck: "A", value: -1 } },
    { beat: 96, command: { control: "eq-low", deck: "A", value: 0 } },
  ]);

  const card = resultCard(page);
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card, await card.innerText()).toHaveAttribute("data-outcome", "passed");
  await expect(card).toContainText(/LOW cut: [78]\.\d bars at the bottom/);
  await expect(card).toContainText(/LOW back 0\.\d\d beats from the phrase start/);
});
