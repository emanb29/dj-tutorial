// Whether Lessons try the Learner's own music first ("Your music"): a per-browser convenience, so
// localStorage, guarded (blocked or full storage just means off).
const STORAGE_KEY = "learn-to-dj.lessons.own-music";

export function readOwnMusic(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

export function writeOwnMusic(on: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
}
