// Where the engine's sound goes (research: docs/research/flx4-midi.md, "Browser APIs"). Five modes,
// all chosen by the Learner and never switched to on their own:
// - "split-cue": one device, today's default. Headphone Lessons put the cue in the left ear and the
//   master in the right; other Lessons play the master in stereo.
// - "controller": a DDJ-FLX4's own sound card, four channels: master on outputs 1/2 (its MASTER OUT,
//   to speakers) and the headphone cue on 3/4 (its headphone jack).
// - "two-devices": the master to one device (speakers) and the headphone cue to another (headphones),
//   with the two paths' latencies lined up and a manual offset on top.
// - "computer-and-controller-phones": the master to a computer device (speakers), the headphone cue to
//   the FLX4's headphone jack (its outputs 3/4, with silence on 1/2). It is its own kind, not a variant
//   of "two-devices", because its second device has a different shape (four channels, cue on 3/4, a
//   fewer-than-4 fallback) and a different latency, and the Timing check is stored per kind
//   (src/app/timing-offset.ts), so it gets its own entry. It reuses the two-devices line-up and offset
//   (TwoDeviceMonitor) and the FLX4's channel layout (ControllerCueMonitor): device-monitors.ts.
// - "dual-master": rekordbox's PC MASTER OUT. The master plays on a computer device (speakers) AND on
//   the FLX4's MASTER OUT (outputs 1/2), the headphone cue on the FLX4's headphone jack (3/4). The
//   engine's context is on the computer's device, as in the mode above, and the FLX4 is the second
//   device; both its outputs come from one context, so they stay together, and the line-up delays the
//   earlier device. The engine's clock reads the computer's output timestamp (less its line-up delay),
//   which is when both devices sound once lined up. The offset is the FLX4's: positive when it still
//   sounds late.
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
    }
  | {
      readonly kind: "computer-and-controller-phones";
      readonly masterDeviceId: string;
      readonly masterLabel: string;
      /** The FLX4's sound card: the cue goes to its headphone jack. */
      readonly controllerDeviceId: string;
      readonly controllerLabel: string;
      /** As for two devices: positive when the FLX4's headphones still sound late after the line-up. */
      readonly headphoneOffsetMs: number;
    }
  | {
      readonly kind: "dual-master";
      /** This computer's device: the master, and the engine's clock. */
      readonly masterDeviceId: string;
      readonly masterLabel: string;
      /** The FLX4's sound card: the master on its MASTER OUT, the cue on its headphone jack. */
      readonly controllerDeviceId: string;
      readonly controllerLabel: string;
      /** Positive when the FLX4 (its MASTER OUT and headphones together) still sounds late after the line-up. */
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
  | { readonly kind: "two-devices"; readonly sinkId: string; readonly masterLabel: string; readonly headphoneSinkId: string; readonly headphoneLabel: string; readonly headphoneOffsetMs: number }
  | {
      readonly kind: "computer-and-controller-phones" | "dual-master";
      readonly sinkId: string;
      readonly masterLabel: string;
      readonly controllerSinkId: string;
      readonly controllerLabel: string;
      readonly headphoneOffsetMs: number;
    };

/** A plan with a second device for the headphones, lined up with the master's (TwoDeviceMonitor). */
export type LinedUpPlan = Extract<OutputPlan, { kind: "two-devices" | "computer-and-controller-phones" | "dual-master" }>;

/** A plan whose second device is the FLX4's sound card (four channels). */
export type ControllerSecondPlan = Extract<OutputPlan, { kind: "computer-and-controller-phones" | "dual-master" }>;

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
  const notFound = (devices: readonly (readonly [deviceId: string, label: string])[]): OutputPlan | null => {
    const missing = devices.filter(([deviceId]) => !has(deviceId)).map(([, label]) => label);
    return missing.length > 0 ? { kind: "split-cue", sinkId: null, fallback: `${missing.join(" and ")} not found` } : null;
  };
  if (choice.kind === "computer-and-controller-phones" || choice.kind === "dual-master") {
    return (
      notFound([
        [choice.masterDeviceId, choice.masterLabel],
        [choice.controllerDeviceId, choice.controllerLabel],
      ]) ?? {
        kind: choice.kind,
        sinkId: choice.masterDeviceId,
        masterLabel: choice.masterLabel,
        controllerSinkId: choice.controllerDeviceId,
        controllerLabel: choice.controllerLabel,
        headphoneOffsetMs: choice.headphoneOffsetMs,
      }
    );
  }
  const missing = notFound([
    [choice.masterDeviceId, choice.masterLabel],
    [choice.headphoneDeviceId, choice.headphoneLabel],
  ]);
  if (missing !== null) return missing;
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
    case "computer-and-controller-phones":
      return `Speakers: ${plan.masterLabel} · Headphones: FLX4`;
    case "dual-master":
      return `Master: FLX4 and ${plan.masterLabel} · Cue: FLX4 headphones`;
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

/**
 * Why the FLX4's headphone jack cannot take the cue, or null when its card shows the four outputs it
 * needs. With two, a stereo cue would land on 1/2, its MASTER OUT, so the engine falls back instead
 * (in PC MASTER OUT too: the cue would be in the speakers).
 */
export function controllerPhonesFallback(controllerLabel: string, channels: number): string | null {
  return channels >= 4 ? null : `${controllerLabel} shows ${String(channels)} outputs, not 4`;
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
  const offset = record["headphoneOffsetMs"];
  const headphoneOffsetMs = typeof offset === "number" && Number.isFinite(offset) ? Math.max(-HEADPHONE_OFFSET_LIMIT_MS, Math.min(HEADPHONE_OFFSET_LIMIT_MS, offset)) : null;
  const masterDeviceId = text_("masterDeviceId");
  const masterLabel = text_("masterLabel");
  if (record["kind"] === "two-devices") {
    const headphoneDeviceId = text_("headphoneDeviceId");
    const headphoneLabel = text_("headphoneLabel");
    if (masterDeviceId === null || masterLabel === null || headphoneDeviceId === null || headphoneLabel === null || headphoneOffsetMs === null) return DEFAULT_OUTPUT;
    if (masterDeviceId === headphoneDeviceId) return DEFAULT_OUTPUT;
    return { kind: "two-devices", masterDeviceId, masterLabel, headphoneDeviceId, headphoneLabel, headphoneOffsetMs };
  }
  const kind = record["kind"];
  if (kind === "computer-and-controller-phones" || kind === "dual-master") {
    const controllerDeviceId = text_("controllerDeviceId");
    const controllerLabel = text_("controllerLabel");
    if (masterDeviceId === null || masterLabel === null || controllerDeviceId === null || controllerLabel === null || headphoneOffsetMs === null) return DEFAULT_OUTPUT;
    if (masterDeviceId === controllerDeviceId) return DEFAULT_OUTPUT;
    return { kind, masterDeviceId, masterLabel, controllerDeviceId, controllerLabel, headphoneOffsetMs };
  }
  return DEFAULT_OUTPUT;
}
