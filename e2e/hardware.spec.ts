import { expect, test, type Page } from "@playwright/test";
import { learner, openLesson } from "./lesson-support.ts";

// The DDJ-FLX4 without the hardware: navigator.requestMIDIAccess is replaced (before the app loads) by a
// fake MIDI access with a "DDJ-FLX4" port. Messages are the official list's bytes; LED output is kept
// for the test to read. Audio is muted (playwright.config.ts) and output devices are faked, never chosen.

interface FakeFlx4 {
  send(bytes: number[]): void;
  readonly sent: number[][];
}

declare global {
  interface Window {
    __flx4?: FakeFlx4;
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
    window.__flx4 = {
      send(bytes) {
        const event = new Event("midimessage");
        Object.defineProperties(event, { data: { value: new Uint8Array(bytes) }, timeStamp: { value: performance.now() } });
        input.dispatchEvent(event);
      },
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
