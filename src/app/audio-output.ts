// The Learner's sound output choice (src/audio/output.ts has the modes), kept per browser. The engine
// only ever uses what the Learner picked on the Controller page; nothing switches outputs by itself.

import { useSyncExternalStore } from "react";
import { DEFAULT_OUTPUT, outputDevicesFrom, parseOutputChoice, planOutput, supportsOutputSelection, type OutputChoice, type OutputDevice, type OutputPlan } from "@audio";

const STORAGE_KEY = "learn-to-dj.audio-output";

let cached: OutputChoice | null = null;
const listeners = new Set<() => void>();

export function loadOutputChoice(): OutputChoice {
  if (cached !== null) return cached;
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage blocked (a private window, site data off): the default, split cue.
  }
  cached = parseOutputChoice(stored);
  return cached;
}

export function saveOutputChoice(choice: OutputChoice): void {
  cached = choice;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
  } catch (error) {
    console.warn("[audio-output] the choice could not be stored; it lasts until the page reloads", error);
  }
  for (const listener of listeners) listener();
}

export function useOutputChoice(): OutputChoice {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    loadOutputChoice,
    () => DEFAULT_OUTPUT,
  );
}

export interface OutputList {
  readonly devices: readonly OutputDevice[];
  /** The browser lists (or names) outputs only after the microphone permission. */
  readonly needsPermission: boolean;
}

export async function listOutputs(): Promise<OutputList> {
  // No mediaDevices outside a secure context.
  if (!("mediaDevices" in navigator)) return { devices: [], needsPermission: false };
  return outputDevicesFrom(await navigator.mediaDevices.enumerateDevices());
}

/**
 * Chrome lists every output, with names, only once the microphone is allowed. Asking for it opens the
 * microphone for a moment; the stream stops at once and nothing is recorded.
 */
export async function askToListOutputs(): Promise<OutputList> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  for (const track of stream.getTracks()) track.stop();
  return listOutputs();
}

/** The plan for the stored choice with the devices present now: what a new engine should use. */
export async function currentOutputPlan(): Promise<OutputPlan> {
  const choice = loadOutputChoice();
  if (choice.kind === "split-cue") return planOutput(choice, [], supportsOutputSelection());
  try {
    return planOutput(choice, (await listOutputs()).devices, supportsOutputSelection());
  } catch (error) {
    console.warn("[audio-output] could not list the outputs; using split cue", error);
    return planOutput(DEFAULT_OUTPUT, [], false);
  }
}
