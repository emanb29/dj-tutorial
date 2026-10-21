import { expect, test, type Locator, type Page } from "@playwright/test";
import { checkPlayingPast, ensureProfile, learner, openLesson, playingPast, seedPassed, type LessonWindow } from "./lesson-support.ts";

// The DDJ-FLX4 without the hardware: navigator.requestMIDIAccess is replaced (before the app loads) by a
// fake MIDI access with a "DDJ-FLX4" port. Messages are the official list's bytes; LED output is kept
// for the test to read. Audio is muted (playwright.config.ts) and output devices are faked, never chosen.

interface FakeFlx4 {
  send(bytes: number[]): void;
  /** Sends with this MIDIMessageEvent.timeStamp (Chrome on macOS gives 0 when CoreMIDI stamps a packet 0). */
  sendStamped(bytes: number[], timeStamp: number): void;
  readonly sent: number[][];
}

/** The Timing check's engine, as far as the test reads it (src/app/controller-page/TimingCheck.tsx). */
interface TimingCheckHandle {
  readonly engine: {
    heardTime(): { ok: true; ctx: number } | { ok: false };
    playheadAt(deck: "A", ctx: number): { positionSec: number } | null;
  };
}

declare global {
  interface Window {
    __flx4?: FakeFlx4;
    learnToDjTimingCheck?: TimingCheckHandle;
  }
}

async function fakeMidi(page: Page, options: { controller: boolean; outputs?: { deviceId: string; label: string }[] }): Promise<void> {
  await page.addInitScript(({ controller, outputs }) => {
    const input = Object.assign(new EventTarget(), { id: "in-flx4", name: "DDJ-FLX4", type: "input", state: "connected" });
    const sent: number[][] = [];
    const output = { id: "out-flx4", name: "DDJ-FLX4", type: "output", state: "connected", send: (data: number[]) => sent.push(Array.from(data)) };
    const access = Object.assign(new EventTarget(), {
      inputs: new Map(controller ? [[input.id, input]] : []),
      outputs: new Map(controller ? [[output.id, output]] : []),
    });
    Object.defineProperty(navigator, "requestMIDIAccess", { value: () => Promise.resolve(access), configurable: true });
    const query = navigator.permissions.query.bind(navigator.permissions);
    Object.defineProperty(navigator.permissions, "query", {
      value: (descriptor: { name: string }) => (descriptor.name === "midi" ? Promise.resolve({ state: "granted" }) : query(descriptor as PermissionDescriptor)),
      configurable: true,
    });
    if (outputs !== undefined) {
      Object.defineProperty(navigator.mediaDevices, "enumerateDevices", {
        value: () => Promise.resolve(outputs.map((device) => ({ ...device, kind: "audiooutput", groupId: "", toJSON: () => ({}) }))),
        configurable: true,
      });
    }
    const sendStamped = (bytes: number[], timeStamp: number) => {
      const event = new Event("midimessage");
      Object.defineProperties(event, { data: { value: new Uint8Array(bytes) }, timeStamp: { value: timeStamp } });
      input.dispatchEvent(event);
    };
    window.__flx4 = {
      send(bytes) {
        sendStamped(bytes, performance.now());
      },
      sendStamped,
      sent,
    };
  }, options);
}

const midi = (page: Page, ...messages: number[][]) =>
  page.evaluate((all) => {
    for (const bytes of all) window.__flx4?.send(bytes);
  }, messages);

/** The channel fader of a deck to a position (0…1), as MSB then LSB. */
const fader = (deck: 0 | 1, value: number): number[][] => {
  const raw = Math.round(value * 16383);
  return [
    [0xb0 + deck, 0x13, raw >> 7],
    [0xb0 + deck, 0x33, raw & 0x7f],
  ];
};

/** A fader swept smoothly from one end to the other, as a hand moves it. */
async function sweepFader(page: Page, from: number, to: number): Promise<void> {
  const steps = 12;
  for (let step = 0; step <= steps; step++) {
    await midi(page, ...fader(0, from + ((to - from) * step) / steps));
    await page.waitForTimeout(15);
  }
}

/**
 * The "Match your controller" step a Lesson set-up shows while the FLX4's faders are not where it
 * needs them: these moves match it, and then it goes.
 */
async function matchController(page: Page, ...moves: number[][]): Promise<void> {
  const step = page.getByRole("region", { name: "Match your controller" });
  await expect(step).toBeVisible();
  await midi(page, ...moves);
  await expect(step).toBeHidden();
}

test("a Lesson waits for the controller: an unknown fader says wiggle it, then which way, and the hook starts once it matches", async ({ page }) => {
  await fakeMidi(page, { controller: true });
  await openLesson(page, learner("flx4-match"), "deck-basics");
  const step = page.getByRole("region", { name: "Match your controller" });
  // Lesson 1's practice starts with fader A down; the app cannot know where the physical one is yet.
  await expect(step.getByRole("listitem")).toHaveText(["○Fader A: wiggle it"]);
  // PLAY does nothing for the Lesson while the step shows: the hook waits.
  await midi(page, [0x90, 0x0b, 0x7f], [0x90, 0x0b, 0x00]);
  await expect(page.getByRole("status", { name: "Lesson caption" })).toContainText("Press X");
  await midi(page, ...fader(0, 0.6));
  await expect(step.getByRole("listitem")).toHaveText(["○Fader A: all the way down ↓"]);
  // The screen's fader is never put where the hardware is not: it is where the hardware is.
  await midi(page, ...fader(0, 0.3), ...fader(0, 0));
  await expect(step).toBeHidden();
  await expect(page.getByRole("slider", { name: "CH A" })).toHaveAttribute("aria-valuenow", "0");
  await expect(page.getByTestId("pickup-A.channel-fader")).toHaveCount(0);
  await midi(page, [0x90, 0x0b, 0x7f], [0x90, 0x0b, 0x00]);
  await expect(page.getByRole("status", { name: "Lesson caption" })).toContainText("That's PLAY");
});

test("Skip goes on without matching, and the step does not come back for that control", async ({ page }) => {
  await fakeMidi(page, { controller: true });
  await openLesson(page, learner("flx4-skip"), "deck-basics");
  const step = page.getByRole("region", { name: "Match your controller" });
  await step.getByRole("button", { name: "Skip" }).click();
  await expect(step).toBeHidden();
  await midi(page, [0x96, 0x46, 0x7f], [0x96, 0x46, 0x00]);
  await expect(page.locator("main.lesson")).toHaveAttribute("data-phase", "check");
  await expect(step).toBeHidden();
});

test("deck-basics passes with only the FLX4: PLAY, LOAD for Enter, and the channel fader", async ({ page }) => {
  await fakeMidi(page, { controller: true });
  const learnerId = learner("flx4");
  await openLesson(page, learnerId, "deck-basics");
  const caption = page.getByRole("status", { name: "Lesson caption" });
  await expect(caption).toContainText("Press X");
  await matchController(page, ...fader(0, 0));

  // PLAY on the hardware starts the hook's deck, and its LED lights.
  await midi(page, [0x90, 0x0b, 0x7f], [0x90, 0x0b, 0x00]);
  await expect(caption).toContainText("That's PLAY");
  await expect.poll(() => page.evaluate(() => window.__flx4?.sent.some((message) => message.join() === [0x90, 0x0b, 0x7f].join()))).toBe(true);

  // Deck B is still locked: its PLAY says "not yet" on screen and does nothing.
  await midi(page, [0x91, 0x0b, 0x7f], [0x91, 0x0b, 0x00]);
  await expect(page.locator('[data-control="B.play"] .not-yet')).toBeVisible();

  // LOAD is Enter: into the Check. Then Play, fader up, wait to be heard, fader down.
  await midi(page, [0x96, 0x46, 0x7f], [0x96, 0x46, 0x00]);
  await expect(page.locator("main.lesson")).toHaveAttribute("data-phase", "check");
  await midi(page, [0x90, 0x0b, 0x7f], [0x90, 0x0b, 0x00]);
  await page.waitForTimeout(300);
  await sweepFader(page, 0, 1);
  await page.waitForTimeout(1500);
  await sweepFader(page, 1, 0);

  const card = page.getByRole("region", { name: "Result" });
  await expect(card, await card.innerText().catch(() => "")).toHaveAttribute("data-outcome", "passed", { timeout: 10_000 });
  await expect(card).toContainText("Fade out: fader ended at 0%");
});

/** The hardware controls that are TAP in Lesson 2, as note-on bytes (the release is the same at velocity 0). */
const TAP_PRESSES = {
  pad: [0x97, 0x00, 0x7f],
  "BEAT ▶": [0x94, 0x4b, 0x7f],
  "SHIFT + BEAT ▶": [0x94, 0x6b, 0x7f],
} as const;
type TapControl = keyof typeof TAP_PRESSES;

/**
 * Presses a TAP control on beats of deck A's heard playhead, timed in the page as `keysAtBeats` times
 * Space. `stamp` "event" stamps each press with its performance.now() time, as Chrome normally does;
 * "zero" stamps it 0, as Chrome does when CoreMIDI hands it a packet stamped 0 ("now").
 */
async function tapsAtBeats(page: Page, control: TapControl, beats: readonly number[], stamp: "event" | "zero"): Promise<void> {
  await page.evaluate(
    async ({ targets, zero, press }) => {
      const lesson = (window as LessonWindow).learnToDjLesson;
      const flx4 = window.__flx4;
      if (lesson === undefined || flx4 === undefined) throw new Error("No Lesson or no fake FLX4.");
      const beatMs = 60_000 / (lesson.deckTrack("A")?.grid ?? lesson.track.grid).bpm;
      const beatAtMs = (beat: number) => {
        const now = performance.now();
        const heard = lesson.engine.heardTime(now);
        const reading = heard.ok && heard.ctx !== undefined ? lesson.engine.playheadAt("A", heard.ctx) : null;
        if (reading?.beat == null) throw new Error("Deck A has no playhead reading.");
        return now + (beat - reading.beat) * beatMs;
      };
      for (const beat of targets) {
        let atMs = beatAtMs(beat);
        for (let remainingMs = atMs - performance.now(); remainingMs > 0.5; remainingMs = atMs - performance.now()) {
          // A 0-stamped press is timed when its handler runs, so a late timer would make it late: wake
          // well early and spin the last stretch.
          const marginMs = zero ? 30 : 8;
          if (remainingMs > marginMs + 4) await new Promise((resolve) => setTimeout(resolve, remainingMs - marginMs));
          atMs = beatAtMs(beat);
        }
        flx4.sendStamped([...press], zero ? 0 : atMs);
        flx4.sendStamped([press[0], press[1], 0], zero ? 0 : atMs);
      }
    },
    { targets: beats, zero: stamp === "zero", press: TAP_PRESSES[control] },
  );
}

const TAP_RUNS: readonly { control: TapControl; stamp: "event" | "zero" }[] = [
  { control: "pad", stamp: "event" },
  { control: "BEAT ▶", stamp: "event" },
  { control: "SHIFT + BEAT ▶", stamp: "event" },
  { control: "SHIFT + BEAT ▶", stamp: "zero" },
];

for (const { control, stamp } of TAP_RUNS) {
  test(`beats-and-bars passes with only ${control} presses as TAP (MIDI timeStamp ${stamp === "zero" ? "0" : "on the event clock"})`, async ({ page }) => {
    test.setTimeout(120_000);
    await fakeMidi(page, { controller: true });
    const learnerId = learner(`flx4-tap-${stamp}`);
    await seedPassed(page, learnerId, ["deck-basics"]);
    await openLesson(page, learnerId, "beats-and-bars");
    await matchController(page, ...fader(0, 1));
    // On hardware the caption names the borrowed TAP control: the pads, before hot cues.
    await expect(page.getByRole("status", { name: "Lesson caption" })).toContainText("Tap SHIFT + BEAT ▶ (TAP), any pad or Space on every kick");
    await playingPast(page, "hook", 66);
    // LOAD is Enter: into the Check.
    await midi(page, [0x96, 0x46, 0x7f], [0x96, 0x46, 0x00]);
    await checkPlayingPast(page, 28.5);
    // Every beat of bars 9–16 (beats 32–63), then the 1s of bars 17–24.
    await tapsAtBeats(page, control, [...Array.from({ length: 32 }, (_, index) => 32 + index), ...Array.from({ length: 8 }, (_, index) => 64 + 4 * index)], stamp);

    const card = page.getByRole("region", { name: "Result" });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card, await card.innerText()).toHaveAttribute("data-outcome", "passed");
    await expect(card).toContainText(/Beats: (29|3[0-2]) of 32 on time/);
    await expect(card).toContainText(/Downbeats: [78] of 8 on time/);
  });
}

test("every TAP (pad, BEAT ▶, SHIFT + BEAT ▶, a 0-stamped press, Space) leaves an early/late mark in the hook and in practice", async ({ page }) => {
  test.setTimeout(90_000);
  await fakeMidi(page, { controller: true });
  const learnerId = learner("flx4-marks");
  await seedPassed(page, learnerId, ["deck-basics"]);
  await openLesson(page, learnerId, "beats-and-bars");
  await matchController(page, ...fader(0, 1));
  await playingPast(page, "hook", 2);
  const marks = page.getByRole("list", { name: "Your last taps" }).locator("li");
  const tapEach = async () => {
    for (const press of Object.values(TAP_PRESSES)) {
      await midi(page, [...press], [press[0], press[1], 0]);
      await page.waitForTimeout(120);
    }
    await page.evaluate(() => {
      window.__flx4?.sendStamped([0x94, 0x6b, 0x7f], 0);
      window.__flx4?.sendStamped([0x94, 0x6b, 0x00], 0);
    });
    await page.waitForTimeout(120);
    await page.keyboard.press("Space");
  };
  await tapEach();
  await expect(marks).toHaveCount(5);

  // Finish the hook on the pads (four beats, then three 1s) to reach practice.
  const beat = await page.evaluate(() => (window as LessonWindow).learnToDjLesson?.engine.playhead("A").beat ?? 0);
  const next = Math.ceil(beat) + 2;
  const firstOne = Math.ceil((next + 5) / 4) * 4;
  await tapsAtBeats(page, "pad", [next, next + 1, next + 2, next + 3, firstOne, firstOne + 4, firstOne + 8], "event");
  await expect(page.locator("main.lesson")).toHaveAttribute("data-phase", "practice", { timeout: 15_000 });
  // The strip keeps the last 12 marks: each TAP must still change it.
  const strip = () => marks.evaluateAll((items) => items.map((item) => `${item.getAttribute("title") ?? ""}@${(item as HTMLElement).style.left}`).join("|"));
  for (const press of Object.values(TAP_PRESSES)) {
    const before = await strip();
    await midi(page, [...press], [press[0], press[1], 0]);
    await expect.poll(strip).not.toBe(before);
    await page.waitForTimeout(150);
  }
  const before = await strip();
  await page.keyboard.press("Space");
  await expect.poll(strip).not.toBe(before);
});

test("a hardware fader away from the screen's value shows a pickup mark and does not jump the value", async ({ page }) => {
  await fakeMidi(page, { controller: true });
  await openLesson(page, learner("pickup"), "deck-basics");
  await midi(page, [0x96, 0x46, 0x7f], [0x96, 0x46, 0x00]);
  await expect(page.locator("main.lesson")).toHaveAttribute("data-phase", "check");
  const slider = page.getByRole("slider", { name: "CH A" });
  const before = await slider.getAttribute("aria-valuenow");
  // The physical fader is at the top while the screen's is at the bottom.
  await midi(page, ...fader(0, 0.9));
  await expect(page.getByTestId("pickup-A.channel-fader")).toBeVisible();
  await expect(slider).toHaveAttribute("aria-valuenow", before ?? "0");
});

test("Sync from controller ticks each fader as it reports, and a Lesson opened afterwards shows where it is at once", async ({ page }) => {
  await fakeMidi(page, { controller: true });
  const learnerId = learner("positions");
  await openLesson(page, learnerId, "deck-basics");
  await page.getByRole("button", { name: /Lessons/ }).click();
  await page.getByRole("link", { name: "Controller" }).click();
  const card = page.getByRole("region", { name: "Positions" });
  await expect(card.getByTestId("positions-limit")).toContainText("can't say where its knobs sit until they move");
  await card.getByRole("button", { name: "Sync from controller" }).click();
  await expect(card.getByTestId("positions-count")).toHaveText(/^0 of \d+$/);
  // Deck A's channel fader near the top, deck B's TRIM a little right of centre.
  await midi(page, ...fader(0, 0.9), [0xb1, 0x04, 0x48], [0xb1, 0x24, 0x00]);
  await expect(card.locator('[data-control="A.channel-fader"]')).toHaveAttribute("data-known", "true");
  await expect(card.locator('[data-control="B.trim"]')).toHaveAttribute("data-known", "true");
  await expect(card.getByTestId("positions-count")).toHaveText(/^2 of \d+$/);
  // The app never sends SysEx.
  expect(await page.evaluate(() => window.__flx4?.sent.some((bytes) => bytes[0] === 0xf0))).toBe(false);

  // Back to the Lesson, in the same tab: the fader's mark is there before it moves again.
  await page.getByRole("button", { name: /Lessons/ }).click();
  await page.locator('li[data-lesson="deck-basics"]').getByRole("button").click();
  await expect(page.locator("main.lesson")).toHaveAttribute("data-phase", "hook");
  await expect(page.getByTestId("pickup-A.channel-fader")).toBeAttached();
});

test("the Lesson screen says where the sound goes", async ({ page }) => {
  await fakeMidi(page, { controller: true });
  await openLesson(page, learner("output-line"), "deck-basics");
  await expect(page.getByTestId("output-line")).toHaveText("This computer's output");
});

test("the Controller page connects, ticks off moved controls, and decodes them in the monitor", async ({ page }) => {
  await fakeMidi(page, { controller: true });
  await page.goto("/");
  await page.getByRole("link", { name: "Controller" }).click();
  await expect(page.getByTestId("midi-status")).toContainText("Connected: DDJ-FLX4");
  const count = page.getByTestId("checklist-count");
  await expect(count).toHaveText(/^0 of \d+$/);

  await midi(page, [0x90, 0x0b, 0x7f], [0x90, 0x0b, 0x00], [0xb6, 0x1f, 0x40], [0xb6, 0x3f, 0x00], [0x99, 0x03, 0x7f], [0xb1, 0x21, 0x41]);
  await expect(page.locator('[data-control="A.play"]')).toHaveAttribute("data-seen", "true");
  await expect(page.locator('[data-control="crossfader"]')).toHaveAttribute("data-seen", "true");
  await expect(page.locator('[data-control="B.pad-4"]')).toHaveAttribute("data-seen", "true");
  await expect(page.locator('[data-control="B.jog"]')).toHaveAttribute("data-seen", "true");
  await expect(count).toHaveText(/^4 of \d+$/);
  const monitor = page.getByRole("region", { name: "MIDI monitor" });
  await expect(monitor).toContainText("Deck A PLAY/PAUSE pressed");
  await expect(monitor).toContainText("crossfader 50%");

  // The LED test walks the lights and ends with them all off.
  await page.getByRole("button", { name: "Test the lights" }).click();
  await expect(page.getByRole("button", { name: "Test the lights" })).toBeEnabled({ timeout: 10_000 });
  const last = await page.evaluate(() => window.__flx4?.sent.at(-1));
  expect(last?.[2]).toBe(0);
});

test("the Timing check: TAP (SHIFT + BEAT ▶) along a click track stores the offset for this output, and Reset forgets it", async ({ page }) => {
  test.setTimeout(60_000);
  await fakeMidi(page, { controller: true });
  await page.goto("/controller");
  const check = page.getByRole("region", { name: "Timing check" });
  await expect(check.getByTestId("timing-stored")).toContainText("not measured yet");
  await check.getByRole("button", { name: "Start the timing check" }).click();
  await expect(check.getByTestId("timing-progress")).toContainText("Listen to 4 clicks");
  // Steady taps 30 ms after each counted click (100 BPM, the first click at 0.5 s, 4 to listen), timed on
  // the click track as heard: headless Chromium's audio clock drifts from the page's clock.
  await page.evaluate(async () => {
    const engine = window.learnToDjTimingCheck?.engine;
    if (engine === undefined) throw new Error("the Timing check's clicks are not playing");
    const heardPosition = () => {
      const heard = engine.heardTime();
      return heard.ok ? (engine.playheadAt("A", heard.ctx)?.positionSec ?? 0) : 0;
    };
    const deadline = performance.now() + 30_000;
    for (let click = 4; click < 22; click++) {
      const target = 0.5 + click * 0.6 + 0.03;
      // The check stops its clicks once it has 16 taps.
      if (window.learnToDjTimingCheck === undefined) return;
      while (heardPosition() < target) {
        if (performance.now() > deadline) throw new Error(`the clicks stalled at ${String(heardPosition())} s, waiting for ${String(target)} s (heard: ${JSON.stringify(engine.heardTime())})`);
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      window.__flx4?.send([0x94, 0x6b, 0x7f]);
      window.__flx4?.send([0x94, 0x6b, 0x00]);
    }
  });
  await expect(check.getByTestId("timing-result")).toContainText(/Your taps land .* through this computer's output\. Saved/, { timeout: 10_000 });
  await expect(check.getByTestId("timing-stored")).toContainText("grading allows for it");
  const stored = await page.evaluate(() => JSON.parse(window.localStorage.getItem("learn-to-dj.timing-offset") ?? "{}") as Record<string, { offsetMs: number }>);
  expect(Math.abs(stored["split-cue"]?.offsetMs ?? Number.NaN)).toBeLessThanOrEqual(150);

  await check.getByRole("button", { name: "Reset" }).click();
  await expect(check.getByTestId("timing-stored")).toContainText("not measured yet");
});

test("the first tap Lesson offers the Timing check once", async ({ page }) => {
  const learnerId = learner("timing-offer");
  await seedPassed(page, learnerId, ["deck-basics"]);
  await openLesson(page, learnerId, "beats-and-bars");
  await expect(page.getByRole("link", { name: "Timing check (20 s)" })).toHaveAttribute("href", "/controller#timing-check");
  await page.reload();
  await expect(page.locator("main.lesson")).toBeVisible();
  await expect(page.getByRole("link", { name: "Timing check (20 s)" })).toHaveCount(0);
});

test("the Controller page works without a controller and says what to plug in", async ({ page }) => {
  await fakeMidi(page, { controller: false });
  await page.goto("/controller");
  await expect(page.getByTestId("midi-status")).toContainText("No DDJ-FLX4 found");
  await expect(page.getByTestId("checklist-count")).toHaveText(/^0 of \d+$/);
});

test("the output picker offers the FLX4 when its sound card is there, and keeps the choice", async ({ page }) => {
  await fakeMidi(page, {
    controller: true,
    outputs: [
      { deviceId: "spk", label: "MacBook Pro Speakers" },
      { deviceId: "flx", label: "DDJ-FLX4" },
    ],
  });
  await page.goto("/controller");
  const flx4 = page.getByRole("radio", { name: /Through the FLX4/ });
  await expect(flx4).toBeEnabled();
  await expect(page.getByRole("radio", { name: /One device, split cue/ })).toBeChecked();
  await flx4.check();
  await page.reload();
  await expect(page.getByRole("radio", { name: /Through the FLX4/ })).toBeChecked();
  const stored = await page.evaluate(() => window.localStorage.getItem("learn-to-dj.audio-output"));
  expect(JSON.parse(stored ?? "null")).toEqual({ kind: "controller", deviceId: "flx", label: "DDJ-FLX4" });

  // Two devices: speakers for the master, the other output for the cue, with a headphone offset.
  await page.getByRole("radio", { name: /Two devices/ }).check();
  await expect(page.getByLabel("Master (speakers)")).toHaveValue("spk");
  await expect(page.getByLabel("Cue (headphones)")).toHaveValue("flx");
});

test("the output picker offers this computer's speakers with the FLX4's headphones, says to turn HEADPHONES MIX to CUE, and keeps the choice", async ({ page }) => {
  await fakeMidi(page, {
    controller: true,
    outputs: [
      { deviceId: "spk", label: "MacBook Pro Speakers" },
      { deviceId: "flx", label: "DDJ-FLX4" },
    ],
  });
  await page.goto("/controller");
  const phones = page.getByRole("radio", { name: /Speakers: this computer · Headphones: FLX4/ });
  await expect(phones).toBeEnabled();
  await phones.check();
  await expect(page.getByTestId("phones-mix-hint")).toHaveText(/Turn the FLX4’s HEADPHONES MIX to CUE/);
  // The speakers are picked from this computer's outputs only, never the FLX4.
  const speakers = page.getByLabel("Master (speakers)");
  await expect(speakers).toHaveValue("spk");
  await expect(speakers.locator("option")).toHaveText(["MacBook Pro Speakers"]);
  await page.reload();
  await expect(page.getByRole("radio", { name: /Speakers: this computer · Headphones: FLX4/ })).toBeChecked();
  const stored = await page.evaluate(() => window.localStorage.getItem("learn-to-dj.audio-output"));
  expect(JSON.parse(stored ?? "null")).toEqual({ kind: "computer-and-controller-phones", masterDeviceId: "spk", masterLabel: "MacBook Pro Speakers", controllerDeviceId: "flx", controllerLabel: "DDJ-FLX4", headphoneOffsetMs: 0 });
  // Its own Timing check entry: the check names this output.
  await expect(page.getByTestId("timing-check")).toContainText("this computer and the FLX4's headphones");
});

test("the output picker offers PC MASTER OUT, the master on the FLX4 and this computer, and keeps the choice", async ({ page }) => {
  await fakeMidi(page, {
    controller: true,
    outputs: [
      { deviceId: "spk", label: "MacBook Pro Speakers" },
      { deviceId: "flx", label: "DDJ-FLX4" },
    ],
  });
  await page.goto("/controller");
  const dual = page.getByRole("radio", { name: /PC MASTER OUT/ });
  await expect(dual).toBeEnabled();
  await dual.check();
  // The computer's speakers are picked from this computer's outputs only, never the FLX4.
  const speakers = page.getByLabel("Speakers on this computer");
  await expect(speakers).toHaveValue("spk");
  await expect(speakers.locator("option")).toHaveText(["MacBook Pro Speakers"]);
  await expect(page.getByRole("button", { name: "Play test clicks" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("radio", { name: /PC MASTER OUT/ })).toBeChecked();
  const stored = await page.evaluate(() => window.localStorage.getItem("learn-to-dj.audio-output"));
  expect(JSON.parse(stored ?? "null")).toEqual({ kind: "dual-master", masterDeviceId: "spk", masterLabel: "MacBook Pro Speakers", controllerDeviceId: "flx", controllerLabel: "DDJ-FLX4", headphoneOffsetMs: 0 });
  // Its own Timing check entry: the check names this output.
  await expect(page.getByTestId("timing-check")).toContainText("PC MASTER OUT");
});

test("speakers with the FLX4's headphones, and PC MASTER OUT, are not offered without the FLX4's sound card", async ({ page }) => {
  await fakeMidi(page, {
    controller: true,
    outputs: [
      { deviceId: "spk", label: "MacBook Pro Speakers" },
      { deviceId: "pods", label: "AirPods" },
    ],
  });
  await page.goto("/controller");
  await expect(page.getByRole("radio", { name: /Two devices/ })).toBeEnabled();
  await expect(page.getByRole("radio", { name: /Speakers: this computer · Headphones: FLX4/ })).toBeDisabled();
  await expect(page.getByRole("radio", { name: /PC MASTER OUT/ })).toBeDisabled();
});

test("unnamed outputs are offered as Output N, with a way to name them", async ({ page }) => {
  await fakeMidi(page, {
    controller: false,
    outputs: [
      { deviceId: "a1", label: "" },
      { deviceId: "b2", label: "" },
    ],
  });
  await page.goto("/controller");
  await expect(page.getByRole("button", { name: "Show my outputs" })).toBeVisible();
  await page.getByRole("radio", { name: /Two devices/ }).check();
  await expect(page.getByLabel("Cue (headphones)")).toContainText("Output 2");
});

// ---- the whole app from the FLX4 (src/app/controller/flx4-keys.ts) ---------------------------------

/** BROWSE turned `ticks` detents (negative: counter-clockwise), as the list's two's-complement CC. */
const browseTurn = (ticks: number): number[][] => [[0xb6, 0x40, ticks >= 0 ? ticks : 0x80 + ticks]];
const press = (note: number): number[][] => [
  [0x96, note, 0x7f],
  [0x96, note, 0x00],
];
const BROWSE_PRESS = press(0x41);
const SHIFT_BROWSE_PRESS = press(0x42);
const LOAD_A = press(0x46);
const LOAD_B = press(0x47);
/** A deck's TRIM to a position (0…1), as MSB then LSB. */
const trim = (deck: 0 | 1, value: number): number[][] => {
  const raw = Math.round(value * 16383);
  return [
    [0xb0 + deck, 0x04, raw >> 7],
    [0xb0 + deck, 0x24, raw & 0x7f],
  ];
};

/** Turns BROWSE one detent at a time until the ring is on `target` (or a control inside it). */
async function ringTo(page: Page, target: Locator): Promise<void> {
  for (let turn = 0; turn < 40; turn++) {
    if (await target.evaluate((element) => element.contains(document.activeElement))) return;
    await midi(page, ...browseTurn(1));
  }
  throw new Error(`BROWSE never reached ${target.toString()}`);
}

const focusedName = (page: Page) => page.evaluate(() => document.activeElement?.textContent.trim() ?? "");

test("the whole app from the FLX4: a Lesson from the list, the Check, Ready on LOAD B, the result card, practice and back, no keyboard or mouse", async ({ page }) => {
  test.setTimeout(120_000);
  await fakeMidi(page, { controller: true });
  const learnerId = learner("flx4-walk");
  await seedPassed(page, learnerId, ["deck-basics", "beats-and-bars", "phrases", "gain-staging", "headphone-cue", "cue-point"], { headphones: true });
  await page.goto(`/?learner=${learnerId}&track=synthetic`);
  const html = page.locator("html");

  // The list says how to get around it from the FLX4, and names the Lesson LOAD A starts.
  await expect(page.getByTestId("flx4-hint")).toContainText("LOAD A starts Lesson 7 (Your first transition: the cut)");
  // BROWSE moves the ring (drawn large once the FLX4 moves it) to the Lesson; the press opens it.
  await ringTo(page, page.locator('li[data-lesson="cut-on-phrase"]'));
  await expect(html).toHaveAttribute("data-controller-nav", "");
  await midi(page, ...BROWSE_PRESS);
  await page.waitForFunction(() => (window as LessonWindow).learnToDjLesson !== undefined);
  const lesson = page.locator("main.lesson");
  await expect(lesson).not.toHaveAttribute("data-phase", "loading");
  // The hardware is the source of truth: put its faders and trims where the Lesson starts.
  await midi(page, ...fader(0, 1), ...fader(1, 0), ...trim(0, 0.5), ...trim(1, 0.5));
  await expect(page.getByRole("region", { name: "Match your controller" })).toBeHidden();
  await expect(page.getByRole("button", { name: /Lessons/ })).toContainText("SHIFT + BROWSE");

  // LOAD A is Enter: into the Check. Its own set-up step waits; Ready is on LOAD B, and says so.
  await midi(page, ...LOAD_A);
  await expect(lesson).toHaveAttribute("data-phase", "check");
  const setUp = page.getByRole("region", { name: "Match your controller" });
  await page.waitForFunction(() => (window as LessonWindow).learnToDjLesson?.settingUp?.() === true, undefined, { timeout: 15_000 });
  await expect(setUp).toContainText("Ready R / LOAD B");
  await midi(page, [0x91, 0x54, 0x7f], [0x91, 0x54, 0x00], ...fader(1, 1));
  await expect(setUp.locator('li[data-state="matched"]')).toHaveCount(await setUp.locator("li").count());
  await midi(page, ...LOAD_B);
  await page.waitForFunction(() => (window as LessonWindow).learnToDjLesson?.settingUp?.() === false, undefined, { timeout: 5_000 });

  // The result card: the ring starts on Go again (LOAD A names it), one detent on is Practice.
  const card = page.getByRole("region", { name: "Result" });
  await expect(card).toBeVisible({ timeout: 45_000 });
  await expect(card.getByRole("button", { name: /Go again/ })).toContainText("LOAD A");
  await midi(page, ...browseTurn(1));
  expect(await focusedName(page)).toMatch(/^Go again/);
  await midi(page, ...browseTurn(1));
  expect(await focusedName(page)).toMatch(/^Practice/);
  await midi(page, ...BROWSE_PRESS);
  await expect(lesson).toHaveAttribute("data-phase", "practice");

  // Practice has the same set-up step: LOAD B goes on once it is set.
  await page.waitForFunction(() => (window as LessonWindow).learnToDjLesson?.settingUp?.() === true, undefined, { timeout: 15_000 });
  await expect(setUp.locator('li[data-state="matched"]')).toHaveCount(await setUp.locator("li").count());
  await midi(page, ...LOAD_B);
  await page.waitForFunction(() => (window as LessonWindow).learnToDjLesson?.settingUp?.() === false, undefined, { timeout: 5_000 });
  await expect(lesson).toHaveAttribute("data-phase", "practice");

  // SHIFT + BROWSE press is back (Esc): the list again. There, LOAD A starts the next Lesson.
  await midi(page, ...SHIFT_BROWSE_PRESS);
  await expect(page.locator("main.home")).toBeVisible();
  await midi(page, ...LOAD_A);
  await expect(page).toHaveURL(/\/lesson\/cut-on-phrase/);
  await midi(page, ...SHIFT_BROWSE_PRESS);
  await expect(page.locator("main.home")).toBeVisible();
});

test("a file or a list on the FLX4: it says what it can't do, and BROWSE changes a list", async ({ page }) => {
  await fakeMidi(page, { controller: true, outputs: [{ deviceId: "a1", label: "Speakers" }, { deviceId: "b2", label: "Headphones" }, { deviceId: "c3", label: "Other headphones" }] });
  const learnerId = learner("flx4-limits");
  await ensureProfile(page, learnerId);
  await page.goto(`/mix?learner=${learnerId}`);
  // The page says so up front, and again when the ring is on the file picker and BROWSE presses it.
  await expect(page.getByText("the FLX4 can't open your files")).toBeVisible();
  await ringTo(page, page.locator('input[type="file"]'));
  await midi(page, ...BROWSE_PRESS);
  await expect(page.getByTestId("controller-nav-notice")).toContainText("Picking a file needs the mouse, keyboard or screen");
  // SHIFT + BROWSE presses the page's back button.
  await midi(page, ...SHIFT_BROWSE_PRESS);
  await expect(page.locator("main.home")).toBeVisible();

  // The Controller page: the legend, and a list BROWSE turns once pressed.
  await ringTo(page, page.getByRole("link", { name: "Controller" }));
  await midi(page, ...BROWSE_PRESS);
  await expect(page.getByRole("table", { name: "FLX4 buttons around the app" })).toContainText("SHIFT + LOAD A");
  const cue = page.getByLabel("Cue (headphones)");
  await ringTo(page, page.getByRole("radio", { name: /Two devices/ }));
  await midi(page, ...BROWSE_PRESS);
  await expect(cue).toBeVisible();
  await ringTo(page, cue);
  await expect(cue).toHaveValue("b2");
  await midi(page, ...BROWSE_PRESS);
  await expect(page.getByTestId("controller-nav-notice")).toContainText("Turn BROWSE to change it");
  await midi(page, ...browseTurn(1));
  await expect(cue).toHaveValue("c3");
});

test("Placement's Mission from the FLX4: the text box says it can wait, SHIFT + BROWSE skips, LOAD A starts Lesson 1", async ({ page }) => {
  await fakeMidi(page, { controller: true });
  await page.goto(`/?learner=${learner("flx4-placement")}&track=synthetic`);
  const mission = page.getByLabel("Why do you want to DJ?");
  await expect(mission).toBeFocused();
  await expect(page.getByRole("button", { name: /Show me what you can do/ })).toContainText("LOAD A");
  await midi(page, ...BROWSE_PRESS);
  await expect(page.getByTestId("controller-nav-notice")).toContainText("It can wait: LOAD A goes on without it.");
  await midi(page, ...SHIFT_BROWSE_PRESS);
  const summary = page.getByRole("main", { name: "Placement summary" });
  await expect(summary).toContainText("Next: Lesson 1");
  await midi(page, ...LOAD_A);
  await expect(page.locator("main.lesson h1")).toHaveText("Play a track out loud", { timeout: 20_000 });
});

test("Freestyle from the FLX4, the rekordbox way: BROWSE through the library, LOAD A / LOAD B load the track, a playing deck refuses", async ({ page }) => {
  test.setTimeout(90_000);
  await fakeMidi(page, { controller: true });
  const learnerId = learner("flx4-freestyle");
  await ensureProfile(page, learnerId);
  await page.goto(`/?learner=${learnerId}&track=synthetic`);
  await ringTo(page, page.getByRole("button", { name: "Freestyle" }));
  await midi(page, ...BROWSE_PRESS);
  await expect(page.locator("main.freestyle")).toHaveAttribute("data-phase", "ready", { timeout: 30_000 });
  await expect(page.getByTestId("flx4-library-hint")).toBeVisible();

  // From nothing, the ring starts on the library's first track; each detent is the next track.
  const rows = page.locator("li[data-library]");
  const decks = page.getByRole("list", { name: "On the decks" });
  await midi(page, ...browseTurn(1));
  await expect(rows.nth(0)).toBeFocused();
  const first = (await rows.nth(0).getAttribute("aria-label")) ?? "";
  await midi(page, ...LOAD_A);
  await expect(decks.locator('li[data-deck="A"]')).toContainText(first, { timeout: 20_000 });
  await midi(page, ...browseTurn(1));
  await expect(rows.nth(1)).toBeFocused();
  const second = (await rows.nth(1).getAttribute("aria-label")) ?? "";
  await midi(page, ...LOAD_B);
  await expect(decks.locator('li[data-deck="B"]')).toContainText(second, { timeout: 20_000 });

  // PLAY on deck A; then LOAD A refuses, as the screen's → A does.
  await midi(page, [0x90, 0x0b, 0x7f], [0x90, 0x0b, 0x00]);
  await page.waitForFunction(() => (window as LessonWindow).learnToDjLesson?.engine.deckState("A").playing === true);
  await midi(page, ...LOAD_A);
  await expect(page.getByRole("alert")).toHaveText("Pause deck A first");
  await expect(decks.locator('li[data-deck="A"]')).toContainText(first);

  await midi(page, ...SHIFT_BROWSE_PRESS);
  await expect(page.locator("main.home")).toBeVisible();
});
