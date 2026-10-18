import { describe, expect, it } from "vitest";
import { CONTEXT_HOP_SEC, DEFAULT_OUTPUT, isControllerAudio, lineUpDelays, outputDevicesFrom, outputLine, parseOutputChoice, planOutput, supportsOutputSelection, type OutputChoice } from "./output.ts";

const device = (deviceId: string, label: string) => ({ deviceId, kind: "audiooutput" as const, label });

describe("output devices", () => {
  it("lists real outputs with their names, leaving out the default and communications aliases and inputs", () => {
    const listed = outputDevicesFrom([
      device("default", "Default - MacBook Pro Speakers"),
      device("spk", "MacBook Pro Speakers"),
      device("flx", "DDJ-FLX4"),
      { deviceId: "mic", kind: "audioinput", label: "MacBook Pro Microphone" },
      device("communications", "Communications"),
    ]);
    expect(listed).toEqual({
      devices: [
        { deviceId: "spk", label: "MacBook Pro Speakers", named: true },
        { deviceId: "flx", label: "DDJ-FLX4", named: true },
      ],
      needsPermission: false,
    });
  });

  it("names unnamed outputs 'Output N' and says a permission would name them", () => {
    expect(outputDevicesFrom([device("a1", ""), device("b2", "")])).toEqual({
      devices: [
        { deviceId: "a1", label: "Output 1", named: false },
        { deviceId: "b2", label: "Output 2", named: false },
      ],
      needsPermission: true,
    });
  });

  it("needs the permission when Chrome gives only an anonymous default", () => {
    expect(outputDevicesFrom([device("", "")])).toEqual({ devices: [], needsPermission: true });
  });

  it("recognises the FLX4's sound card by name, -N included", () => {
    expect(isControllerAudio("DDJ-FLX4")).toBe(true);
    expect(isControllerAudio("DDJ-FLX4-N (Pioneer DJ)")).toBe(true);
    expect(isControllerAudio("AirPods Pro")).toBe(false);
  });

  it("detects setSinkId on the AudioContext prototype", () => {
    expect(supportsOutputSelection({ setSinkId: () => undefined })).toBe(true);
    expect(supportsOutputSelection({})).toBe(false);
    expect(supportsOutputSelection(undefined)).toBe(false);
  });
});

const flx4: OutputChoice = { kind: "controller", deviceId: "flx", label: "DDJ-FLX4" };
const twoDevices: OutputChoice = { kind: "two-devices", masterDeviceId: "spk", masterLabel: "MacBook Pro Speakers", headphoneDeviceId: "pods", headphoneLabel: "AirPods", headphoneOffsetMs: 15 };
const present = [
  { deviceId: "spk", label: "MacBook Pro Speakers", named: true },
  { deviceId: "flx", label: "DDJ-FLX4", named: true },
  { deviceId: "pods", label: "AirPods", named: true },
];

describe("planOutput", () => {
  it("keeps split cue as it is", () => {
    expect(planOutput(DEFAULT_OUTPUT, present, true)).toEqual({ kind: "split-cue", sinkId: null, fallback: null });
  });

  it("sends everything to the FLX4 when it is there", () => {
    expect(planOutput(flx4, present, true)).toEqual({ kind: "controller", sinkId: "flx", label: "DDJ-FLX4" });
  });

  it("falls back to split cue, saying why, when the chosen device is missing", () => {
    expect(planOutput(flx4, present.slice(0, 1), true)).toEqual({ kind: "split-cue", sinkId: null, fallback: "DDJ-FLX4 not found" });
    expect(planOutput(twoDevices, present.slice(0, 2), true)).toEqual({ kind: "split-cue", sinkId: null, fallback: "AirPods not found" });
  });

  it("falls back where the browser cannot choose an output", () => {
    expect(planOutput(flx4, present, false)).toMatchObject({ kind: "split-cue", fallback: "This browser cannot choose a sound output" });
  });

  it("plans two devices with the offset", () => {
    expect(planOutput(twoDevices, present, true)).toEqual({
      kind: "two-devices",
      sinkId: "spk",
      masterLabel: "MacBook Pro Speakers",
      headphoneSinkId: "pods",
      headphoneLabel: "AirPods",
      headphoneOffsetMs: 15,
    });
  });
});

describe("outputLine", () => {
  it("says where the sound goes, in one short line", () => {
    expect(outputLine({ kind: "split-cue", sinkId: null, fallback: null }, true)).toBe("Left ear: cue · Right ear: master");
    expect(outputLine({ kind: "split-cue", sinkId: null, fallback: "DDJ-FLX4 not found" }, true)).toBe("DDJ-FLX4 not found: Left ear: cue · Right ear: master");
    expect(outputLine(planOutput(flx4, present, true), true)).toBe("FLX4: master to its MASTER OUT · cue to its headphones");
    expect(outputLine(planOutput(twoDevices, present, true), true)).toBe("Master: MacBook Pro Speakers · Cue: AirPods");
  });
});

describe("lineUpDelays", () => {
  it("delays the master when the headphones are later (Bluetooth), by the whole difference", () => {
    const delays = lineUpDelays({ masterSec: 0.01, headphoneSec: 0.2 }, 0);
    expect(delays.cueDelaySec).toBe(0);
    expect(delays.masterDelaySec).toBeCloseTo(0.2 + CONTEXT_HOP_SEC - 0.01, 9);
  });

  it("delays the headphones when the master is later", () => {
    const delays = lineUpDelays({ masterSec: 0.15, headphoneSec: 0.01 }, 0);
    expect(delays.masterDelaySec).toBe(0);
    expect(delays.cueDelaySec).toBeCloseTo(0.15 - 0.01 - CONTEXT_HOP_SEC, 9);
  });

  it("adds the Learner's offset, within its limit", () => {
    expect(lineUpDelays({ masterSec: 0, headphoneSec: 0 }, 30).masterDelaySec).toBeCloseTo(CONTEXT_HOP_SEC + 0.03, 9);
    expect(lineUpDelays({ masterSec: 0, headphoneSec: 0 }, -5000).cueDelaySec).toBeCloseTo(0.4 - CONTEXT_HOP_SEC, 9);
  });
});

describe("parseOutputChoice", () => {
  it("round-trips each choice", () => {
    for (const choice of [DEFAULT_OUTPUT, flx4, twoDevices]) expect(parseOutputChoice(JSON.stringify(choice))).toEqual(choice);
  });

  it("treats anything malformed as the default", () => {
    for (const text of [null, "", "{", "42", '{"kind":"controller"}', '{"kind":"two-devices","masterDeviceId":"a","masterLabel":"A","headphoneDeviceId":"a","headphoneLabel":"A","headphoneOffsetMs":0}', '{"kind":"rocket"}']) {
      expect(parseOutputChoice(text)).toEqual(DEFAULT_OUTPUT);
    }
  });

  it("clamps a stored offset", () => {
    expect(parseOutputChoice(JSON.stringify({ ...twoDevices, headphoneOffsetMs: 9000 }))).toMatchObject({ headphoneOffsetMs: 400 });
  });
});
