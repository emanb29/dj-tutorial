// Whether the Learner chose, on the Controller page, to let the app ask the DDJ-FLX4 for its positions
// (src/midi/connection.ts, POSITION_REQUEST): it needs Chrome's SysEx permission, so it is never asked
// for by itself, only after the page explains it and the Learner clicks. Kept per browser.

const STORAGE_KEY = "learn-to-dj.midi-sysex";

export function sysexChosen(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

export function chooseSysex(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(STORAGE_KEY, "on");
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.warn("[midi] the position-request choice could not be stored; it lasts until the page reloads", error);
  }
}
