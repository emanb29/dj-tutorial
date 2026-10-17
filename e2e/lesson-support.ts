import { expect, type Page } from "@playwright/test";

// Shared steps for the Lesson end-to-end tests. They run muted, on the synthetic practice groove
// (?track=synthetic): 124 BPM, the first beat at 0 s, bar 1 on beat 0, so every beat is known.

type DeckId = "A" | "B";

interface Grid {
  bpm: number;
  firstBeat: number;
  downbeatIndex: number;
}

export interface LessonWindow {
  learnToDjLesson?: {
    engine: {
      playhead(deck: DeckId): { ok: boolean; beat?: number | null; positionSec?: number };
      deckState(deck: DeckId): { playing: boolean; cuePointSec: number; masterTempo?: boolean; syncOn?: boolean; tempoRate?: number };
      command(command: Record<string, unknown>, input: { device: string }): { ok: boolean };
      heardTime(performanceTimeMs?: number): { ok: boolean; ctx?: number };
      playheadAt(deck: DeckId, ctx: number): { beat: number | null } | null;
    };
    track: { grid: Grid };
    phase(): string;
    deckTrack(deck: DeckId): { trackId: string; grid: Grid } | null;
    clip?(): { masterTempo: boolean } | null;
  };
}

export const learner = (name: string) => `e2e-${name}-${String(Date.now())}`;

/**
 * Gives a Learner the server has never seen an empty profile, so the app shows the Lesson list
 * instead of the first-run Placement. A Learner who already has one keeps it.
 */
export async function ensureProfile(page: Page, learnerId: string): Promise<void> {
  await page.goto(`/?learner=${learnerId}`);
  const status = await page.evaluate(async (id) => {
    if ((await fetch(`/api/learners/${id}/profile`)).ok) return 200;
    const record = { schemaVersion: 1, learnerId: id, mission: "", missionTags: [], curriculum: null, skillProfile: { schemaVersion: 1, learnerId: id, lessons: {}, criteria: {}, courseCompletedAt: null } };
    const response = await fetch(`/api/learners/${id}/profile`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(record) });
    return response.status;
  }, learnerId);
  expect(status).toBe(200);
}

/** Opens a Lesson from the list; unless told otherwise, waits for its hook (past any headphones check). */
export async function openLesson(page: Page, learnerId: string, lessonId: string, options: { waitForHook?: boolean } = {}): Promise<void> {
  await ensureProfile(page, learnerId);
  await page.goto(`/?learner=${learnerId}&track=synthetic`);
  await page.locator(`li[data-lesson="${lessonId}"]`).getByRole("button").click();
  await page.waitForFunction(() => (window as LessonWindow).learnToDjLesson !== undefined);
  if (options.waitForHook !== false) await expect(page.locator("main.lesson")).not.toHaveAttribute("data-phase", "loading");
}

/** Seeds a profile with Lessons passed (and the headphones check, if asked), through the app's own API. */
export async function seedPassed(page: Page, learnerId: string, lessonIds: readonly string[], options: { headphones?: boolean } = {}): Promise<void> {
  await page.goto(`/?learner=${learnerId}`);
  const status = await page.evaluate(
    async ({ id, passed, headphones }) => {
      const at = new Date().toISOString();
      const lessons = Object.fromEntries(
        passed.map((lessonId) => [lessonId, { lessonId, passedAt: at, passedVia: "lesson", attempts: 1, reviewSuggestedAt: null, reviewDeclinedAt: null }]),
      );
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
    { id: learnerId, passed: lessonIds, headphones: options.headphones === true },
  );
  expect(status).toBe(200);
}

/**
 * Presses keys (by code) on each beat of a deck's grid, timed in the page from the engine's own heard
 * playhead. Each key event carries the beat's own time as its timeStamp, as a real keyboard's does: on
 * a loaded machine the page's timer wakes up to 200 ms late (ISS-84), and a press stamped when it is
 * finally dispatched would be graded that late. Late delivery of an on-time press is the app's to
 * handle (it grades the event's timeStamp, not when it got to it); the test's timer is not the Learner.
 */
export async function keysAtBeats(page: Page, beats: readonly number[], options: { deck?: DeckId; codes?: readonly string[] } = {}): Promise<void> {
  await page.evaluate(
    async ({ targets, deck, codes }) => {
      const lesson = (window as LessonWindow).learnToDjLesson;
      if (lesson === undefined) throw new Error("No Lesson is open.");
      const beatMs = 60_000 / lesson.track.grid.bpm;
      /**
       * performance.now() of `beat`, from the deck's playhead at the heard time of a moment just taken,
       * placed as a key press at that moment would be (not the playhead of "now", which never steps back
       * when the output timestamp does).
       */
      const beatAtMs = (beat: number) => {
        const now = performance.now();
        const heard = lesson.engine.heardTime(now);
        const reading = heard.ok && heard.ctx !== undefined ? lesson.engine.playheadAt(deck, heard.ctx) : null;
        if (reading?.beat == null) throw new Error(`Deck ${deck} has no playhead reading.`);
        return now + (beat - reading.beat) * beatMs;
      };
      const stamped = (type: "keydown" | "keyup", code: string, timeStamp: number) => {
        const event = new KeyboardEvent(type, { code });
        Object.defineProperty(event, "timeStamp", { value: timeStamp });
        return event;
      };
      for (const beat of targets) {
        // Re-read the heard playhead after every wait: the audio clock may drift from performance.now().
        let atMs = beatAtMs(beat);
        for (let remainingMs = atMs - performance.now(); remainingMs > 0.5; remainingMs = atMs - performance.now()) {
          if (remainingMs > 12) await new Promise((resolve) => setTimeout(resolve, remainingMs - 8));
          atMs = beatAtMs(beat);
        }
        for (const code of codes) window.dispatchEvent(stamped("keydown", code, atMs));
        for (const code of codes) window.dispatchEvent(stamped("keyup", code, atMs));
      }
    },
    { targets: beats, deck: options.deck ?? "A", codes: options.codes ?? ["Space"] },
  );
}

/**
 * Sends engine commands on beats of a deck's heard playhead (a knob turn or fader move a test cannot
 * drag in time), timed in the page like `keysAtBeats`. Each command must be accepted.
 */
export async function commandsAtBeats(page: Page, timed: readonly { readonly beat: number; readonly command: Record<string, unknown> }[], options: { deck?: DeckId } = {}): Promise<void> {
  const refused = await page.evaluate(
    async ({ items, deck }) => {
      const lesson = (window as LessonWindow).learnToDjLesson;
      if (lesson === undefined) throw new Error("No Lesson is open.");
      const grid = lesson.deckTrack(deck)?.grid ?? lesson.track.grid;
      const beatMs = 60_000 / grid.bpm;
      const heardBeat = () => {
        const reading = lesson.engine.playhead(deck);
        if (!reading.ok || reading.beat == null) throw new Error(`Deck ${deck} has no playhead reading.`);
        return reading.beat;
      };
      const failures: string[] = [];
      for (const { beat, command } of items) {
        for (let remainingMs = (beat - heardBeat()) * beatMs; remainingMs > 0.5; remainingMs = (beat - heardBeat()) * beatMs) {
          if (remainingMs > 12) await new Promise((resolve) => setTimeout(resolve, remainingMs - 8));
        }
        if (!lesson.engine.command(command, { device: "trackpad" }).ok) failures.push(JSON.stringify(command));
      }
      return failures;
    },
    { items: timed, deck: options.deck ?? "A" },
  );
  expect(refused, "commands the engine refused").toEqual([]);
}

/** Taps Space on each beat of deck A's grid. */
export async function tapAtBeats(page: Page, beats: readonly number[]): Promise<void> {
  await keysAtBeats(page, beats);
}

/** Waits until the Lesson is in `phase` and a deck's heard playhead is past `beat`, but not `before`. */
export async function playingPast(page: Page, phase: string, beat: number, options: { before?: number; deck?: DeckId } = {}): Promise<void> {
  const before = options.before ?? Number.POSITIVE_INFINITY;
  await page.waitForFunction(
    ({ expected, past, until, on }) => {
      const lesson = (window as LessonWindow).learnToDjLesson;
      const reading = lesson?.engine.playhead(on);
      const heard = reading?.beat ?? 0;
      return lesson?.phase() === expected && reading?.ok === true && heard > past && heard < until;
    },
    // Infinity does not survive the trip into the page.
    { expected: phase, past: beat, until: Number.isFinite(before) ? before : Number.MAX_VALUE, on: options.deck ?? "A" },
    // A fixed interval, not animation frames: those are throttled in a busy or hidden headless page.
    { timeout: 60_000, polling: 20 },
  );
}

/**
 * Waits until the Check is running and a deck's heard playhead has moved just past `beat`. Bounded
 * above: for the output latency after the Check's cue, what is heard is still the hook's loop further on.
 */
export async function checkPlayingPast(page: Page, beat: number, deck: DeckId = "A"): Promise<void> {
  await playingPast(page, "check", beat, { before: beat + 2, deck });
}

export const caption = (page: Page) => page.getByRole("status", { name: "Lesson caption" });
export const resultCard = (page: Page) => page.getByRole("region", { name: "Result" });
