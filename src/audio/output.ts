// Where the engine's sound goes (research: docs/research/flx4-midi.md, "Browser APIs"). Three modes,
// all chosen by the Learner and never switched to on their own:
// - "split-cue": one device, today's default. Headphone Lessons put the cue in the left ear and the
//   master in the right; other Lessons play the master in stereo.
// - "controller": a DDJ-FLX4's own sound card, four channels: master on outputs 1/2 (its MASTER OUT,
//   to speakers) and the headphone cue on 3/4 (its headphone jack).
// - "two-devices": the master to one device (speakers) and the headphone cue to another (headphones),
//   with the two paths' latencies lined up and a manual offset on top.
// Everything here is pure or takes the browser APIs as arguments, so it is tested with fake devices.

export type OutputChoice =
  | { readonly kind: "split-cue" }
  | { readonly kind: "controller"; readonly deviceId: string; readonly label: string }
  | {
      readonly kind: "two-devices";
      readonly masterDeviceId: string;
      readonly masterLabel: string;
      readonly headphoneDeviceId: string;
      readonly headphoneLabel: string;
      /** The Learner's correction, ms: positive when the headphones still sound late after the automatic line-up. */
      readonly headphoneOffsetMs: number;
    };

export const DEFAULT_OUTPUT: OutputChoice = { kind: "split-cue" };
export const HEADPHONE_OFFSET_LIMIT_MS = 400;

export interface OutputDevice {
  readonly deviceId: string;
  /** The device's name, or "Output 2" when the browser does not say (no permission yet). */
  readonly label: string;
  /** Whether the browser gave the name. */
  readonly named: boolean;
}

/** A device label that is a DDJ-FLX4's (or -N's) sound card. */
export function isControllerAudio(label: string): boolean {
  return /DDJ-FLX4/i.test(label);
}

/** Whether this browser can send an AudioContext to a chosen device (Chrome and Edge 110+). */
export function supportsOutputSelection(audioContextPrototype: object | undefined = typeof AudioContext === "undefined" ? undefined : AudioContext.prototype): boolean {
  return audioContextPrototype !== undefined && "setSinkId" in audioContextPrototype;
}

/**
 * The output devices the page may choose from. Chrome lists them all only once the microphone
 * permission is granted; before that it gives the default only, with no id (`needsPermission`).
 * "default" and "communications" are aliases of real devices and are left out.
 */
export function outputDevicesFrom(devices: readonly Pick<MediaDeviceInfo, "deviceId" | "kind" | "label">[]): { devices: OutputDevice[]; needsPermission: boolean } {
  const outputs = devices.filter((device) => device.kind === "audiooutput");
  const real = outputs.filter((device) => device.deviceId !== "" && device.deviceId !== "default" && device.deviceId !== "communications");
  return {
    devices: real.map((device, index) => ({ deviceId: device.deviceId, label: device.label === "" ? `Output ${String(index + 1)}` : device.label, named: device.label !== "" })),
    needsPermission: real.length === 0 || real.every((device) => device.label === ""),
  };
}

/** What the engine will do for a choice, given the devices present now. */
export type OutputPlan =
  | { readonly kind: "split-cue"; readonly sinkId: null; readonly fallback: string | null }
  | { readonly kind: "controller"; readonly sinkId: string; readonly label: string }
  | { readonly kind: "two-devices"; readonly sinkId: string; readonly masterLabel: string; readonly headphoneSinkId: string; readonly headphoneLabel: string; readonly headphoneOffsetMs: number };

/**
 * The plan for a choice. A chosen device that is missing (unplugged) or a browser that cannot choose
 * falls back to split cue on this computer, and says why, so the Lesson can show it.
 */
export function planOutput(choice: OutputChoice, present: readonly OutputDevice[], canSelect: boolean): OutputPlan {
  if (choice.kind === "split-cue") return { kind: "split-cue", sinkId: null, fallback: null };
  if (!canSelect) return { kind: "split-cue", sinkId: null, fallback: "This browser cannot choose a sound output" };
  const has = (deviceId: string) => present.some((device) => device.deviceId === deviceId);
  if (choice.kind === "controller") {
    return has(choice.deviceId) ? { kind: "controller", sinkId: choice.deviceId, label: choice.label } : { kind: "split-cue", sinkId: null, fallback: `${choice.label} not found` };
  }
  const missing = [has(choice.masterDeviceId) ? null : choice.masterLabel, has(choice.headphoneDeviceId) ? null : choice.headphoneLabel].filter((label) => label !== null);
  if (missing.length > 0) return { kind: "split-cue", sinkId: null, fallback: `${missing.join(" and ")} not found` };
  return {
    kind: "two-devices",
    sinkId: choice.masterDeviceId,
    masterLabel: choice.masterLabel,
    headphoneSinkId: choice.headphoneDeviceId,
    headphoneLabel: choice.headphoneLabel,
    headphoneOffsetMs: choice.headphoneOffsetMs,
  };
}

/** One short line for the Lesson screen, so where the sound goes is never a surprise. */
export function outputLine(plan: OutputPlan, headphones: boolean): string {
  switch (plan.kind) {
    case "split-cue": {
      const where = headphones ? "Left ear: cue · Right ear: master" : "This computer's output";
      return plan.fallback === null ? where : `${plan.fallback}: ${where}`;
    }
    case "controller":
      return "FLX4: master to its MASTER OUT · cue to its headphones";
    case "two-devices":
      return `Master: ${plan.masterLabel} · Cue: ${plan.headphoneLabel}`;
  }
}

/** The extra time the cue path takes to reach its device, over the master path: a stream hop between contexts. */
export const CONTEXT_HOP_SEC = 0.02;

/**
 * Delays that line the two devices up. Each path's latency is its device's output latency (plus the
 * stream hop and the Learner's offset for the headphones); the earlier path is delayed by the
 * difference. A delayed master is heard later than its output timestamp says, so the engine's clock
 * subtracts `masterDelaySec` and heard-time grading stays on the master device's clock.
 */
export function lineUpDelays(latency: { readonly masterSec: number; readonly headphoneSec: number }, headphoneOffsetMs: number): { masterDelaySec: number; cueDelaySec: number } {
  const offsetSec = Math.max(-HEADPHONE_OFFSET_LIMIT_MS, Math.min(HEADPHONE_OFFSET_LIMIT_MS, headphoneOffsetMs)) / 1000;
  const difference = latency.headphoneSec + CONTEXT_HOP_SEC + offsetSec - latency.masterSec;
  return difference >= 0 ? { masterDelaySec: difference, cueDelaySec: 0 } : { masterDelaySec: 0, cueDelaySec: -difference };
}

/** Reads a stored choice; anything malformed is the default (one-device split cue). */
export function parseOutputChoice(text: string | null): OutputChoice {
  if (text === null) return DEFAULT_OUTPUT;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return DEFAULT_OUTPUT;
  }
  if (typeof value !== "object" || value === null) return DEFAULT_OUTPUT;
  const record = value as Record<string, unknown>;
  const text_ = (key: string) => (typeof record[key] === "string" && record[key] !== "" ? record[key] : null);
  if (record["kind"] === "controller") {
    const deviceId = text_("deviceId");
    const label = text_("label");
    return deviceId === null || label === null ? DEFAULT_OUTPUT : { kind: "controller", deviceId, label };
  }
  if (record["kind"] === "two-devices") {
    const masterDeviceId = text_("masterDeviceId");
    const masterLabel = text_("masterLabel");
    const headphoneDeviceId = text_("headphoneDeviceId");
    const headphoneLabel = text_("headphoneLabel");
    const offset = record["headphoneOffsetMs"];
    if (masterDeviceId === null || masterLabel === null || headphoneDeviceId === null || headphoneLabel === null || typeof offset !== "number" || !Number.isFinite(offset)) return DEFAULT_OUTPUT;
    if (masterDeviceId === headphoneDeviceId) return DEFAULT_OUTPUT;
    return { kind: "two-devices", masterDeviceId, masterLabel, headphoneDeviceId, headphoneLabel, headphoneOffsetMs: Math.max(-HEADPHONE_OFFSET_LIMIT_MS, Math.min(HEADPHONE_OFFSET_LIMIT_MS, offset)) };
  }
  return DEFAULT_OUTPUT;
}
