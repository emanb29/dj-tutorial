import { expect, test, type Page } from "@playwright/test";
import { caption, commandsAtBeats, keysAtBeats, learner, openLesson, playingPast, readyFromPhraseStart, resultCard, seedPassed, type LessonWindow } from "./lesson-support.ts";

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

  // The hook: TEMPO B fast (higher, Master Tempo off), then Master Tempo B (BEAT SYNC held, as on the
  // FLX4), then the range. B plays from the start.
  await expect(caption(page)).toContainText("Slide TEMPO B near +: faster");
  await expect(page.locator('[data-control="B.bpm"]')).toHaveAttribute("data-locked", "false");
  // A nudge is too little to hear the pitch rise: the step waits for 4% faster or more.
  await command(page, { control: "tempo", deck: "B", value: 0.2 });
  await page.waitForTimeout(300);
  await expect(caption(page)).toContainText("Slide TEMPO B near +: faster");
  await command(page, { control: "tempo", deck: "B", value: 0.8 });
  await expect(caption(page)).toContainText("TEMPO: faster, and higher.");
  await expect(caption(page)).toContainText("Hold BEAT SYNC B: Master Tempo");
  const syncB = page.getByRole("button", { name: /Deck B beat sync/ });
  await syncB.hover();
  await page.mouse.down();
  await expect(page.getByTestId("master-tempo-lamp-B")).toHaveAttribute("data-on", "true");
  await page.mouse.up();
  await expect(caption(page)).toContainText("Master Tempo on: still fast, back in key.");
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
    // The controller must not give the answer away: BEAT SYNC B (Master Tempo when held) is unlit and locked while a clip plays.
    await expect(page.getByTestId("master-tempo-lamp-B")).toHaveAttribute("data-on", "false");
    await expect(page.locator('[data-control="B.sync"]')).toHaveAttribute("data-locked", "true");
    await question.getByRole("button", { name: on === true ? "On" : "Off" }).click();
  }

  const card = resultCard(page);
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card, await card.innerText()).toHaveAttribute("data-outcome", "passed");
  await expect(card).toContainText(/BPMs: worst 0\.0\d BPM off/);
  await expect(card).toContainText("Master Tempo clips: 2 of 2 right");
  await expect(card).toContainText("Unlocked: Blend with sync");
});

test("tempo-fader where Master Tempo cannot load: no MASTER TEMPO step, no clip questions, the BPMs alone pass", async ({ page }) => {
  test.setTimeout(90_000);
  // signalsmith-stretch loads its worklet from a blob URL; refusing it is the failure a browser can have.
  await page.addInitScript(() => {
    const original = Object.getOwnPropertyDescriptor(Worklet.prototype, "addModule")?.value as (this: Worklet, url: string | URL, options?: WorkletOptions) => Promise<void>;
    AudioWorklet.prototype.addModule = function (this: AudioWorklet, url: string | URL, options?: WorkletOptions) {
      return String(url).startsWith("blob:") ? Promise.reject(new Error("blocked by the test")) : original.call(this, url, options);
    };
  });
  const learnerId = learner("tempo-no-mt");
  await seedPassed(page, learnerId, ["deck-basics"]);
  await openLesson(page, learnerId, "tempo-fader");
  expect(await page.evaluate(() => (window as LessonWindow).learnToDjLesson?.engine.deckState("B").masterTempoAvailability?.available)).toBe(false);

  await expect(caption(page)).toContainText("Slide TEMPO B near +: faster");
  await command(page, { control: "tempo", deck: "B", value: 0.8 });
  await expect(caption(page)).toContainText("Tap ±6% on B");
  await page.getByRole("button", { name: /Deck B tempo range/ }).click();
  // Practice says why there will be no clips.
  await expect(caption(page)).toContainText("Set B to 126.0 BPM, then R · Master Tempo can't load here, so no clips");

  // Practice ready: no ear round without Master Tempo.
  // Each Ready puts B's tempo back to centre for the next rep.
  for (let rep = 0; rep < 2; rep += 1) {
    await command(page, { control: "tempo", deck: "B", value: faderFor(126) });
    await expect(page.locator('[data-control="B.bpm"] .readout-number')).toHaveText("126.0");
    await page.waitForTimeout(300);
    await page.keyboard.press("KeyR");
  }
  await expect(caption(page)).toContainText("Ready? This one counts.");
  await expect(page.getByTestId("ear-round")).toHaveCount(0);

  await page.keyboard.press("Enter");
  for (const bpm of [127, 121.5, 125.5]) {
    await command(page, { control: "tempo", deck: "B", value: faderFor(bpm) });
    await expect(page.locator('[data-control="B.bpm"] .readout-number')).toHaveText(bpm.toFixed(1));
    await page.waitForTimeout(300);
    await page.keyboard.press("KeyR");
  }

  const card = resultCard(page);
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("group", { name: /Clip 1/ })).toHaveCount(0);
  await expect(card, await card.innerText()).toHaveAttribute("data-outcome", "passed");
  await expect(card).toContainText(/BPMs: worst 0\.0\d BPM off/);
  await expect(card).not.toContainText("Master Tempo clips");
});

test("tempo-fader practice: once the BPMs are ready, Off and On clips to compare and an unscored mystery with a line on each answer", async ({ page }) => {
  test.setTimeout(90_000);
  const learnerId = learner("tempo-ear");
  await seedPassed(page, learnerId, ["deck-basics"]);
  await openLesson(page, learnerId, "tempo-fader");
  await expect(caption(page)).toContainText("Slide TEMPO B near +: faster");
  await command(page, { control: "tempo", deck: "B", value: 0.8 });
  await expect(caption(page)).toContainText("Hold BEAT SYNC B: Master Tempo");
  await page.getByRole("button", { name: /Deck B beat sync/ }).hover();
  await page.mouse.down();
  await expect(page.getByTestId("master-tempo-lamp-B")).toHaveAttribute("data-on", "true");
  await page.mouse.up();
  await page.getByRole("button", { name: /Deck B tempo range/ }).click();
  await expect(caption(page)).toContainText("Set B to 126.0 BPM, then R");
  await expect(page.getByTestId("ear-round")).toHaveCount(0);

  // Two Readies on 126.0 BPM: practice is ready, and asks for the ear round before the Check.
  // Each Ready puts B's tempo back to centre for the next rep.
  for (let rep = 0; rep < 2; rep += 1) {
    await command(page, { control: "tempo", deck: "B", value: faderFor(126) });
    await expect(page.locator('[data-control="B.bpm"] .readout-number')).toHaveText("126.0");
    await page.waitForTimeout(300);
    await page.keyboard.press("KeyR");
  }
  await expect(caption(page)).toContainText("By ear first: Off, On, then try one.");
  const round = page.getByTestId("ear-round");
  await expect(round).toContainText("Master Tempo keeps the key: vocals sound natural.");
  const clip = async () => page.evaluate(() => (window as LessonWindow).learnToDjLesson?.clip?.() ?? null);

  // Labelled clips: the Check's own clip, Master Tempo as named.
  for (const [label, masterTempo] of [["▶ Off", false], ["▶ On", true]] as const) {
    await round.getByRole("button", { name: label }).click();
    await expect.poll(async () => (await clip())?.masterTempo).toBe(masterTempo);
    await expect.poll(async () => page.evaluate(() => (window as LessonWindow).learnToDjLesson?.engine.deckState("B").playing)).toBe(true);
  }

  // The mystery: no answer before it plays; while it plays the controller does not give it away.
  const tryOne = round.getByRole("group", { name: "Try one: on or off?" });
  await expect(tryOne.getByRole("button", { name: "On", exact: true })).toBeDisabled();
  await tryOne.getByRole("button", { name: "▶ Mystery" }).click();
  await expect.poll(async () => (await clip())?.masterTempo).not.toBeUndefined();
  await expect(page.getByTestId("master-tempo-lamp-B")).toHaveAttribute("data-on", "false");
  await expect(page.locator('[data-control="B.sync"]')).toHaveAttribute("data-locked", "true");
  const first = (await clip())?.masterTempo === true;
  await tryOne.getByRole("button", { name: first ? "On" : "Off", exact: true }).click();
  await expect(page.getByTestId("ear-round-line")).toHaveText(first ? "Right: On. Faster, same note." : "Right: Off. Faster, and higher.");
  await expect(round).toContainText("1 of 1 right");
  await expect.poll(clip).toBeNull();

  // A wrong answer says what it was.
  await tryOne.getByRole("button", { name: "▶ Mystery" }).click();
  await expect.poll(async () => (await clip())?.masterTempo).not.toBeUndefined();
  const second = (await clip())?.masterTempo === true;
  await tryOne.getByRole("button", { name: second ? "Off" : "On", exact: true }).click();
  await expect(page.getByTestId("ear-round-line")).toHaveText(second ? "That was On: faster, same note." : "That was Off: faster, and higher.");
  await expect(round).toContainText("1 of 2 right");

  // Enter goes on to the Check, as ever: the round closes, and the Check sets the decks up again.
  await round.getByRole("button", { name: "▶ On" }).click();
  await page.keyboard.press("Enter");
  await expect(round).toHaveCount(0);
  await expect(page.locator(".lesson-cue")).toHaveText("Set B to 127.0 BPM, then R");
  await expect.poll(clip).toBeNull();
});

/** One fader dragged from `from` to `to` over half a beat, starting on `beat` (a trackpad drag in steps). */
function drag(beat: number, deck: "A" | "B", from: number, to: number): { beat: number; command: Record<string, unknown> }[] {
  return Array.from({ length: 6 }, (_, step) => ({ beat: beat + step * 0.1, command: { control: "channel-fader", deck, value: from + ((to - from) * step) / 5 } }));
}

/** The stepped blend one pointer can make: B to ¾ on the 1, A to ¾ a beat later, then B up and A down on bar 9. */
const steppedBlend = (fromBeat: number) => [
  ...drag(fromBeat, "B", 0, 0.75),
  ...drag(fromBeat + 1, "A", 1, 0.75),
  ...drag(fromBeat + 36, "B", 0.75, 1),
  ...drag(fromBeat + 37, "A", 0.75, 0),
];

/** What a single pointer does without the steps: B all the way up, A all the way down later. */
const naiveBlend = (fromBeat: number) => [...drag(fromBeat, "B", 0, 1), ...drag(fromBeat + 36, "A", 1, 0)];

async function syncBlendCheck(page: Page, name: string, moves: (fromBeat: number) => { beat: number; command: Record<string, unknown> }[]) {
  const learnerId = learner(name);
  await seedPassed(page, learnerId, [...FIRST_SEVEN, "tempo-fader"], { headphones: true });
  await openLesson(page, learnerId, "sync-blend");
  await expect(caption(page)).toContainText("Press BEAT SYNC on B");
  // Deck B holds the second groove, slower: SYNC has something to do.
  expect(await page.evaluate(() => (window as LessonWindow).learnToDjLesson?.deckTrack("B")?.grid.bpm)).toBe(121);

  // Set up off the clock, A looping Phrase 1 (bar 1, beat 0), then go: PLAY B on Phrase 2 (bar 9,
  // beat 32) with its fader down, and the blend on Phrase 3 (bar 17, beat 64).
  await page.keyboard.press("Enter");
  await expect(page.locator(".lesson-cue")).toHaveText("Set up: SYNC B on, CUE 🎧 B on");
  await page.getByRole("button", { name: "Channel B headphone cue" }).click();
  await page.getByRole("button", { name: "Deck B beat sync" }).click();
  await expect.poll(async () => page.evaluate(() => (window as LessonWindow).learnToDjLesson?.engine.deckState("B").syncOn)).toBe(true);
  await readyFromPhraseStart(page, "check", 0);
  await expect(page.locator(".lesson-cue")).toHaveText("Phrase 1: just count. Press , at Phrase 2, bar 1", { timeout: 20_000 });
  await expect(page.getByTestId("phrase-count")).toContainText("Phrase 1 · bar");
  await keysAtBeats(page, [32], { codes: ["Comma"] });
  await expect(page.locator(".lesson-cue")).toHaveText("Fader B to ¾ at Phrase 3, bar 1", { timeout: 20_000 });
  await expect(page.getByTestId("phrase-count")).toContainText("Phrase 2 · bar");
  await commandsAtBeats(page, moves(64));
  const card = resultCard(page);
  await expect(card).toBeVisible({ timeout: 30_000 });
  return card;
}

test("sync-blend: SYNC B, PLAY B on Phrase 2, the stepped blend from Phrase 3 (B ¾, A ¾, B up, A down), passes", async ({ page }) => {
  test.setTimeout(120_000);
  const card = await syncBlendCheck(page, "syncblend", steppedBlend);
  await expect(card, await card.innerText()).toHaveAttribute("data-outcome", "passed");
  await expect(card).toContainText(/Blend start: 0\.\d\d beats from the phrase start/);
  await expect(card).toContainText(/Blend: 9\.\d bars/);
  await expect(card).toContainText(/Level through the blend: moved [0-2]\.\d dB/);
  await expect(card).toContainText("TRIM left alone during the blend");
});

test("sync-blend: B all the way up while A is full is too loud, and the Check says so", async ({ page }) => {
  test.setTimeout(120_000);
  const card = await syncBlendCheck(page, "syncnaive", naiveBlend);
  await expect(card, await card.innerText()).toHaveAttribute("data-outcome", "failed");
  await expect(card).toContainText(/✗ Level through the blend: moved [3-9]\.\d dB \(need 3 or less\)/);
});

test("crossfader: PLAY B on Phrase 2, the crossfader blend from Phrase 3, the cut back to A on Phrase 5, passes", async ({ page }) => {
  test.setTimeout(120_000);
  const learnerId = learner("crossfader");
  await seedPassed(page, learnerId, [...FIRST_SEVEN, "tempo-fader", "sync-blend"], { headphones: true });
  await openLesson(page, learnerId, "crossfader");
  await expect(caption(page)).toContainText("Press , to play B");

  // Phrase 1 from beat 0; PLAY B on Phrase 2 (beat 32), crossfader on A; the blend on Phrase 3
  // (beat 64); the cut back to A on Phrase 5 (beat 128).
  await page.keyboard.press("Enter");
  await playingPast(page, "check", 0.5, { before: 12 });
  await page.getByRole("button", { name: "Channel B headphone cue" }).click();
  await keysAtBeats(page, [32], { codes: ["Comma"] });
  // One slow, even move over the 10 bars asked (a step every 0.4 beats, as a trackpad drag): the
  // constant-power curve holds the loudness through the middle.
  const steps = Math.round(40 / 0.4);
  const blend = Array.from({ length: steps }, (_, step) => ({ beat: 64 + (step + 1) * 0.4, command: { control: "crossfader", value: (step + 1) / steps } }));
  await expect(page.getByTestId("phrase-count")).toContainText("Phrase 2 · bar");
  await commandsAtBeats(page, blend);
  await page.getByRole("button", { name: "Channel A headphone cue" }).click();
  await keysAtBeats(page, [128], { codes: ["KeyC"] });

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

  // A from bar 9 (beat 32), a whole phrase: LOW down on bar 17 (beat 64), back on bar 25 (beat 96).
  await page.keyboard.press("Enter");
  await playingPast(page, "check", 32.5, { before: 40 });
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
