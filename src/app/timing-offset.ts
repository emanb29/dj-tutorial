// The Timing check's result (src/audio/input-latency.ts), kept per browser and per output mode: the
// latency belongs to this device and the output the sound goes through, not to the Learner (so it is not
// in their profile, which follows them to other devices). Storage can be blocked (a private window):
// then the correction lasts until the page reloads, and the Learner is told so.

import { useSyncExternalStore } from "react";
import { boundedCorrectionMs, type OutputPlan } from "@audio";

export type OutputMode = OutputPlan["kind"];

export interface StoredTiming {
  /** Positive: the Learner's taps land late; this much is taken off each input. Held to ±150 ms. */
  readonly offsetMs: number;
  readonly measuredAt: string;
  readonly taps: number;
}

type Timings = Partial<Record<OutputMode, StoredTiming>>;

const STORAGE_KEY = "learn-to-dj.timing-offset";
const OFFERED_KEY = "learn-to-dj.timing-check-offered";
const MODES: readonly OutputMode[] = ["split-cue", "controller", "two-devices"];

let cached: Timings | null = null;
const listeners = new Set<() => void>();

function parse(text: string | null): Timings {
  if (text === null) return {};
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== "object" || raw === null) return {};
    const record = raw as Record<string, unknown>;
    return Object.fromEntries(
      MODES.flatMap((mode) => {
        const entry = record[mode];
        if (typeof entry !== "object" || entry === null) return [];
        const { offsetMs, measuredAt, taps } = entry as Record<string, unknown>;
        if (typeof offsetMs !== "number" || typeof measuredAt !== "string" || typeof taps !== "number") return [];
        return [[mode, { offsetMs: boundedCorrectionMs(offsetMs), measuredAt, taps }]];
      }),
    );
  } catch {
    console.warn("[timing] the stored Timing check result was unreadable; it is ignored");
    return {};
  }
}

function load(): Timings {
  if (cached !== null) return cached;
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage blocked: no stored timing.
  }
  cached = parse(stored);
  return cached;
}

function store(next: Timings): void {
  cached = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (error) {
    console.warn("[timing] the Timing check result could not be stored; it lasts until the page reloads", error);
  }
  for (const listener of listeners) listener();
}

/** The correction for inputs heard through `mode`, in ms; 0 when there is no Timing check for it. */
export function timingCorrectionMs(mode: OutputMode): number {
  return load()[mode]?.offsetMs ?? 0;
}

/** Whether any output has a Timing check result in this browser. */
export function anyTimingStored(): boolean {
  return Object.keys(load()).length > 0;
}

export function timingFor(mode: OutputMode): StoredTiming | null {
  return load()[mode] ?? null;
}

export function saveTiming(mode: OutputMode, offsetMs: number, taps: number, now: Date = new Date()): void {
  store({ ...load(), [mode]: { offsetMs: boundedCorrectionMs(offsetMs), measuredAt: now.toISOString(), taps } });
}

export function resetTiming(mode: OutputMode): void {
  store(Object.fromEntries(Object.entries(load()).filter(([kept]) => kept !== mode)));
}

export function useTiming(mode: OutputMode): StoredTiming | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => load()[mode] ?? null,
    () => null,
  );
}

/** Whether the first tap Lesson has offered the Timing check already (it offers once per browser). */
export function timingCheckOffered(): boolean {
  try {
    return window.localStorage.getItem(OFFERED_KEY) !== null;
  } catch {
    return false;
  }
}

export function markTimingCheckOffered(): void {
  try {
    window.localStorage.setItem(OFFERED_KEY, new Date().toISOString());
  } catch {
    // Storage blocked: the offer may come again next time; nothing else depends on it.
  }
}

/** Forgets the cache, for tests that change localStorage underneath. */
export function forgetTimingCache(): void {
  cached = null;
}
