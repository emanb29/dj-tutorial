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

async function openLesson(page: Page, lessonId: string, options: { readonly touch: boolean; readonly passed?: readonly string[] }): Promise<void> {
  const learnerId = `e2e-mobile-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`;
  const passed = options.passed ?? [];
  if (passed.length > 0) {
    // Earlier Lessons passed, through the app's own API (from the page, so it sees the app's Origin).
    await page.goto(`/?learner=${learnerId}`);
    const status = await page.evaluate(
      async ({ id, lessonIds }) => {
        const at = new Date().toISOString();
        const lessons = Object.fromEntries(lessonIds.map((lesson) => [lesson, { lessonId: lesson, passedAt: at, passedVia: "lesson", attempts: 1, reviewSuggestedAt: null, reviewDeclinedAt: null }]));
        const record = { schemaVersion: 1, learnerId: id, mission: "", missionTags: [], curriculum: null, skillProfile: { schemaVersion: 1, learnerId: id, lessons, criteria: {}, courseCompletedAt: null } };
        const response = await fetch(`/api/learners/${id}/profile`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(record) });
        return response.status;
      },
      { id: learnerId, lessonIds: passed },
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
  ".mixer-centre",
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
      // A drag moves the fader 240 px end to end (gestures.ts), more than a phone's fader is long:
      // stroke along it a few times, as a finger would. Measured each time: the caption line above
      // changes height between steps.
      const stroke = async (direction: "up" | "down") => {
        const box = await settledBox(page, fader);
        const x = box.x + box.width / 2;
        const [fromY, toY] = direction === "up" ? [box.y + box.height - 4, box.y + 4] : [box.y + 4, box.y + box.height - 4];
        await touch("touchStart", x, fromY);
        for (let step = 1; step <= 8; step += 1) await touch("touchMove", x, fromY + ((toY - fromY) * step) / 8);
        await touchscreen.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      };
      for (let count = 0; count < 3; count += 1) await stroke("up");
      await expect(caption).toContainText("pull it down");
      for (let count = 0; count < 3; count += 1) await stroke("down");
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
      for (let count = 0; count < 3; count += 1) await stroke("up");
      await page.waitForTimeout(1500);
      for (let count = 0; count < 3; count += 1) await stroke("down");
      const card = page.getByRole("region", { name: "Result" });
      await expect(card).toHaveAttribute("data-outcome", "passed", { timeout: 10_000 });
      await expect(card).toBeInViewport({ ratio: 1 });
      await expect(card.getByRole("button", { name: "Go again" })).toBeInViewport();
    });
  });
}

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
