import { devices, expect, test, type Locator, type Page } from "@playwright/test";

// The Lesson player on a phone (touch, portrait and landscape) and on the owner's laptop, muted, on
// the synthetic groove. On a phone the controller must fit the width without any part on top of
// another, the control to touch next must be on screen and big enough for a finger, and captions name
// the control ("Tap PLAY") instead of a key.

const phone = (width: number, height: number) => ({
  // Not the whole device descriptor: its defaultBrowserType cannot be set inside a describe.
  userAgent: devices["Pixel 7"].userAgent,
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 1,
  viewport: { width, height },
});

const TOUCH_TARGET_PX = 44;

interface Box {
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

async function openLesson(page: Page, lessonId: string, options: { readonly touch: boolean; readonly passed?: readonly string[]; readonly headphones?: boolean }): Promise<void> {
  const learnerId = `e2e-mobile-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`;
  const passed = options.passed ?? [];
  {
    // A profile (so the list shows, not the first-run Placement), with earlier Lessons passed, through the app's own API (from the page, so it sees the app's Origin).
    await page.goto(`/?learner=${learnerId}`);
    const status = await page.evaluate(
      async ({ id, lessonIds, headphones }) => {
        const at = new Date().toISOString();
        const lessons = Object.fromEntries(lessonIds.map((lesson) => [lesson, { lessonId: lesson, passedAt: at, passedVia: "lesson", attempts: 1, reviewSuggestedAt: null, reviewDeclinedAt: null }]));
        const record = {
          schemaVersion: 1,
          learnerId: id,
          mission: "",
          missionTags: [],
          curriculum: null,
          ...(headphones ? { headphones: { checkedAt: at } } : {}),
          skillProfile: { schemaVersion: 1, learnerId: id, lessons, criteria: {}, courseCompletedAt: null },
        };
        const response = await fetch(`/api/learners/${id}/profile`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(record) });
        return response.status;
      },
      { id: learnerId, lessonIds: passed, headphones: options.headphones === true },
    );
    expect(status).toBe(200);
  }
  await page.goto(`/?learner=${learnerId}&track=synthetic`);
  const start = page.locator(`li[data-lesson="${lessonId}"]`).getByRole("button");
  await (options.touch ? start.tap() : start.click());
  await page.waitForFunction(() => "learnToDjLesson" in window);
  await expect(page.locator("main.lesson")).toHaveAttribute("data-phase", "hook");
}

/** Every part of the controller a Lesson can unlock (each sits in its own frame), by control id. */
async function controlBoxes(page: Page): Promise<Box[]> {
  return page.locator(".controller [data-control]").evaluateAll((nodes) =>
    nodes.flatMap((node) => {
      const rect = node.getBoundingClientRect();
      const hidden = rect.width === 0 || rect.height === 0;
      return hidden ? [] : [{ name: node.getAttribute("data-control") ?? "?", x: rect.x, y: rect.y + window.scrollY, width: rect.width, height: rect.height }];
    }),
  );
}

/** The controller's big regions: readouts, decks, the mixer's channels and centre, the crossfader.
 * Measured together in page coordinates, so a step's smooth scroll cannot skew one against another. */
async function regionBoxes(page: Page, selectors: readonly string[]): Promise<Box[]> {
  return page.evaluate(
    (wanted) =>
      wanted.map((selector) => {
        const node = document.querySelector(selector);
        if (node === null) throw new Error(`${selector} is not on the page`);
        const rect = node.getBoundingClientRect();
        return { name: selector, x: rect.x, y: rect.y + window.scrollY, width: rect.width, height: rect.height };
      }),
    selectors,
  );
}

/** Pairs of boxes that overlap by more than half a pixel. */
function overlaps(boxes: readonly Box[]): string[] {
  const slack = 0.5;
  return boxes.flatMap((a, index) =>
    boxes
      .slice(index + 1)
      .filter((b) => a.x + a.width - slack > b.x && b.x + b.width - slack > a.x && a.y + a.height - slack > b.y && b.y + b.height - slack > a.y)
      .map((b) => `${a.name} overlaps ${b.name}`),
  );
}

/** A box once the page has stopped scrolling (a step scrolls its control into view smoothly). */
async function settledBox(page: Page, locator: Locator): Promise<Box> {
  let last = "";
  for (;;) {
    const box = await locator.boundingBox();
    if (box === null) throw new Error("The control is not on the page.");
    const now = JSON.stringify(box);
    if (now === last) return { name: "settled", ...box };
    last = now;
    await page.waitForTimeout(150);
  }
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

const PHONE_REGIONS = [
  ".deck-readout.deck-A",
  ".display-centre",
  "section.deck-A",
  ".channel-A",
  ".mixer-left",
  ".master-group",
  ".beat-fx",
  ".control.crossfader",
  ".deck-readout.deck-B",
  ".channel-B",
  "section.deck-B",
];

for (const [orientation, width, height] of [
  ["portrait", 412, 915],
  ["portrait", 360, 780],
  ["landscape", 915, 412],
] as const) {
  test.describe(`a phone, ${orientation} (${String(width)}×${String(height)})`, () => {
    test.use(phone(width, height));

    test("the controller fits the width and no part sits on another", async ({ page }) => {
      await openLesson(page, "deck-basics", { touch: true });
      expect(await horizontalOverflow(page), "the page scrolls sideways").toBeLessThanOrEqual(0);
      expect(overlaps(await controlBoxes(page))).toEqual([]);
      if (orientation === "portrait") expect(overlaps(await regionBoxes(page, PHONE_REGIONS))).toEqual([]);
      else expect(overlaps(await regionBoxes(page, [".controller-display", "section.deck-A", "section.mixer", "section.deck-B"]))).toEqual([]);
    });

    test("each step's control is on screen, finger-sized, and captioned with its name", async ({ page }) => {
      await openLesson(page, "deck-basics", { touch: true });
      const caption = page.getByRole("status", { name: "Lesson caption" });
      await expect(caption).toHaveText("Tap PLAY");
      await expect(page.locator('[data-control="A.play"] .caption')).toHaveText("Tap PLAY");
      await expect(page.locator(".lesson kbd:visible")).toHaveCount(0);

      const play = page.getByRole("button", { name: "Deck A play/pause" });
      await expect(play).toBeInViewport();
      const playBox = await play.boundingBox();
      expect(playBox?.width).toBeGreaterThanOrEqual(TOUCH_TARGET_PX);
      expect(playBox?.height).toBeGreaterThanOrEqual(TOUCH_TARGET_PX);
      await play.tap();

      // Next step: the fader. The key in the authored caption ("(W)") is gone on a touchscreen.
      await expect(caption).toContainText("Push the fader up");
      await expect(caption).not.toContainText("(W)");
      const fader = page.getByRole("slider", { name: "CH A" });
      await expect(fader).toBeInViewport();
      const faderBox = await settledBox(page, fader);
      expect(faderBox.width).toBeGreaterThanOrEqual(TOUCH_TARGET_PX);
      expect(faderBox.height).toBeGreaterThanOrEqual(TOUCH_TARGET_PX);

      // Fader up, then down with a finger, and practice begins. There is no Enter key on a phone: a
      // button goes into the Check, and another restarts it. Playwright has no touch drag, so the
      // touches go through the DevTools protocol.
      const touchscreen = await page.context().newCDPSession(page);
      const touch = async (type: "touchStart" | "touchMove", x: number, y: number) => touchscreen.send("Input.dispatchTouchEvent", { type, touchPoints: [{ x, y }] });
      // One stroke along the fader moves it end to end (the cap follows the finger). A finger can only
      // touch what is on screen, and the CDP touches land wherever they are sent: in the Check the
      // caption line is taller and pushes the fader partly below a 360×780 screen, where a touch
      // would scroll the page instead. So the fader is brought fully on screen first, as a person
      // would scroll to it, and measured once the page is still.
      const stroke = async (direction: "up" | "down") => {
        await fader.scrollIntoViewIfNeeded();
        await expect(fader).toBeInViewport({ ratio: 1 });
        const box = await settledBox(page, fader);
        const x = box.x + box.width / 2;
        const [fromY, toY] = direction === "up" ? [box.y + box.height - 4, box.y + 4] : [box.y + 4, box.y + box.height - 4];
        await touch("touchStart", x, fromY);
        for (let step = 1; step <= 8; step += 1) await touch("touchMove", x, fromY + ((toY - fromY) * step) / 8);
        await touchscreen.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      };
      const strokeToEnd = async (direction: "up" | "down") => {
        await stroke(direction);
        await expect(fader, `one stroke ${direction} moves the fader to the end`).toHaveAttribute("aria-valuenow", direction === "up" ? "1" : "0");
      };
      await strokeToEnd("up");
      await expect(caption).toContainText("pull it down");
      await strokeToEnd("down");
      await expect(page.locator("main.lesson")).toHaveAttribute("data-phase", "practice");
      const go = page.getByRole("button", { name: "Start the Check" });
      await expect(go).toBeInViewport();
      expect((await settledBox(page, go)).height).toBeGreaterThanOrEqual(TOUCH_TARGET_PX);
      await go.tap();
      await expect(page.locator("main.lesson")).toHaveAttribute("data-phase", "check");
      await expect(page.getByRole("button", { name: "Restart" })).toBeVisible();
      await expect(caption).toContainText("This one counts: PLAY");

      // The Check by touch: PLAY, fader up, a moment heard, fader down. The result shows on screen
      // wherever the page is scrolled.
      await play.tap();
      await strokeToEnd("up");
      await page.waitForTimeout(1500);
      await strokeToEnd("down");
      const card = page.getByRole("region", { name: "Result" });
      await expect(card).toHaveAttribute("data-outcome", "passed", { timeout: 10_000 });
      await expect(card).toBeInViewport({ ratio: 1 });
      await expect(card.getByRole("button", { name: "Go again" })).toBeInViewport();
    });
  });
}

test.describe("a flick on a phone (412×915, touch)", () => {
  test.use(phone(412, 915));

  // A finger that flicks a fader (lifts off while still moving) and taps a button straight after: the
  // tap must land. Chromium makes a fling of a moving lift-off even where the page cannot scroll, and a
  // tap during a fling only stops it, unless the control keeps its touches (ISS-103).
  test("a tap straight after flicking a fader still presses the button", async ({ page }) => {
    await openLesson(page, "deck-basics", { touch: true });
    const caption = page.getByRole("status", { name: "Lesson caption" });
    await page.getByRole("button", { name: "Deck A play/pause" }).tap();
    await expect(caption).toContainText("Push the fader up");
    const fader = page.getByRole("slider", { name: "CH A" });
    const touchscreen = await page.context().newCDPSession(page);
    /** One stroke along the fader, as fast as the touches can be sent, lifting off mid-move. */
    const flick = async (direction: "up" | "down") => {
      await fader.scrollIntoViewIfNeeded();
      const box = await settledBox(page, fader);
      const x = box.x + box.width / 2;
      const [fromY, toY] = direction === "up" ? [box.y + box.height - 4, box.y + 4] : [box.y + 4, box.y + box.height - 4];
      await touchscreen.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: fromY }] });
      for (let step = 1; step <= 8; step += 1) await touchscreen.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: fromY + ((toY - fromY) * step) / 8 }] });
      await touchscreen.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await expect(fader).toHaveAttribute("aria-valuenow", direction === "up" ? "1" : "0");
    };
    await flick("up");
    await flick("down");
    await expect(page.locator("main.lesson")).toHaveAttribute("data-phase", "practice");
    // Three times: flick the fader, tap "Start the Check" at once, and back to practice (P, from the test).
    for (let round = 1; round <= 3; round += 1) {
      await flick(round % 2 === 1 ? "up" : "down");
      await page.getByRole("button", { name: "Start the Check" }).tap();
      await expect(page.locator("main.lesson"), `round ${String(round)}: the tap after the flick`).toHaveAttribute("data-phase", "check");
      await page.keyboard.press("KeyP");
      await expect(page.locator("main.lesson")).toHaveAttribute("data-phase", "practice");
    }
  });
});

test.describe("Lesson 2 on a phone", () => {
  test.use(phone(412, 915));

  test("names TAP, not Space, and TAP is finger-sized and on screen", async ({ page }) => {
    await openLesson(page, "beats-and-bars", { touch: true, passed: ["deck-basics"] });
    await expect(page.getByRole("status", { name: "Lesson caption" })).toHaveText("Tap TAP on every kick");
    const tap = page.getByRole("button", { name: "Tap the beat" });
    await expect(tap).toBeInViewport({ ratio: 1 });
    const box = await tap.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(TOUCH_TARGET_PX);
    expect(box?.height).toBeGreaterThanOrEqual(TOUCH_TARGET_PX);
  });
});

/** An engine command from the test, standing in for a knob turn the touch tests cannot drag. */
async function command(page: Page, sent: Record<string, unknown>): Promise<void> {
  const ok = await page.evaluate(
    (payload) => (window as unknown as { learnToDjLesson?: { engine: { command(c: unknown, i: { device: string }): { ok: boolean } } } }).learnToDjLesson?.engine.command(payload, { device: "touch" }).ok,
    sent,
  );
  expect(ok, JSON.stringify(sent)).toBe(true);
}

async function expectFingerSized(page: Page, locator: Locator): Promise<void> {
  await expect(locator).toBeInViewport();
  const box = await settledBox(page, locator);
  expect(box.width).toBeGreaterThanOrEqual(TOUCH_TARGET_PX);
  expect(box.height).toBeGreaterThanOrEqual(TOUCH_TARGET_PX);
}

const BY_EAR_BEFORE = ["deck-basics", "beats-and-bars", "phrases", "gain-staging", "headphone-cue", "cue-point", "cut-on-phrase", "tempo-fader", "sync-blend", "crossfader", "eq-basics"];

test.describe("the by-ear Lessons on a phone (412×915, touch)", () => {
  test.use(phone(412, 915));

  test("nudge-phase: the jog names no key, is finger-sized, and a finger turning it nudges B", async ({ page }) => {
    await openLesson(page, "nudge-phase", { touch: true, passed: BY_EAR_BEFORE });
    const caption = page.getByRole("status", { name: "Lesson caption" });
    await expect(caption).toHaveText("Two kicks? Turn jog B");
    await expect(page.locator('[data-control="B.jog"] .caption')).toHaveText("Two kicks? Turn jog B");
    const jog = page.locator('[data-control="B.jog"] .jog-surface');
    await expectFingerSized(page, jog);

    // A finger round the platter, clockwise, a frame at a time: B bends faster while it turns, and
    // the nudge moves the hook on. Measured each stroke (the page may still be scrolling the jog into
    // view); a finger goes again, as a person would, at most three times.
    const touchscreen = await page.context().newCDPSession(page);
    const stroke = async () => {
      const box = await settledBox(page, jog);
      const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const radius = box.width * 0.35;
      const at = (angle: number) => ({ x: centre.x + radius * Math.cos(angle), y: centre.y + radius * Math.sin(angle) });
      await touchscreen.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at(0)] });
      for (let step = 1; step <= 12; step += 1) {
        await touchscreen.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [at(step * 0.15)] });
        await page.waitForTimeout(25);
      }
      await touchscreen.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    };
    for (let count = 0; count < 3 && !((await caption.textContent()) ?? "").includes("PHASE dot"); count += 1) await stroke();
    await expect(caption).toContainText("PHASE dot");
  });

  test("tempo-by-ear: the BPM is covered; a tempo move is the guess; Ready is a finger-sized button", async ({ page }) => {
    await openLesson(page, "tempo-by-ear", { touch: true, passed: [...BY_EAR_BEFORE, "nudge-phase"] });
    const caption = page.getByRole("status", { name: "Lesson caption" });
    await expect(page.locator('[data-control="B.bpm"] .readout-number')).toHaveText("–");
    await expect(caption).toContainText("Slide TEMPO B");
    // The tempo fader from the test (the fader swipe has its own test above): the round's first move is the guess.
    await command(page, { control: "tempo", deck: "B", value: 0 });
    await expect(caption.locator(".lesson-do")).toHaveText("Closer and closer: when the drift stops, Ready");
    const ready = page.getByRole("button", { name: "Ready", exact: true });
    await expectFingerSized(page, ready);
    await ready.tap();
    await expect(page.locator("main.lesson")).toHaveAttribute("data-phase", "practice");
    await expect(page.getByRole("status", { name: "Practice feedback" })).toContainText("BPM apart");
  });
});

test.describe("Ready (R) on a phone", () => {
  test.use(phone(412, 915));
  const phase = (page: Page) => page.locator("main.lesson");
  const ready = (page: Page) => page.getByRole("button", { name: "Ready", exact: true });

  test("gain-staging: Ready is a finger-sized button in practice and the Check, and it marks the deck Ready", async ({ page }) => {
    await openLesson(page, "gain-staging", { touch: true, passed: ["deck-basics"] });
    const caption = page.getByRole("status", { name: "Lesson caption" });
    // The hook, with the trims turned from the test: A into the zone, PLAY B, B into the zone.
    await command(page, { control: "trim", deck: "A", value: 1 / 3 });
    await expect(caption).toContainText("Tap PLAY on deck B", { timeout: 5000 });
    await command(page, { control: "play", deck: "B" });
    await command(page, { control: "trim", deck: "B", value: 1 / 3 });
    await expect(phase(page)).toHaveAttribute("data-phase", "practice", { timeout: 5000 });
    await expect(caption).toContainText("then Ready");
    await expect(caption).not.toContainText("(R)");
    await expectFingerSized(page, ready(page));

    await page.getByRole("button", { name: "Start the Check" }).tap();
    await expect(phase(page)).toHaveAttribute("data-phase", "check");
    await expect(page.locator(".lesson-cue")).toHaveText("Trim A into the zone, then Ready");
    await expectFingerSized(page, ready(page));
    await ready(page).tap();
    await expect(page.locator(".lesson-cue")).toHaveText("Hands off A. Trim B to match, then Ready");
  });

  test("cue-point: no Ready in practice (a cue point is the rep), a finger-sized Ready in the Check", async ({ page }) => {
    await openLesson(page, "cue-point", { touch: true, passed: ["deck-basics", "beats-and-bars", "headphone-cue"], headphones: true });
    // The hook from the test: search, set a cue point, hold CUE on it to preview, let go.
    await command(page, { control: "jog-search", deck: "A", value: 0.1 });
    await command(page, { control: "deck-cue", deck: "A", value: true });
    await command(page, { control: "deck-cue", deck: "A", value: false });
    await command(page, { control: "deck-cue", deck: "A", value: true });
    await command(page, { control: "deck-cue", deck: "A", value: false });
    await expect(phase(page)).toHaveAttribute("data-phase", "practice", { timeout: 5000 });
    await expect(ready(page)).toHaveCount(0);

    await page.getByRole("button", { name: "Start the Check" }).tap();
    await expect(page.locator(".lesson-cue")).toHaveText("Cue 1 of 3: a 1, by ear. Ready when happy");
    await expectFingerSized(page, ready(page));
  });
});

test.describe("the playground on a phone", () => {
  test.use(phone(412, 915));

  test("fits the width with no part on another", async ({ page }) => {
    await page.goto("/playground?playground");
    await expect(page.locator(".controller")).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    expect(overlaps(await controlBoxes(page))).toEqual([]);
    expect(overlaps(await regionBoxes(page, PHONE_REGIONS))).toEqual([]);
    await expect(page.getByTestId("audio-state")).not.toContainText("click");
  });
});

test.describe("the laptop layout (1280×800, trackpad)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("is unchanged: three columns on one row, key captions, no scrolling", async ({ page }) => {
    await openLesson(page, "deck-basics", { touch: false });
    await expect(page.getByRole("status", { name: "Lesson caption" })).toHaveText("Press X");
    await expect(page.getByRole("button", { name: "Keys" })).toBeVisible();

    const [deckA, mixer, deckB, display] = await regionBoxes(page, ["section.deck-A", "section.mixer", "section.deck-B", ".controller-display"]);
    if (deckA === undefined || mixer === undefined || deckB === undefined || display === undefined) throw new Error("A controller region is missing.");
    // One row: deck A, the mixer, deck B, side by side under the display row, decks the same width.
    expect(deckA.x + deckA.width).toBeLessThanOrEqual(mixer.x);
    expect(mixer.x + mixer.width).toBeLessThanOrEqual(deckB.x);
    expect(Math.abs(deckA.y - mixer.y)).toBeLessThan(1);
    expect(Math.abs(deckB.y - mixer.y)).toBeLessThan(1);
    expect(Math.abs(deckA.width - deckB.width)).toBeLessThan(1);
    expect(display.y + display.height).toBeLessThanOrEqual(deckA.y);
    // Sizes still follow the viewport height: the jog wheel is 30vh (240 px at 800 high).
    const jog = await page.locator('[data-control="A.jog"] .jog-surface').boundingBox();
    expect(jog?.width).toBeCloseTo(240, 0);
    expect(await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBeLessThanOrEqual(0);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });
});

test.describe("faders on a phone (412×915, touch)", () => {
  test.use(phone(412, 915));

  /** The centre of a slider's cap, in the viewport. */
  async function capCentre(slider: Locator): Promise<{ x: number; y: number }> {
    const cap = await slider.locator(".fader-thumb").boundingBox();
    if (cap === null) throw new Error("The fader cap is not on the page.");
    return { x: cap.x + cap.width / 2, y: cap.y + cap.height / 2 };
  }

  // A finger put on the cap and swiped to the track's far end takes the fader end to end, with the
  // cap under the finger all the way (drag travel = the fader's rendered track length).
  for (const [name, axis] of [
    ["CH A", "vertical"],
    ["TEMPO", "vertical"],
    ["CROSSFADER", "horizontal"],
  ] as const) {
    test(`${name}: a full-length swipe moves it end to end with the cap under the finger`, async ({ page }) => {
      await page.goto("/playground?playground");
      const slider = page.getByRole("slider", { name, exact: true }).first();
      await slider.scrollIntoViewIfNeeded();
      const min = Number(await slider.getAttribute("aria-valuemin"));
      const max = Number(await slider.getAttribute("aria-valuemax"));
      const track = await settledBox(page, slider.locator(".fader-track"));
      // The ends of the track along the fader's axis: bottom and top, or left and right.
      const ends = axis === "vertical" ? { low: track.y + track.height, high: track.y } : { low: track.x, high: track.x + track.width };
      // The tempo fader's top is its minimum (faster is towards you); the others' bottom or left is.
      const [lowValue, highValue] = name === "TEMPO" ? [max, min] : [min, max];

      const touchscreen = await page.context().newCDPSession(page);
      const swipeTo = async (target: number) => {
        const from = await capCentre(slider);
        const start = axis === "vertical" ? from.y : from.x;
        const point = (along: number) => (axis === "vertical" ? { x: from.x, y: along } : { x: along, y: from.y });
        await touchscreen.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(start)] });
        const steps = 10;
        for (let step = 1; step <= steps; step += 1) {
          const finger = start + ((target - start) * step) / steps;
          await touchscreen.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(finger)] });
          await expect
            .poll(
              async () => {
                const cap = await capCentre(slider);
                return Math.abs((axis === "vertical" ? cap.y : cap.x) - finger);
              },
              { message: `the cap is under the finger at step ${String(step)}` },
            )
            .toBeLessThanOrEqual(2);
        }
        await touchscreen.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      };

      await swipeTo(ends.low);
      await expect(slider).toHaveAttribute("aria-valuenow", String(lowValue));
      await swipeTo(ends.high);
      await expect(slider).toHaveAttribute("aria-valuenow", String(highValue));
    });
  }
});

// Laptop widths around 1280: every control and region keeps to its own space (a button once
// spilled into the hot cue pads at 1280×800).
for (const [width, height] of [
  [1180, 800],
  [1280, 800],
  [1440, 900],
] as const) {
  test.describe(`the playground on a laptop (${String(width)}×${String(height)})`, () => {
    test.use({ viewport: { width, height } });

    test("no control or region sits on another", async ({ page }) => {
      await page.goto("/playground?playground");
      await expect(page.locator(".controller")).toBeVisible();
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
      expect(overlaps(await controlBoxes(page))).toEqual([]);
      expect(overlaps(await regionBoxes(page, [".controller-display", "section.deck-A", "section.mixer", "section.deck-B"]))).toEqual([]);
      expect(overlaps(await regionBoxes(page, [".deck-A .tempo-column", ".deck-A .deck-main", ".deck-B .tempo-column", ".deck-B .deck-main"]))).toEqual([]);
    });
  });
}

// Lessons 8–11 on a phone: each Lesson's new part is on screen and finger-sized when its step asks
// for it, the captions name controls (no key), and Ready and the question answers are buttons.
test.describe("Lessons 8–11 on a phone (412×915, touch)", () => {
  test.use(phone(412, 915));
  const FIRST_SEVEN = ["deck-basics", "beats-and-bars", "phrases", "gain-staging", "headphone-cue", "cue-point", "cut-on-phrase"];
  const caption = (page: Page) => page.getByRole("status", { name: "Lesson caption" });
  const phase = (page: Page) => page.locator("main.lesson");
  const ready = (page: Page) => page.getByRole("button", { name: "Ready", exact: true });

  test("tempo-fader: TEMPO B and its BPM on screen, Ready in practice and the Check, On/Off answers", async ({ page }) => {
    test.setTimeout(90_000);
    await openLesson(page, "tempo-fader", { touch: true, passed: ["deck-basics"] });
    await expect(caption(page).locator(".lesson-do")).toHaveText("Slide TEMPO B near +: faster");
    await expectFingerSized(page, page.locator("section.deck-B").getByRole("slider", { name: "TEMPO" }));
    await expect(page.locator('[data-control="B.bpm"]')).toBeInViewport();
    await command(page, { control: "tempo", deck: "B", value: 0.8 });
    await expect(caption(page)).toContainText("Hold BEAT SYNC B: Master Tempo");
    const syncB = page.getByRole("button", { name: /Deck B beat sync/ });
    await expectFingerSized(page, syncB);
    // A finger held on BEAT SYNC: Master Tempo, as on the FLX4.
    await syncB.scrollIntoViewIfNeeded();
    const box = await settledBox(page, syncB);
    const finger = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const touchscreen = await page.context().newCDPSession(page);
    await touchscreen.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [finger] });
    await expect(page.getByTestId("master-tempo-lamp-B")).toHaveAttribute("data-on", "true");
    await touchscreen.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expectFingerSized(page, page.getByRole("button", { name: /Deck B tempo range/ }));
    await page.getByRole("button", { name: /Deck B tempo range/ }).tap();

    await expect(phase(page)).toHaveAttribute("data-phase", "practice");
    await expect(caption(page)).toContainText("Set B to 126.0 BPM, then Ready");
    await expect(caption(page)).not.toContainText("(R)");
    await expectFingerSized(page, ready(page));

    await page.getByRole("button", { name: "Start the Check" }).tap();
    await expect(page.locator(".lesson-cue")).toHaveText("Set B to 127.0 BPM, then Ready");
    for (let index = 0; index < 3; index += 1) await ready(page).tap();
    const answer = page.getByRole("group", { name: "Clip 1: Master Tempo on or off?" }).getByRole("button", { name: "On" });
    await expectFingerSized(page, answer);
    await expect(caption(page).locator(".lesson-do")).toHaveText("Clip 1: Master Tempo on or off?");
  });

  test("tempo-fader: a finger slid out to the side of TEMPO moves it a fifth as far, for a BPM to a tenth", async ({ page }) => {
    await openLesson(page, "tempo-fader", { touch: true, passed: ["deck-basics"] });
    const tempo = page.locator("section.deck-B").getByRole("slider", { name: "TEMPO" });
    const touchscreen = await page.context().newCDPSession(page);
    const touch = async (type: "touchStart" | "touchMove", x: number, y: number) => touchscreen.send("Input.dispatchTouchEvent", { type, touchPoints: [{ x, y }] });
    /** A 20 px stroke down the fader, the finger first slid `sideways` px off it; how far the value moved. */
    const stroke = async (sideways: number) => {
      const box = await settledBox(page, tempo);
      const before = Number(await tempo.getAttribute("aria-valuenow"));
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await touch("touchStart", x, y);
      for (let step = 1; step <= 4; step += 1) await touch("touchMove", x + (sideways * step) / 4, y);
      for (let step = 1; step <= 4; step += 1) await touch("touchMove", x + sideways, y + 5 * step);
      await touchscreen.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await expect.poll(async () => Number(await tempo.getAttribute("aria-valuenow"))).not.toBe(before);
      return Math.abs(Number(await tempo.getAttribute("aria-valuenow")) - before);
    };
    const coarse = await stroke(0);
    const fine = await stroke(80);
    expect(fine).toBeGreaterThan(0);
    expect(fine).toBeLessThan(coarse / 3);
  });

  test("sync-blend: BEAT SYNC on B is on screen and finger-sized, captions name PLAY on deck B", async ({ page }) => {
    await openLesson(page, "sync-blend", { touch: true, passed: [...FIRST_SEVEN, "tempo-fader"], headphones: true });
    await expect(caption(page).locator(".lesson-do")).toHaveText("Press BEAT SYNC on B");
    await expectFingerSized(page, page.getByRole("button", { name: "Deck B beat sync" }));
    await page.getByRole("button", { name: "Deck B beat sync" }).tap();
    await expect(caption(page)).toContainText("On a phrase's bar 1: Tap PLAY on deck B");
  });

  test("crossfader: the crossfader is on screen and finger-sized, its cut key is not in the caption", async ({ page }) => {
    await openLesson(page, "crossfader", { touch: true, passed: [...FIRST_SEVEN, "tempo-fader", "sync-blend"], headphones: true });
    await expect(caption(page).locator(".lesson-do")).toHaveText("Tap PLAY on deck B to play B");
    await command(page, { control: "play", deck: "B" });
    await expect(caption(page)).toContainText("Slide the crossfader to B");
    await expectFingerSized(page, page.getByRole("slider", { name: "CROSSFADER" }));
    await command(page, { control: "crossfader", value: 1 });
    await expect(caption(page)).toContainText("Snap it back to A");
    await expect(caption(page)).not.toContainText("(C)");
  });

  test("eq-basics: LOW A is on screen and finger-sized", async ({ page }) => {
    await openLesson(page, "eq-basics", { touch: true, passed: ["deck-basics", "beats-and-bars", "phrases", "gain-staging"] });
    await expect(caption(page).locator(".lesson-do")).toHaveText("Turn LOW A all the way down");
    await expectFingerSized(page, page.locator(".channel-A").getByRole("slider", { name: "LOW" }));
  });
});

// Lessons 12–13 on a phone: LOW B and PLAY B for the swap, then CFX A for the filter, on screen and
// finger-sized when the step asks; captions name PLAY and the faders, no key; the Check starts by button.
test.describe("Lessons 12–13 on a phone (412×915, touch)", () => {
  test.use(phone(412, 915));
  const BEFORE = ["deck-basics", "beats-and-bars", "phrases", "gain-staging", "headphone-cue", "cue-point", "cut-on-phrase", "tempo-fader", "sync-blend", "eq-basics"];
  const caption = (page: Page) => page.getByRole("status", { name: "Lesson caption" });
  const phase = (page: Page) => page.locator("main.lesson");

  test("bass-swap: LOW B, PLAY B and LOW A on screen and finger-sized, PLAY named for a finger", async ({ page }) => {
    await openLesson(page, "bass-swap", { touch: true, passed: BEFORE, headphones: true });
    await expect(caption(page).locator(".lesson-do")).toHaveText("Turn LOW B all the way down");
    await expectFingerSized(page, page.locator(".channel-B").getByRole("slider", { name: "LOW" }));
    await command(page, { control: "eq-low", deck: "B", value: -1 });
    await expect(caption(page)).toContainText("On the phrase's 1: Tap PLAY on deck B and push fader B up");
    await expectFingerSized(page, page.locator('[data-control="B.play"] button'));
    await command(page, { control: "play", deck: "B" });
    await expect(caption(page)).toContainText("Swap: LOW A down, LOW B up");
    await expectFingerSized(page, page.locator(".channel-A").getByRole("slider", { name: "LOW" }));
    await command(page, { control: "eq-low", deck: "A", value: -1 });
    await command(page, { control: "eq-low", deck: "B", value: 0 });
    await expect(phase(page)).toHaveAttribute("data-phase", "practice");
    const go = page.getByRole("button", { name: "Start the Check" });
    await expectFingerSized(page, go);
    await go.tap();
    await expect(phase(page)).toHaveAttribute("data-phase", "check");
    // The set-up step, off the clock: Ready is a finger-sized button.
    await expect(page.locator(".lesson-cue")).toHaveText("Set up: CUE 🎧 B on, LOW B all the way down");
    await expectFingerSized(page, page.getByRole("button", { name: "Ready", exact: true }));
  });

  test("filter-transition: CFX A on screen and finger-sized, CFX B after the hook, no S in the captions", async ({ page }) => {
    await openLesson(page, "filter-transition", { touch: true, passed: BEFORE, headphones: true });
    await expect(caption(page).locator(".lesson-do")).toHaveText("Turn CFX A right");
    await expectFingerSized(page, page.locator(".channel-A").getByRole("slider", { name: "CFX" }));
    await command(page, { control: "filter", deck: "A", value: 0.8 });
    await expect(caption(page)).toContainText("Now turn CFX A left");
    await command(page, { control: "filter", deck: "A", value: -0.8 });
    await expect(caption(page)).toContainText("CFX A back to the middle");
    await command(page, { control: "filter", deck: "A", value: 0 });
    await expect(phase(page)).toHaveAttribute("data-phase", "practice");
    // Practice's set-up step first; once set it goes on by itself where A's phrase comes round.
    await expect(caption(page)).toContainText("Set up: CUE 🎧 B on");
    await command(page, { control: "headphone-cue", deck: "B", value: true });
    await expect(caption(page)).toContainText("All set: starts on the next phrase");
    await expect(caption(page)).toContainText("CFX A right from 2 bars before B; A out a phrase after B", { timeout: 30_000 });
    await expect(caption(page)).not.toContainText("(S)");
    // No step asks for CFX B yet: it is unlocked and finger-sized, a scroll away.
    const cfxB = page.locator(".channel-B").getByRole("slider", { name: "CFX" });
    await expect(page.locator('[data-control="B.filter"]')).toHaveAttribute("data-locked", "false");
    await cfxB.scrollIntoViewIfNeeded();
    await expectFingerSized(page, cfxB);
  });
});

test.describe("Lesson 20, the set, on a phone (412×915, portrait, touch)", () => {
  test.use(phone(412, 915));
  const ROUTE = ["deck-basics", "beats-and-bars", "phrases", "gain-staging", "headphone-cue", "cue-point", "cut-on-phrase", "tempo-fader", "sync-blend", "eq-basics", "bass-swap", "nudge-phase", "tempo-by-ear", "blend-by-ear"];

  test("the set builder fits the width with finger-sized buttons, and the warm-up names controls, not keys", async ({ page }) => {
    test.setTimeout(60_000);
    const learnerId = `e2e-mobile-set-${String(Date.now())}`;
    await page.goto(`/?learner=${learnerId}`);
    const status = await page.evaluate(
      async ({ id, lessonIds }) => {
        const at = new Date().toISOString();
        const lessons = Object.fromEntries(lessonIds.map((lesson) => [lesson, { lessonId: lesson, passedAt: at, passedVia: "lesson", attempts: 1, reviewSuggestedAt: null, reviewDeclinedAt: null }]));
        const record = { schemaVersion: 1, learnerId: id, mission: "", missionTags: [], curriculum: null, headphones: { checkedAt: at }, skillProfile: { schemaVersion: 1, learnerId: id, lessons, criteria: {}, courseCompletedAt: null } };
        return (await fetch(`/api/learners/${id}/profile`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(record) })).status;
      },
      { id: learnerId, lessonIds: ROUTE },
    );
    expect(status).toBe(200);
    await page.goto(`/?learner=${learnerId}&track=synthetic`);
    await page.locator('li[data-lesson="final-mix"]').getByRole("button").tap();

    const add = page.getByRole("button", { name: "Add Set Groove C (synthetic)" });
    await expect(add).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await expectFingerSized(page, add);
    for (const title of ["Set Groove C (synthetic)", "Set Groove Am (synthetic)", "Set Groove Em (synthetic)"]) await page.getByRole("button", { name: `Add ${title}` }).tap();
    await expect(page.getByRole("region", { name: "Your set" }).locator("li[data-track]")).toHaveCount(3);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    const remove = page.getByRole("button", { name: "Remove Set Groove C (synthetic)" });
    await remove.scrollIntoViewIfNeeded();
    await expectFingerSized(page, remove);
    const load = page.getByRole("button", { name: "Load the set" });
    await load.scrollIntoViewIfNeeded();
    await expectFingerSized(page, load);
    await load.tap();

    await expect(page.locator("main.final-mix")).toHaveAttribute("data-phase", "warm-up");
    await expect(page.getByRole("status", { name: "Lesson caption" })).toContainText("Warm up: Tap PLAY to play track 1");
    const start = page.getByRole("button", { name: "Start the set" });
    await expectFingerSized(page, start);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });
});

// Lessons 17–19 on a phone: the pads, the loop buttons and the Beat FX strip are on screen and
// finger-sized when a step asks for them, and the captions name them (no key).
test.describe("Lessons 17–19 on a phone (412×915, touch)", () => {
  test.use(phone(412, 915));
  const FIRST_SIX = ["deck-basics", "beats-and-bars", "phrases", "gain-staging", "headphone-cue", "cue-point"];
  const TO_SYNC_BLEND = [...FIRST_SIX, "cut-on-phrase", "tempo-fader", "sync-blend"];
  const caption = (page: Page) => page.getByRole("status", { name: "Lesson caption" });

  test("hot-cues: pad 2 is finger-sized, the captions say 'Tap pad 2', and Ready shows in the Check", async ({ page }) => {
    await openLesson(page, "hot-cues", { touch: true, passed: FIRST_SIX });
    await expect(caption(page).locator(".lesson-do")).toHaveText("Tap pad 2: pad 2 keeps this spot");
    const pad = page.getByRole("button", { name: /Deck A hot cue 2/ });
    await expectFingerSized(page, pad);
    await pad.tap();
    await expect(caption(page)).toContainText("Tap pad 2 again");
    await pad.tap();
    await expect(page.locator("main.lesson")).toHaveAttribute("data-phase", "practice");
    await expect(caption(page)).toContainText("Pad 1 is the drop: Tap pad 1 on a phrase's 1");
    await page.getByRole("button", { name: "Start the Check" }).tap();
    await expect(page.locator(".lesson-cue")).toContainText("Pad 1: jog to this phrase's 1 (hold CUE to check), Tap pad 1, then Ready");
    await expectFingerSized(page, page.getByRole("button", { name: "Ready", exact: true }));
  });

  test("loop-transition: 4 BEAT/EXIT and LOOP IN are finger-sized and named in the captions", async ({ page }) => {
    await openLesson(page, "loop-transition", { touch: true, passed: TO_SYNC_BLEND, headphones: true });
    await expect(caption(page).locator(".lesson-do")).toHaveText("Tap 4 BEAT/EXIT: a 4-beat loop");
    const button = page.getByRole("button", { name: "Deck A 4 beat loop or exit" });
    await expectFingerSized(page, button);
    await button.tap();
    await expect(caption(page)).toContainText("Tap 4 BEAT/EXIT again: EXIT");
    await button.tap();
    await expect(caption(page)).toContainText("LOOP IN on a 1");
    await expect(caption(page)).not.toContainText("(D)");
    await expectFingerSized(page, page.getByRole("button", { name: "Deck A loop in" }));
  });

  test("echo-out: the Beat FX panel fits the screen, every part finger-sized, nothing on anything else", async ({ page }) => {
    await openLesson(page, "echo-out", { touch: true, passed: TO_SYNC_BLEND, headphones: true });
    await expect(caption(page).locator(".lesson-do")).toHaveText("Tap BEAT FX ON: BEAT FX on");
    const on = page.getByRole("button", { name: "Beat FX on/off" });
    await expectFingerSized(page, on);
    await expectFingerSized(page, page.getByRole("button", { name: /Beat FX channel CH 1/ }));
    await on.tap();
    await expect(caption(page)).toContainText("Turn DEPTH");
    await expectFingerSized(page, page.getByRole("slider", { name: "DEPTH" }));
    await command(page, { control: "beat-fx-depth", value: 0.8 });
    await expect(caption(page)).toContainText("Tap BEAT ▶ for longer echoes");
    await expectFingerSized(page, page.getByRole("button", { name: "Beat FX beat longer" }));
    await expectFingerSized(page, page.getByRole("button", { name: "Beat FX beat shorter" }));
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    expect(overlaps(await controlBoxes(page))).toEqual([]);
  });
});
