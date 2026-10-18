import { expect, test, type Page } from "@playwright/test";
import { checkPlayingPast, learner, openLesson, playingPast, seedPassed, type LessonWindow } from "./lesson-support.ts";

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
      sysexEnabled: false,
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

test("deck-basics passes with only the FLX4: PLAY, LOAD for Enter, and the channel fader", async ({ page }) => {
  await fakeMidi(page, { controller: true });
  const learnerId = learner("flx4");
  await openLesson(page, learnerId, "deck-basics");
  const caption = page.getByRole("status", { name: "Lesson caption" });
  await expect(caption).toContainText("Press X");

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
  BROWSE: [0x96, 0x41, 0x7f],
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
  { control: "BROWSE", stamp: "event" },
  { control: "BROWSE", stamp: "zero" },
];

for (const { control, stamp } of TAP_RUNS) {
  test(`beats-and-bars passes with only ${control} presses as TAP (MIDI timeStamp ${stamp === "zero" ? "0" : "on the event clock"})`, async ({ page }) => {
    test.setTimeout(120_000);
    await fakeMidi(page, { controller: true });
    const learnerId = learner(`flx4-tap-${stamp}`);
    await seedPassed(page, learnerId, ["deck-basics"]);
    await openLesson(page, learnerId, "beats-and-bars");
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

test("every TAP (pad, BEAT ▶, SHIFT + BEAT ▶, BROWSE, a 0-stamped press, Space) leaves an early/late mark in the hook and in practice", async ({ page }) => {
  test.setTimeout(90_000);
  await fakeMidi(page, { controller: true });
  const learnerId = learner("flx4-marks");
  await seedPassed(page, learnerId, ["deck-basics"]);
  await openLesson(page, learnerId, "beats-and-bars");
  await playingPast(page, "hook", 2);
  const marks = page.getByRole("list", { name: "Your last taps" }).locator("li");
  const tapEach = async () => {
    for (const press of Object.values(TAP_PRESSES)) {
      await midi(page, [...press], [press[0], press[1], 0]);
      await page.waitForTimeout(120);
    }
    await page.evaluate(() => {
      window.__flx4?.sendStamped([0x96, 0x41, 0x7f], 0);
    });
    await page.waitForTimeout(120);
    await page.keyboard.press("Space");
  };
  await tapEach();
  await expect(marks).toHaveCount(6);

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
  // No SysEx unless the Learner asks for it.
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
