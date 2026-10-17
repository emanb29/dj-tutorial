import { describe, expect, it } from "vitest";
import { decoderAt } from "./load-audio.ts";
import { createLocalFileSource, indexedDbHandleStore, memoryHandleStore, type DirectoryHandleLike } from "./local-files.ts";

// Decodes a real file through the browser's decoder (an OfflineAudioContext: nothing is played,
// and the browser runs with --mute-audio anyway).

const SAMPLE_RATE = 8_000;

/** A 16-bit mono PCM WAV of a 440 Hz sine at half scale. */
function sineWav(seconds: number): Uint8Array<ArrayBuffer> {
  const frames = Math.round(SAMPLE_RATE * seconds);
  const view = new DataView(new ArrayBuffer(44 + frames * 2));
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + frames * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, frames * 2, true);
  for (let frame = 0; frame < frames; frame += 1) {
    view.setInt16(44 + frame * 2, Math.round(0.5 * 32_767 * Math.sin((2 * Math.PI * 440 * frame) / SAMPLE_RATE)), true);
  }
  return new Uint8Array(view.buffer);
}

describe("local file source in the browser", () => {
  it("decodes a generated WAV picked from a file input and keys its analysis cache", async () => {
    const source = createLocalFileSource({ handleStore: memoryHandleStore(), showDirectoryPicker: null });
    const wav = new File([sineWav(0.25)], "Test Artist - Tiny Tone.wav", { type: "audio/wav" });
    const [track] = source.addFiles([wav]);
    if (track === undefined) throw new Error("the WAV was not added");
    const fractions: number[] = [];

    const loaded = await source.load(track, { onProgress: ({ fraction }) => fractions.push(fraction) });

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.audio.duration).toBeCloseTo(0.25, 2);
    const samples = loaded.value.audio.getChannelData(0);
    const peak = samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
    expect(peak).toBeGreaterThan(0.45);
    expect(peak).toBeLessThan(0.55);
    expect(loaded.value.track).toMatchObject({ title: "Tiny Tone", artist: "Test Artist", durationSec: loaded.value.audio.duration });
    expect(loaded.value.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.value.track.analysisCacheKey).toBe(loaded.value.contentHash);
    expect(fractions.at(-1)).toBe(1);
  });

  it("decodes at the engine's rate so a 48 kHz engine accepts the track (a Mac's usual rate)", async () => {
    const { createAudioEngine } = await import("@audio");
    const engine = await createAudioEngine({ context: new OfflineAudioContext(2, 48_000, 48_000), masterTempo: false });
    const source = createLocalFileSource({ handleStore: memoryHandleStore(), showDirectoryPicker: null, decode: decoderAt(48_000) });
    const [track] = source.addFiles([new File([sineWav(0.25)], "Test Artist - Tiny Tone.wav", { type: "audio/wav" })]);
    if (track === undefined) throw new Error("the WAV was not added");

    const loaded = await source.load(track);
    if (!loaded.ok) throw new Error(loaded.error.message);
    expect(loaded.value.audio.sampleRate).toBe(48_000);
    const onDeck = await engine.load("A", loaded.value.audio, { trackId: "tiny-tone", grid: { bpm: 120, firstBeat: 0, downbeatIndex: 0, rmsResidualMs: 1 } });

    expect(onDeck).toEqual({ ok: true });
  });

  it("returns decode-failed for a file that is not really audio", async () => {
    const source = createLocalFileSource({ handleStore: memoryHandleStore(), showDirectoryPicker: null });
    const [track] = source.addFiles([new File(["not audio at all"], "fake.mp3", { type: "audio/mpeg" })]);
    if (track === undefined) throw new Error("not added");

    expect(await source.load(track)).toMatchObject({ ok: false, error: { kind: "decode-failed" } });
  });

  it("remembers a folder handle in IndexedDB across store instances", async () => {
    // A real FileSystemDirectoryHandle needs a user gesture; any structured-cloneable value takes the same path.
    const handle = { kind: "directory", name: "Music" } as unknown as DirectoryHandleLike;
    await indexedDbHandleStore().put(handle);

    expect(await indexedDbHandleStore().get()).toEqual(handle);
    await indexedDbHandleStore().clear();
    expect(await indexedDbHandleStore().get()).toBeNull();
  });
});
