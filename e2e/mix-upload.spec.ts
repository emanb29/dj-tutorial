import { expect, test, type Page } from "@playwright/test";
import { ensureProfile, learner, resultCard } from "./lesson-support.ts";

// "Grade a mix you recorded" (ISS-96) end to end, on a phone-width screen (360 px): from the Lesson
// list, upload a tiny synthetic mix (two tracks, a cut on the phrase at 30 s; never played), see the
// result card, and find it saved in the profile as outside practice. Without the model file the worker
// grades with the dj-core fallback, as in CI.

const RATE = 22_050;
const BPM = 128;
const BEAT = 60 / BPM;

/** A 16-bit mono WAV: track A (kick, off-beat bass on C#2, A minor pad) for 64 beats, then a cut to track B (bass on F#2, F# major). */
function tinyMixWav(): Buffer {
  const beats = 64;
  const samples = new Float32Array(Math.round((2 * beats * BEAT + 0.5) * RATE));
  let seed = 3;
  const noise = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed / 2147483647) * 2 - 1;
  };
  const add = (at: number, value: number) => {
    if (at >= 0 && at < samples.length) samples[at] = (samples[at] ?? 0) + value;
  };
  const track = (startSec: number, bassHz: number, pad: readonly number[]) => {
    for (let n = 0; n < beats; n++) {
      const beat = Math.round((startSec + n * BEAT) * RATE);
      let phase = 0;
      for (let i = 0; i < 0.3 * RATE; i++) {
        phase += (2 * Math.PI * (48 + 110 * Math.exp(-i / RATE / 0.03))) / RATE;
        add(beat + i, 0.32 * Math.min(1, i / 32) * Math.sin(phase) * Math.exp(-i / RATE / 0.16));
      }
      for (let i = 0; i < 0.003 * RATE; i++) add(beat + i, 0.13 * noise());
      const offBeat = beat + Math.round((BEAT / 2) * RATE);
      for (let i = 0; i < 1500; i++) add(offBeat + i, 0.08 * noise() * Math.exp(-i / 300));
      for (let i = 0; i < 0.45 * BEAT * RATE; i++) add(offBeat + i, 0.22 * Math.sin((2 * Math.PI * bassHz * i) / RATE) * Math.exp(-i / RATE / 0.18) * Math.min(1, i / 64));
    }
    const from = Math.round(startSec * RATE);
    for (let i = from; i < from + beats * BEAT * RATE && i < samples.length; i++) {
      const t = (i - from) / RATE;
      add(i, 0.029 * (0.75 + 0.25 * Math.cos((2 * Math.PI * t) / BEAT)) * pad.reduce((sum, hz) => sum + Math.sin(2 * Math.PI * hz * t), 0));
    }
  };
  track(0, 69.3, [220, 261.63, 329.63]);
  track(beats * BEAT, 92.5, [185, 233.08, 277.18]);
  const wav = Buffer.alloc(44 + samples.length * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + samples.length * 2, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(RATE, 24);
  wav.writeUInt32LE(RATE * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((x, i) => wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x)) * 32767), 44 + i * 2));
  return wav;
}

/** No sideways scrolling: the page fits the phone's width. */
async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, screen: window.innerWidth }));
  expect(widths.page).toBeLessThanOrEqual(widths.screen);
}

test.use({ viewport: { width: 360, height: 740 } });

test("a recorded mix is graded on the result card and kept as outside practice", async ({ page }) => {
  test.setTimeout(240_000);
  const id = learner("mix");
  await ensureProfile(page, id);
  await page.goto(`/?learner=${id}`);
  await page.getByRole("button", { name: "Grade a mix you recorded" }).click();
  await expect(page.getByRole("heading", { name: "Grade a mix you recorded" })).toBeVisible();
  await expectNoSidewaysScroll(page);

  await page.locator('input[type="file"]').setInputFiles({ name: "my-mix.wav", mimeType: "audio/wav", buffer: tinyMixWav() });
  const card = resultCard(page);
  await expect(card).toBeVisible({ timeout: 180_000 });
  await expect(card).toHaveAttribute("data-outcome", "passed");
  await expect(card.getByRole("heading", { name: /Clean mix/ })).toBeVisible();
  await expect(card.getByRole("list", { name: "Transitions" }).getByRole("heading")).toHaveText(["1. Cut at 0:30"]);
  await expect(card.getByText("Came in on the phrase")).toBeVisible();
  await expect(card.getByText("Saved as outside practice")).toBeVisible();
  await expect(card.getByLabel("Coach")).not.toHaveText(/^\s*$/);
  await expectNoSidewaysScroll(page);

  await expect
    .poll(
      () =>
        page.evaluate(async (learnerId) => {
          const response = await fetch(`/api/learners/${learnerId}/profile`);
          const body = (await response.json()) as { data?: { outsidePractice?: { transitions: number; clean: boolean }[] } };
          return body.data?.outsidePractice ?? [];
        }, id),
      { timeout: 15_000 },
    )
    .toEqual([expect.objectContaining({ transitions: 1, clean: true })]);
});

test("a file that is not audio is refused, with what to pick instead", async ({ page }) => {
  const id = learner("mix-text");
  await ensureProfile(page, id);
  await page.goto(`/mix?learner=${id}`);
  await page.locator('input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not a mix") });
  await expect(page.getByRole("alert")).toHaveText(/isn't an audio file/);
  await expect(page.getByText("Pick another")).toBeVisible();
});
