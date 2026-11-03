import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { ensureProfile, learner } from "./lesson-support.ts";

// The music folder setting end to end, muted. window.showDirectoryPicker is replaced (init script)
// by an in-memory folder the test can add files to and remove files from, so no real music and no
// real disk folder are involved. Where the browser has no picker (Android Chrome), a folder input
// imports a generated folder once.

interface MemoryFolderWindow {
  memoryFolder: { write(path: string, text: string): void; remove(path: string): void };
}

/** Replaces the folder picker with an in-memory folder named "Music". */
async function stubPicker(page: Page, files: Readonly<Record<string, string>>): Promise<void> {
  await page.addInitScript((initial: Record<string, string>) => {
    interface Node {
      folders: Map<string, Node>;
      files: Map<string, { text: string; lastModified: number }>;
    }
    const empty = (): Node => ({ folders: new Map(), files: new Map() });
    const root = empty();
    const place = (path: string, create: boolean) => {
      const parts = path.split("/");
      const leaf = parts.pop() ?? "";
      let node: Node | undefined = root;
      for (const part of parts) {
        let next: Node | undefined = node.folders.get(part);
        if (next === undefined && create) {
          next = empty();
          node.folders.set(part, next);
        }
        if (next === undefined) return null;
        node = next;
      }
      return { node, leaf };
    };
    let clock = 1_700_000_000_000;
    const write = (path: string, text: string) => {
      const at = place(path, true);
      clock += 1000;
      at?.node.files.set(at.leaf, { text, lastModified: clock });
    };
    const handle = (name: string, node: Node): object => ({
      kind: "directory",
      name,
      async *values() {
        for (const [child, folder] of node.folders) yield await Promise.resolve(handle(child, folder));
        for (const [fileName, entry] of node.files) {
          yield await Promise.resolve({
            kind: "file",
            name: fileName,
            getFile: () => Promise.resolve(new File([entry.text], fileName, { lastModified: entry.lastModified })),
          });
        }
      },
      queryPermission: () => Promise.resolve("granted"),
      requestPermission: () => Promise.resolve("granted"),
    });
    for (const [path, text] of Object.entries(initial)) write(path, text);
    Object.assign(window, {
      memoryFolder: {
        write,
        remove: (path: string) => {
          const at = place(path, false);
          at?.node.files.delete(at.leaf);
        },
      },
      showDirectoryPicker: () => Promise.resolve(handle("Music", root)),
    });
  }, files);
}

const folderPanel = (page: Page) => page.getByTestId("music-folder");

test("pick a music folder: its tracks fill Freestyle's library, and a rescan finds a new file and drops a removed one", async ({ page }) => {
  test.setTimeout(120_000);
  const id = learner("music-folder");
  await stubPicker(page, { "Kay Grove - Brothers.mp3": "not music", "House/Deep Loop.wav": "not music", "cover.jpg": "x" });
  await ensureProfile(page, id);

  // The setting, on the Controller page.
  await page.goto(`/controller?learner=${id}`);
  const setting = page.getByRole("region", { name: "Music folder" });
  await expect(setting).toContainText("Pick your music folder");
  await setting.getByRole("button", { name: "Pick a folder" }).click();
  await expect(setting.getByRole("status")).toContainText("“Music”: 2 tracks");
  await expect(setting).toContainText(/New tracks show up by themselves|Checks for new tracks every 30 s/);

  // Freestyle lists them next to the synthetic grooves.
  await page.goto(`/?learner=${id}&track=synthetic`);
  await page.getByRole("button", { name: "Freestyle" }).click();
  await expect(page.locator("main.freestyle")).toHaveAttribute("data-phase", "ready");
  const library = page.getByRole("region", { name: "Library" });
  // A reload forgets an in-memory folder (IndexedDB cannot keep it): pick it again here.
  await library.getByRole("button", { name: "Pick a folder" }).click();
  await expect(library.getByRole("listitem", { name: "Brothers" })).toBeVisible();
  await expect(library.getByRole("listitem", { name: "Deep Loop" })).toBeVisible();
  await expect(library.getByRole("listitem", { name: "Set Groove C (synthetic)" })).toBeVisible();

  // A new file shows up after a rescan; a removed one drops out.
  await page.evaluate(() => {
    const { memoryFolder } = window as unknown as MemoryFolderWindow;
    memoryFolder.write("Fresh - New Track.mp3", "not music");
    memoryFolder.remove("House/Deep Loop.wav");
  });
  await library.getByRole("button", { name: "Rescan now" }).click();
  await expect(library.getByRole("listitem", { name: "New Track" })).toBeVisible();
  await expect(library.getByRole("listitem", { name: "Deep Loop" })).toHaveCount(0);
  await expect(folderPanel(page).getByRole("status")).toContainText("2 tracks");

  // Files that will not decode are counted, not a crash (the background pass runs while no deck plays).
  await expect(folderPanel(page).getByRole("status")).toContainText("2 with no BPM", { timeout: 60_000 });
});

// A hand-written rekordbox collection (File → Export Collection in xml format): one track the
// stubbed folder has, one it does not. rekordbox's BPM (123.50) is not one the app would guess.
const REKORDBOX_XML = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="7.0.0" Company="AlphaTheta"/>
  <COLLECTION Entries="2">
    <TRACK TrackID="1" Name="Brothers (Club Mix)" Artist="Kay Grove" Genre="Deep House" AverageBpm="123.50" Tonality="Am" Rating="204"
      Location="file://localhost/Users/dj/Music/House/Kay%20Grove%20-%20Brothers.mp3">
      <TEMPO Inizio="0.120" Bpm="123.50" Metro="4/4" Battito="1"/>
      <POSITION_MARK Name="Drop" Type="0" Start="30.0" Num="0"/>
    </TRACK>
    <TRACK TrackID="2" Name="Not here" Location="file://localhost/Users/dj/Desktop/elsewhere.mp3"/>
  </COLLECTION>
</DJ_PLAYLISTS>`;

test("a rekordbox.xml in the music folder: the card says how many tracks it matched, and Freestyle lists rekordbox's BPM and key", async ({ page }) => {
  test.setTimeout(120_000);
  const id = learner("music-rekordbox");
  await stubPicker(page, { "House/Kay Grove - Brothers.mp3": "not music", "Other - Track.mp3": "not music", "rekordbox.xml": REKORDBOX_XML });
  await ensureProfile(page, id);

  await page.goto(`/controller?learner=${id}`);
  const setting = page.getByRole("region", { name: "Music folder" });
  await expect(setting.getByRole("button", { name: "Use rekordbox.xml" })).toBeVisible();
  await expect(setting).toContainText("Export Collection in xml format");
  await setting.getByRole("button", { name: "Pick a folder" }).click();
  await expect(setting.getByRole("status")).toContainText("“Music”: 2 tracks");
  await expect(setting.getByTestId("rekordbox-status")).toHaveText("rekordbox: matched 1 of 2");

  await page.goto(`/?learner=${id}&track=synthetic`);
  await page.getByRole("button", { name: "Freestyle" }).click();
  await expect(page.locator("main.freestyle")).toHaveAttribute("data-phase", "ready");
  const library = page.getByRole("region", { name: "Library" });
  await library.getByRole("button", { name: "Pick a folder" }).click();
  const brothers = library.getByRole("listitem", { name: "Brothers (Club Mix)" });
  await expect(brothers).toContainText("123.5 BPM");
  await expect(brothers).toContainText("8A");
  await expect(brothers).toContainText("Kay Grove");
  await expect(library.getByRole("listitem", { name: "Track" })).toContainText("Other");
  await expect(folderPanel(page).getByTestId("rekordbox-status")).toHaveText("rekordbox: matched 1 of 2");
});

test("without a folder picker (Android Chrome), a folder is imported once and the page says it is not watched", async ({ page }) => {
  const id = learner("music-import");
  await page.addInitScript(() => {
    delete (window as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  });
  const folder = mkdtempSync(join(tmpdir(), "dj-tutorial-e2e-import-"));
  try {
    mkdirSync(join(folder, "Phone", "Sub"), { recursive: true });
    writeFileSync(join(folder, "Phone", "a.mp3"), "not music");
    writeFileSync(join(folder, "Phone", "Sub", "b.mp3"), "not music");
    writeFileSync(join(folder, "Phone", "notes.txt"), "x");
    await ensureProfile(page, id);
    await page.goto(`/controller?learner=${id}`);
    const setting = page.getByRole("region", { name: "Music folder" });
    await expect(setting).toContainText("Import your music folder.");
    await expect(setting).toContainText("This browser can't watch a folder");

    await setting.locator('input[type="file"]').setInputFiles(join(folder, "Phone"));

    await expect(setting.getByRole("status")).toContainText("“Phone”: 2 tracks");
    await expect(setting).toContainText("Import again");
    await expect(setting.getByRole("button", { name: "Rescan now" })).toHaveCount(0);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

// The server's music library (MUSIC_DIR): the e2e API has none (playwright.config.ts), so the page's
// requests to /api/music-library are answered here as the server would, in shared/music-library.ts's
// shape (server/music-library.test.ts tests the real route). A real MP3 so its BPM can be found.
const MP3 = readFileSync(join(import.meta.dirname, "fixtures", "original.mp3"));

async function serveLibrary(page: Page): Promise<string[]> {
  const asked: string[] = [];
  await page.route("**/api/music-library**", async (route) => {
    const url = new URL(route.request().url());
    asked.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/api/music-library") {
      await route.fulfill({
        json: {
          success: true,
          data: {
            configured: true,
            name: "Server Music",
            files: [
              { path: "House/Kay Grove - Brothers.mp3", size: MP3.length, lastModified: 1_700_000_000_000 },
              { path: "Broken - Not Music.mp3", size: 9, lastModified: 1_700_000_000_000 },
            ],
            xml: [],
            rekordboxXml: null,
            skipped: 0,
            truncated: false,
          },
        },
      });
      return;
    }
    const path = url.searchParams.get("path");
    if (path === "House/Kay Grove - Brothers.mp3") await route.fulfill({ body: MP3, contentType: "audio/mpeg" });
    else if (path === "Broken - Not Music.mp3") await route.fulfill({ body: "not music", contentType: "audio/mpeg" });
    else await route.fulfill({ status: 404, json: { success: false, error: "No such file." } });
  });
  return asked;
}

test("the server's music library: every device gets it with nothing to pick, and its files are analysed from the server", async ({ page }) => {
  test.setTimeout(120_000);
  const id = learner("music-server");
  // A browser with no folder picker (a phone) gets the same library.
  await page.addInitScript(() => {
    delete (window as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  });
  const asked = await serveLibrary(page);
  await ensureProfile(page, id);

  await page.goto(`/controller?learner=${id}`);
  const setting = page.getByRole("region", { name: "Music folder" });
  await expect(setting.getByRole("status")).toContainText("“Server Music” on the server: 2 tracks");
  await expect(setting).toContainText("The server's MUSIC_DIR sets this library");
  await expect(setting.getByRole("button", { name: /Pick a folder|Forget folder/ })).toHaveCount(0);
  await expect(setting.getByText("Import a folder")).toHaveCount(0);
  await expect(setting.getByRole("button", { name: "Rescan now" })).toBeVisible();

  await page.goto(`/?learner=${id}&track=synthetic`);
  await page.getByRole("button", { name: "Freestyle" }).click();
  await expect(page.locator("main.freestyle")).toHaveAttribute("data-phase", "ready");
  const library = page.getByRole("region", { name: "Library" });
  await expect(library.getByRole("listitem", { name: "Brothers" })).toBeVisible();
  await expect(library.getByRole("listitem", { name: "Not Music" })).toBeVisible();

  // The background pass (no deck playing) fetches each file from the server and analyses it.
  await expect(folderPanel(page).getByRole("status")).toContainText("BPM for 1 · 1 with no BPM", { timeout: 60_000 });
  expect(asked).toContain("/api/music-library/file?path=House%2FKay%20Grove%20-%20Brothers.mp3");
});

