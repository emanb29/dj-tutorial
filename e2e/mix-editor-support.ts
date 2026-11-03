import { expect, type Page } from "@playwright/test";

// A music folder for the Mix Editor, in memory: short synthetic grooves (a kick on every beat and a
// held tone), made as WAV files in the page, with a hand-written rekordbox.xml giving their grids.
// Nothing is real music and nothing touches a disk folder. Every name here is invented.

export interface Groove {
  readonly artist: string;
  readonly title: string;
  readonly bpm: number;
  readonly seconds: number;
  /** The held tone, Hz: tells the tracks apart by ear. */
  readonly toneHz: number;
  readonly genre: string;
  readonly key: string;
}

export const GROOVES: readonly Groove[] = [
  { artist: "Mira Vale", title: "Copper Tide", bpm: 120, seconds: 64, toneHz: 220, genre: "Deep House", key: "Am" },
  { artist: "Otto Fenn", title: "Glass Orchard", bpm: 120, seconds: 64, toneHz: 262, genre: "Deep House", key: "C" },
  { artist: "Juno Reyes-Park", title: "Low Lanterns", bpm: 120, seconds: 64, toneHz: 196, genre: "Techno", key: "G" },
];

const fileName = (groove: Groove) => `${groove.artist} - ${groove.title}.wav`;

function rekordboxXml(grooves: readonly Groove[]): string {
  const tracks = grooves
    .map(
      (groove) =>
        `<TRACK Name="${groove.title}" Artist="${groove.artist}" Genre="${groove.genre}" AverageBpm="${groove.bpm.toFixed(2)}" Tonality="${groove.key}" TotalTime="${String(groove.seconds)}" Location="file://localhost/Users/dj/Music/${encodeURIComponent(fileName(groove))}"><TEMPO Inizio="0.000" Bpm="${groove.bpm.toFixed(2)}" Metro="4/4" Battito="1"/></TRACK>`,
    )
    .join("\n    ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="7.0.0" Company="AlphaTheta"/>
  <COLLECTION Entries="${String(grooves.length)}">
    ${tracks}
  </COLLECTION>
</DJ_PLAYLISTS>`;
}

/** Replaces the folder picker with an in-memory folder named "Music" holding `grooves` and their rekordbox.xml. */
export async function stubGrooveFolder(page: Page, grooves: readonly Groove[] = GROOVES): Promise<void> {
  const files = grooves.map((groove) => ({ name: fileName(groove), bpm: groove.bpm, seconds: groove.seconds, toneHz: groove.toneHz }));
  await page.addInitScript(
    ({ wavs, xml }) => {
      const RATE = 22_050;
      /** A 16-bit mono WAV: a decaying kick on every beat and a quiet held tone. */
      const wav = (bpm: number, seconds: number, toneHz: number): Uint8Array<ArrayBuffer> => {
        const count = Math.round(seconds * RATE);
        const bytes = new Uint8Array(44 + count * 2);
        const view = new DataView(bytes.buffer);
        const text = (at: number, value: string) => {
          for (let index = 0; index < value.length; index += 1) view.setUint8(at + index, value.charCodeAt(index));
        };
        text(0, "RIFF");
        view.setUint32(4, 36 + count * 2, true);
        text(8, "WAVE");
        text(12, "fmt ");
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, RATE, true);
        view.setUint32(28, RATE * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        text(36, "data");
        view.setUint32(40, count * 2, true);
        const beat = 60 / bpm;
        for (let index = 0; index < count; index += 1) {
          const time = index / RATE;
          const sinceBeat = time % beat;
          const kick = sinceBeat < 0.15 ? Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-sinceBeat * 40)) * sinceBeat) * Math.exp(-sinceBeat * 22) : 0;
          const sample = Math.max(-1, Math.min(1, 0.85 * kick + 0.12 * Math.sin(2 * Math.PI * toneHz * time)));
          view.setInt16(44 + index * 2, Math.round(sample * 32_767), true);
        }
        return bytes;
      };
      const made = new Map<string, Uint8Array<ArrayBuffer>>();
      const entries = [
        ...wavs.map((each, index) => ({ name: each.name, lastModified: 1_700_000_000_000 + index * 1000, bytes: () => {
          const known = made.get(each.name);
          if (known !== undefined) return known;
          const bytes = wav(each.bpm, each.seconds, each.toneHz);
          made.set(each.name, bytes);
          return bytes;
        } })),
        { name: "rekordbox.xml", lastModified: 1_700_000_100_000, bytes: () => new TextEncoder().encode(xml) },
      ];
      const root = {
        kind: "directory",
        name: "Music",
        async *values() {
          for (const entry of entries) {
            yield await Promise.resolve({ kind: "file", name: entry.name, getFile: () => Promise.resolve(new File([entry.bytes()], entry.name, { lastModified: entry.lastModified })) });
          }
        },
        queryPermission: () => Promise.resolve("granted"),
        requestPermission: () => Promise.resolve("granted"),
      };
      Object.assign(window, { showDirectoryPicker: () => Promise.resolve(root) });
    },
    { wavs: files, xml: rekordboxXml(grooves) },
  );
}

/** Picks the in-memory folder on the Controller page and waits for rekordbox to match every groove. */
export async function pickGrooveFolder(page: Page, grooves: readonly Groove[] = GROOVES): Promise<void> {
  await page.getByRole("link", { name: "Controller" }).click();
  const setting = page.getByRole("region", { name: "Music folder" });
  await setting.getByRole("button", { name: "Pick a folder" }).click();
  await expect(setting.getByTestId("rekordbox-status")).toHaveText(`rekordbox: matched ${String(grooves.length)} of ${String(grooves.length)}`);
  await page.getByRole("button", { name: /Lessons/ }).click();
}

export const libraryTracks = (page: Page) => page.getByRole("region", { name: "Library browser" }).getByRole("list", { name: "Tracks" }).getByRole("listitem");
