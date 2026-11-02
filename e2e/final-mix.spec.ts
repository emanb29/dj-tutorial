import { devices, expect, test, type Page } from "@playwright/test";
import { commandsAtBeats, keysAtBeats, learner, playingPast, resultCard, seedPassed, type LessonWindow } from "./lesson-support.ts";

// Lesson 20 end to end, muted, on the synthetic set grooves (?track=synthetic): every track has its
// first beat at 0 s and bar 1 on beat 0; the main section (kick, hat, bass, pad) runs from bar 9 to 48.
// A three-track set to a pass: a cut from track 1 (123 BPM) to track 2 (124), then track 3 (124)
// loaded onto the free deck, beatmatched in the headphones with the jog, and blended in over 8 bars.
// Keys stand in for the Learner's presses, engine commands for drags; the master is recorded and kept.

const ROUTE = ["deck-basics", "beats-and-bars", "phrases", "gain-staging", "headphone-cue", "cue-point", "cut-on-phrase", "tempo-fader", "sync-blend", "eq-basics", "bass-swap", "nudge-phase", "tempo-by-ear", "blend-by-ear"];
const T1 = "Set Groove C (synthetic)";
const T2 = "Set Groove Am (synthetic)";
const T3 = "Set Groove Em (synthetic)";
/** Track seconds of bar 9 (beat 32) at `bpm`. */
const bar9 = (bpm: number) => (32 * 60) / bpm;

async function command(page: Page, sent: Record<string, unknown>): Promise<void> {
  const ok = await page.evaluate((payload) => (window as LessonWindow).djTutorialLesson?.engine.command(payload, { device: "trackpad" }).ok, sent);
  expect(ok, JSON.stringify(sent)).toBe(true);
}

/** Cues a paused deck: jog search to `pos`, then deck CUE (sets the cue point there). */
async function cueAt(page: Page, deck: "A" | "B", pos: number): Promise<void> {
  await command(page, { control: "seek", deck, value: pos });
  await command(page, { control: "deck-cue", deck, value: true });
  await command(page, { control: "deck-cue", deck, value: false });
}

/** Nudges deck A into phase with deck B with the jog wheel, by ear as it were: read, bend, release. */
async function nudgeIntoPhase(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const lesson = (window as LessonWindow).djTutorialLesson;
    if (lesson === undefined) throw new Error("No set is open.");
    const beatMs = 60_000 / 124;
    const errorMs = () => {
      const a = lesson.engine.playhead("A");
      const b = lesson.engine.playhead("B");
      if (a.beat == null || b.beat == null) throw new Error("Both decks must be playing.");
      const difference = a.beat - b.beat;
      return (difference - Math.round(difference)) * beatMs;
    };
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const error = errorMs();
      if (Math.abs(error) < 3) return error;
      const bend = error > 0 ? -0.05 : 0.05;
      lesson.engine.command({ control: "jog-bend", deck: "A", value: bend }, { device: "trackpad" });
      await sleep(Math.abs(error) / 0.05);
      lesson.engine.command({ control: "jog-bend", deck: "A", value: 0 }, { device: "trackpad" });
      await sleep(150);
    }
    return errorMs();
  });
}

/** A channel-fader blend from B to A over `bars`, timed on deck B's beats: A's amplitude rises as B's falls. */
function blendToA(fromBeat: number, bars: number): { beat: number; command: Record<string, unknown> }[] {
  const steps = Math.round((bars * 4) / 0.4);
  return Array.from({ length: steps + 1 }, (_, step) => {
    const share = step / steps;
    const beat = fromBeat + share * bars * 4;
    return [
      { beat, command: { control: "channel-fader", deck: "A", value: Math.sqrt(share) } },
      { beat, command: { control: "channel-fader", deck: "B", value: Math.sqrt(1 - share) } },
    ];
  }).flat();
}

test("final-mix: a three-track set with a cut and a blend, by ear, passes, and the recording is kept as the final project", async ({ page }) => {
  test.setTimeout(240_000);
  const learnerId = learner("finalmix");
  await seedPassed(page, learnerId, ROUTE, { headphones: true });
  await page.goto(`/?learner=${learnerId}&track=synthetic`);
  await page.locator('li[data-lesson="final-mix"]').getByRole("button").click();

  // The set builder: three grooves of one genre; the fourth (120 BPM, 2.4% off) would warn about its tempo.
  const builder = page.getByRole("region", { name: "Your set" });
  for (const title of [T1, T2, T3]) await page.getByRole("button", { name: `Add ${title}` }).click();
  await expect(builder.locator("li[data-track]")).toHaveCount(3);
  await expect(page.getByRole("list", { name: "Warnings" })).toHaveCount(0);
  await page.getByRole("button", { name: "Add Set Groove G (synthetic)" }).click();
  await expect(page.getByRole("list", { name: "Warnings" })).toContainText("the Check allows 2%");
  await page.getByRole("button", { name: "Remove Set Groove G (synthetic)" }).click();
  await page.getByRole("button", { name: "Load the set" }).click();

  // The warm-up: cue both tracks on bar 9 (nothing counts yet), then start the set.
  await expect(page.locator("main.final-mix")).toHaveAttribute("data-phase", "warm-up");
  await expect(page.getByTestId("graded-line")).toContainText("Graded: 3 tracks, 16 bars each · one genre · tempos within 2% · a blend and a cut");
  await expect(page.getByTestId("graded-line")).toContainText("no drift");
  await page.waitForFunction(() => (window as LessonWindow).djTutorialLesson?.deckTrack("B") != null);
  // The exam covers the BPM displays and the phase meter.
  await expect(page.locator('[data-control="A.bpm"] .readout-number')).toBeHidden();
  // SYNC withheld (BEAT SYNC B stays open for Master Tempo, held).
  await expect(page.locator('[data-control="B.sync"]')).toHaveAttribute("data-own-locked", "true");
  await cueAt(page, "A", bar9(123));
  await cueAt(page, "B", bar9(124));
  await page.getByRole("button", { name: "Start the set" }).click();
  await expect(page.locator("main.final-mix")).toHaveAttribute("data-phase", "set");

  // Track 1 from bar 9; CUE B on, fader B up while B is paused; the cut on track 1's bar 25 (beat 96).
  await page.keyboard.press("KeyX");
  await page.getByRole("button", { name: "Channel B headphone cue" }).click();
  await page.keyboard.press("KeyO");
  await keysAtBeats(page, [96], { codes: ["Comma", "KeyS"] });

  // Deck A is free: load track 3, cue it on bar 1, start it in the headphones on track 2's bar 17
  // (beat 64), beatmatch, and blend from track 2's bar 25 (beat 96), when track 3 is at its bar 9.
  const load = page.getByRole("button", { name: `Load "${T3}" onto deck A` });
  await expect(load).toBeEnabled();
  await load.click();
  await page.waitForFunction(() => (window as LessonWindow).djTutorialLesson?.deckTrack("A")?.trackId === "synthetic/set-124e" && !document.body.innerText.includes("Loading…"));
  await command(page, { control: "seek", deck: "A", value: 0 });
  await page.getByRole("button", { name: "Channel A headphone cue" }).click();
  await keysAtBeats(page, [64], { deck: "B", codes: ["KeyX"] });
  const phaseMs = await nudgeIntoPhase(page);
  expect(Math.abs(phaseMs), "phase error after nudging").toBeLessThan(5);
  await commandsAtBeats(page, blendToA(96, 8), { deck: "B" });

  // Track 3 plays on to its bar 26 (16 bars on the master), then the set ends.
  await playingPast(page, "set", 102, { deck: "A" });
  await page.getByRole("button", { name: "End set" }).click();

  const card = resultCard(page);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card, await card.innerText()).toHaveAttribute("data-outcome", "passed");
  await expect(card).toContainText("Rehearsal: passed");
  await expect(card).toContainText("Blends: 1, cuts: 1");
  await expect(card).toContainText("Tracks played 16 bars or more: 3");
  await expect(card.getByRole("table", { name: "Transitions" }).locator("tbody tr")).toHaveCount(2);
  await expect(card.getByRole("table", { name: "Transitions" }).locator('tr[data-met="false"]')).toHaveCount(0);

  // The recording: a download with its notes, then kept on the server with the track list.
  const download = card.getByRole("link", { name: "Download the mix" });
  await expect(download).toHaveAttribute("download", /^dj-tutorial-set-\d{4}-\d{2}-\d{2}\.(webm|m4a|ogg)$/);
  await expect(card.getByRole("link", { name: "Download the track list" })).toBeVisible();
  await card.getByRole("button", { name: "Keep as my final project" }).click();
  await expect(card.getByRole("button", { name: "Kept as your final project" })).toBeVisible();
  const kept = await page.evaluate(async (id) => {
    const audio = await fetch(`/api/learners/${id}/final-project/audio`);
    const bytes = (await audio.arrayBuffer()).byteLength;
    // The profile save runs in the background, one at a time: wait for it.
    for (let tries = 0; tries < 50; tries += 1) {
      const profile = (await (await fetch(`/api/learners/${id}/profile`)).json()) as { data: { finalProject?: { tracks: unknown[]; transitions: unknown[]; outcome: string } } };
      if (profile.data.finalProject !== undefined) return { status: audio.status, bytes, project: profile.data.finalProject };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { status: audio.status, bytes, project: null };
  }, learnerId);
  expect(kept.status).toBe(200);
  expect(kept.bytes).toBeGreaterThan(10_000);
  expect(kept.project).toMatchObject({ outcome: "passed", tracks: [{}, {}, {}], transitions: [{ kind: "cut" }, { kind: "blend" }] });

  // The files to post: WAV and MP3 from the server's ffmpeg (or the reason there are none).
  const ffmpeg = (await (await page.request.get("/api/final-project/export-status")).json()) as { data: { available: boolean } };
  if (!ffmpeg.data.available) {
    await expect(card.getByRole("note")).toContainText("No WAV or MP3 download");
    return;
  }
  await expect(card).toContainText("upload the WAV for best quality, or the MP3");
  await expect(card.getByRole("link", { name: "Download as WAV" })).toHaveAttribute("download", /^dj-tutorial-set-\d{4}-\d{2}-\d{2}\.wav$/);
  const mp3Link = card.getByRole("link", { name: "Download as MP3" });
  const mp3 = await page.request.get((await mp3Link.getAttribute("href")) ?? "");
  expect(mp3.status()).toBe(200);
  expect(mp3.headers()["content-type"]).toBe("audio/mpeg");
  expect((await mp3.body()).subarray(0, 3).toString("latin1")).toBe("ID3");
});

test.describe("on a phone", () => {
  test.use({ userAgent: devices["Pixel 7"].userAgent, isMobile: true, hasTouch: true, deviceScaleFactor: 1, viewport: { width: 412, height: 915 } });

  test("a kept final project offers its WAV and MP3 downloads, fitting the width", async ({ page }) => {
    const learnerId = learner("e2e-set-phone");
    await seedPassed(page, learnerId, ROUTE, { headphones: true });
    const statuses = await page.evaluate(async (id) => {
      const audio = await fetch(`/api/learners/${id}/final-project/audio`, { method: "PUT", headers: { "Content-Type": "audio/webm" }, body: new Uint8Array(64) });
      const record = ((await (await fetch(`/api/learners/${id}/profile`)).json()) as { data: Record<string, unknown> }).data;
      const finalProject = {
        attemptId: "phone-1",
        recordedAt: "2026-10-17T20:00:00.000Z",
        mode: "lesson",
        outcome: "passed",
        band: "pass",
        durationSec: 60,
        audio: { mimeType: "audio/webm", bytes: 64 },
        tracks: [{ title: "Set Groove C (synthetic)", artist: "DJ Tutorial", bpm: 123, credit: "", shareable: true }],
        transitions: [],
      };
      const profile = await fetch(`/api/learners/${id}/profile`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...record, finalProject }) });
      return [audio.status, profile.status];
    }, learnerId);
    expect(statuses).toEqual([200, 200]);
    await page.goto(`/?learner=${learnerId}&track=synthetic`);
    await page.locator('li[data-lesson="final-mix"]').getByRole("button").tap();
    const kept = page.getByRole("region", { name: "Your final project" });
    await expect(kept).toBeVisible();
    const ffmpeg = (await (await page.request.get("/api/final-project/export-status")).json()) as { data: { available: boolean } };
    if (ffmpeg.data.available) {
      for (const name of ["Download as WAV", "Download as MP3"]) {
        const box = await kept.getByRole("link", { name }).boundingBox();
        expect(box?.height ?? 0, name).toBeGreaterThanOrEqual(44);
      }
      await expect(kept.getByRole("link", { name: "Download as MP3" })).toHaveAttribute("download", "dj-tutorial-set-2026-10-17.mp3");
    } else {
      await expect(kept.getByRole("note")).toContainText("No WAV or MP3 download");
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  });
});
