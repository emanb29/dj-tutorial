import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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

test("without a folder picker (Android Chrome), a folder is imported once and the page says it is not watched", async ({ page }) => {
  const id = learner("music-import");
  await page.addInitScript(() => {
    delete (window as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  });
  const folder = mkdtempSync(join(tmpdir(), "learn-to-dj-e2e-import-"));
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
