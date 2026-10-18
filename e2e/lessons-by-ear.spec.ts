import { expect, test, type Page } from "@playwright/test";
import { caption, commandsAtBeats, learner, openLesson, readyFromPhraseStart, resultCard, seedPassed, type LessonWindow } from "./lesson-support.ts";

// Lessons 14–16 end to end, muted, on the synthetic grooves: deck A 124 BPM, and for the two-track
// Lessons a 121 BPM groove on deck B; both have the first beat at 0 s and bar 1 on beat 0. The jog
// nudges and the tempo moves go through the Learner's own input path: nudge keys held on the window
// (the controller's key handler), and arrow keys on the focused TEMPO B fader. A test "ear" reads the
// two decks' heard playheads in the page and nudges B the way a Learner would, a little at a time.

const FIRST_ELEVEN = ["deck-basics", "beats-and-bars", "phrases", "gain-staging", "headphone-cue", "cue-point", "cut-on-phrase", "tempo-fader", "sync-blend", "crossfader", "eq-basics"];
const BPM_B = 121;

const phase = (page: Page) => page.locator("main.lesson");

/**
 * Starts nudging B into phase with A in the page, with the nudge keys (→ when B is behind, ← when
 * ahead, Shift when close), until `stopNudging`. It keeps going across phases, as a Learner would.
 */
async function startNudging(page: Page): Promise<void> {
  await page.evaluate(() => {
    const lesson = (window as LessonWindow).learnToDjLesson;
    if (lesson === undefined) throw new Error("No Lesson is open.");
    const control = { stop: false };
    (window as unknown as { nudging?: typeof control }).nudging = control;
    let held: { code: string; fine: boolean } | null = null;
    const release = () => {
      if (held !== null) window.dispatchEvent(new KeyboardEvent("keyup", { code: held.code }));
      held = null;
    };
    const tick = () => {
      if (control.stop) {
        release();
        return;
      }
      const { engine } = lesson;
      const a = engine.playhead("A");
      const b = engine.playhead("B");
      const gridA = lesson.deckTrack("A")?.grid ?? lesson.track.grid;
      const beatMs = 60_000 / (gridA.bpm * (engine.deckState("A").tempoRate ?? 1));
      let want: { code: string; fine: boolean } | null = null;
      if (engine.deckState("A").playing && engine.deckState("B").playing && a.ok && b.ok && a.beat != null && b.beat != null) {
        const difference = a.beat - b.beat;
        const errorMs = (difference - Math.round(difference)) * beatMs;
        if (Math.abs(errorMs) > 2.5) want = { code: errorMs > 0 ? "ArrowRight" : "ArrowLeft", fine: Math.abs(errorMs) < 12 };
      }
      if (want?.code !== held?.code || want?.fine !== held?.fine) {
        release();
        if (want !== null) window.dispatchEvent(new KeyboardEvent("keydown", { code: want.code, shiftKey: want.fine }));
        held = want;
      }
      setTimeout(tick, 15);
    };
    tick();
  });
}

async function stopNudging(page: Page): Promise<void> {
  await page.evaluate(() => {
    const control = (window as unknown as { nudging?: { stop: boolean } }).nudging;
    if (control !== undefined) control.stop = true;
  });
}

/**
 * Sets TEMPO B so B plays at `bpm`, with arrow keys on the focused fader (Shift for the fine steps), as
 * a keyboard Learner would. The fader is inverted: ArrowDown is faster.
 */
async function tempoBTo(page: Page, bpm: number): Promise<void> {
  const fader = page.locator('[data-control="B.tempo"] [role="slider"]');
  await fader.focus();
  const target = ((bpm / BPM_B - 1) * 100) / 6;
  const value = async () => Number(await fader.getAttribute("aria-valuenow"));
  const press = async (key: string, times: number) => {
    for (let count = 0; count < times; count += 1) await page.keyboard.press(key);
  };
  const coarse = Math.trunc((target - (await value())) / 0.04);
  await press(coarse > 0 ? "ArrowDown" : "ArrowUp", Math.abs(coarse));
  const fine = Math.round((target - (await value())) / 0.004);
  await press(fine > 0 ? "Shift+ArrowDown" : "Shift+ArrowUp", Math.abs(fine));
  await fader.blur();
}

const bpmOf = async (page: Page, deck: "A" | "B") =>
  page.evaluate((on) => {
    const lesson = (window as LessonWindow).learnToDjLesson;
    const grid = lesson?.deckTrack(on)?.grid;
    return grid === undefined ? 0 : grid.bpm * (lesson?.engine.deckState(on).tempoRate ?? 1);
  }, deck);

test("nudge-phase: a nudge, the phase meter, then B nudged into line and held, passes", async ({ page }) => {
  test.setTimeout(120_000);
  const learnerId = learner("nudge");
  await seedPassed(page, learnerId, FIRST_ELEVEN);
  await openLesson(page, learnerId, "nudge-phase");

  // The phase meter is still covered until its step.
  // SYNC withheld (BEAT SYNC B stays open for Master Tempo, held).
  await expect(page.locator('[data-control="B.sync"]')).toHaveAttribute("data-own-locked", "true");
  await expect(caption(page)).toContainText("Two kicks? Turn jog B (← →)");
  await expect(page.locator('[data-control="phase-meter"]')).toHaveAttribute("data-locked", "true");
  await page.keyboard.down("ArrowRight");
  await page.waitForTimeout(150);
  await page.keyboard.up("ArrowRight");
  await expect(caption(page)).toContainText("PHASE dot");
  await expect(page.locator('[data-control="phase-meter"]')).toHaveAttribute("data-locked", "false");

  // Nudged into line and held a bar: the hook is done, and the drill counts a held round.
  await startNudging(page);
  await expect(phase(page)).toHaveAttribute("data-phase", "practice", { timeout: 20_000 });
  await expect(page.getByRole("status", { name: "Practice feedback" })).toBeVisible();
  await expect(page.locator(".practice-reps .good")).toHaveCount(1, { timeout: 30_000 });

  // The Check: B starts out of phase; the "ear" brings it in and holds it; the Check ends once held.
  await page.keyboard.press("Enter");
  await expect(phase(page)).toHaveAttribute("data-phase", "check");
  const card = resultCard(page);
  await expect(card).toBeVisible({ timeout: 60_000 });
  await stopNudging(page);
  await expect(card, await card.innerText()).toHaveAttribute("data-outcome", "passed");
  await expect(card).toContainText(/In line after \d\.\d bars/);
  await expect(card).toContainText("CUE B left alone");
});

test("tempo-by-ear: BPM and phase meter covered, a guess and a match in practice, then B matched by ear, passes", async ({ page }) => {
  test.setTimeout(150_000);
  const learnerId = learner("tempoear");
  await seedPassed(page, learnerId, [...FIRST_ELEVEN, "nudge-phase"]);
  await openLesson(page, learnerId, "tempo-by-ear");
  expect(await page.evaluate(() => (window as LessonWindow).learnToDjLesson?.deckTrack("B")?.grid.bpm)).toBe(BPM_B);

  // Covered: no BPM to read, the phase meter held.
  await expect(page.locator('[data-control="B.bpm"] .readout-number')).toHaveText("–");
  await expect(page.locator('[data-control="phase-meter"]')).toHaveAttribute("data-locked", "true");
  // SYNC withheld (BEAT SYNC B stays open for Master Tempo, held).
  await expect(page.locator('[data-control="B.sync"]')).toHaveAttribute("data-own-locked", "true");

  // The hook: one tempo move the right way (a guess), then Ready.
  await expect(caption(page)).toContainText("Faster or slower?");
  const fasterB = (await bpmOf(page, "B")) > (await bpmOf(page, "A"));
  const fader = page.locator('[data-control="B.tempo"] [role="slider"]');
  await fader.focus();
  await page.keyboard.press(fasterB ? "ArrowUp" : "ArrowDown");
  await fader.blur();
  await expect(page.getByRole("status", { name: "Practice feedback" })).toHaveText("Right way. Match it by ear, then R");
  await expect(caption(page)).toContainText("Ready (R)");
  await tempoBTo(page, await bpmOf(page, "A"));
  await page.keyboard.press("KeyR");
  await expect(phase(page)).toHaveAttribute("data-phase", "practice");
  // After the Ready the BPMs and the meter show for a moment, with how far apart they were.
  await expect(page.getByRole("status", { name: "Practice feedback" })).toContainText("BPM apart");
  await expect(page.locator('[data-control="B.bpm"] .readout-number')).not.toHaveText("–");
  await expect(page.locator('[data-control="B.bpm"] .readout-number')).toHaveText("–", { timeout: 10_000 });

  // The Check: match by ear, nudge into line, hold; it ends once held 8 bars.
  await page.keyboard.press("Enter");
  await expect(phase(page)).toHaveAttribute("data-phase", "check");
  await page.waitForTimeout(1500);
  await tempoBTo(page, await bpmOf(page, "A"));
  await startNudging(page);
  const card = resultCard(page);
  await expect(card).toBeVisible({ timeout: 90_000 });
  await stopNudging(page);
  await expect(card, await card.innerText()).toHaveAttribute("data-outcome", "passed");
  await expect(card).toContainText(/Matched and held after \d+\.\d bars/);
});

/** A fader move on one deck from `fromBeat` to `toBeat`, a step every 0.4 beats (one trackpad drag). */
function faderMove(deck: "A" | "B", fromBeat: number, toBeat: number, from: number, to: number): { beat: number; command: Record<string, unknown> }[] {
  const steps = Math.round((toBeat - fromBeat) / 0.4);
  return Array.from({ length: steps + 1 }, (_, step) => ({
    beat: fromBeat + ((toBeat - fromBeat) * step) / steps,
    command: { control: "channel-fader", deck, value: from + ((to - from) * step) / steps },
  }));
}

test("blend-by-ear: B matched in the headphones, a 16-bar blend with the bass swapped on the phrase, held in line, passes", async ({ page }) => {
  test.setTimeout(180_000);
  const learnerId = learner("blendear");
  await seedPassed(page, learnerId, [...FIRST_ELEVEN, "bass-swap", "nudge-phase", "tempo-by-ear"], { headphones: true });
  await openLesson(page, learnerId, "blend-by-ear");
  await expect(page.locator('[data-control="B.bpm"] .readout-number')).toHaveText("–");

  // The hook: trim TEMPO B, then a nudge.
  await expect(caption(page)).toContainText("Trim TEMPO B");
  const fader = page.locator('[data-control="B.tempo"] [role="slider"]');
  await fader.focus();
  await page.keyboard.press("Shift+ArrowUp");
  await fader.blur();
  await expect(caption(page)).toContainText("jog B");
  await page.keyboard.down("ArrowLeft");
  await page.waitForTimeout(100);
  await page.keyboard.up("ArrowLeft");
  await expect(phase(page)).toHaveAttribute("data-phase", "practice");

  // Set up off the clock: cut LOW B (the set-up leaves it to the Learner), then R. The Check from bar 1:
  // B plays in the headphones; match it, keep it in line, blend from bar 9 (beat 32) to bar 26 with the
  // bass swapped on bar 17 (beat 64).
  await page.keyboard.press("Enter");
  await expect(phase(page)).toHaveAttribute("data-phase", "check");
  await expect(page.locator(".lesson-cue")).toHaveText("Set up: LOW B all the way down — then R");
  const lowB = await page.evaluate(() => (window as LessonWindow).learnToDjLesson?.engine.command({ control: "eq-low", deck: "B", value: -1 }, { device: "trackpad" }).ok);
  expect(lowB).toBe(true);
  await readyFromPhraseStart(page, "check", 0);
  await expect(page.locator(".lesson-cue")).toHaveText("B's in your headphones. Now match B: TEMPO B, then jog B");
  await page.waitForTimeout(500);
  await tempoBTo(page, await bpmOf(page, "A"));
  await startNudging(page);
  // As the cues ask: B up on bar 9, the bass swapped on bar 17, A down from bar 23 to just after bar
  // 25, then LOW A back to the middle.
  await commandsAtBeats(page, [
    ...faderMove("B", 32, 36, 0, 1),
    { beat: 64, command: { control: "eq-low", deck: "A", value: -1 } },
    { beat: 64, command: { control: "eq-low", deck: "B", value: 0 } },
    ...faderMove("A", 88, 101, 1, 0),
    { beat: 101.5, command: { control: "eq-low", deck: "A", value: 0 } },
  ]);
  const card = resultCard(page);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await stopNudging(page);
  await expect(card, await card.innerText()).toHaveAttribute("data-outcome", "passed");
  await expect(card).toContainText(/Blend: 1[567]\.\d bars \(need 16, less a beat at most\)/);
  await expect(card).toContainText(/In line \(under 25 ms\) \d+% of the blend/);
});
