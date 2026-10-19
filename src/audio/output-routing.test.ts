// createOutputRouting with fake devices: which contexts it opens, which monitor it builds, and the
// fallbacks. No audio is made (Node has no Web Audio): the contexts are stand-ins with a channel count.

import { describe, expect, it } from "vitest";
import { MasterOnlyMonitor, SplitCueMonitor } from "./monitor.ts";
import { TwoDeviceMonitor } from "./device-monitors.ts";
import { createOutputRouting, type OpenContext } from "./output-routing.ts";
import { planOutput, type OutputChoice, type OutputPlan } from "./output.ts";

interface FakeContext {
  readonly sinkId: string | null;
  readonly destination: { readonly maxChannelCount: number };
  closed: boolean;
  close(): Promise<void>;
}

/** Devices by id with their channel count; the default output (null) is stereo. */
function fakeDevices(channels: Readonly<Record<string, number>>) {
  const opened: FakeContext[] = [];
  const open: OpenContext = (sinkId) => {
    const context: FakeContext = {
      sinkId,
      destination: { maxChannelCount: sinkId === null ? 2 : (channels[sinkId] ?? 2) },
      closed: false,
      close() {
        context.closed = true;
        return Promise.resolve();
      },
    };
    opened.push(context);
    return context as unknown as AudioContext;
  };
  return { open, opened };
}

const present = [
  { deviceId: "spk", label: "MacBook Pro Speakers", named: true },
  { deviceId: "flx", label: "DDJ-FLX4", named: true },
];
const phones: OutputChoice = { kind: "computer-and-controller-phones", masterDeviceId: "spk", masterLabel: "MacBook Pro Speakers", controllerDeviceId: "flx", controllerLabel: "DDJ-FLX4", headphoneOffsetMs: 20 };
const phonesPlan: OutputPlan = planOutput(phones, present, true);

describe("createOutputRouting: speakers on this computer, headphones on the FLX4", () => {
  it("plays the engine on the speakers and lines the FLX4's headphones up with them, when its card shows 4 outputs", () => {
    const devices = fakeDevices({ spk: 2, flx: 4 });
    const routing = createOutputRouting(phonesPlan, { headphones: true, openContext: devices.open });
    expect(routing.plan).toEqual(phonesPlan);
    expect(routing.monitor).toBeInstanceOf(TwoDeviceMonitor);
    expect((routing.context as unknown as FakeContext).sinkId).toBe("spk");
    // The FLX4's context was opened to check its channels, and kept for the headphone path.
    expect(devices.opened.map((context) => [context.sinkId, context.closed])).toEqual([
      ["flx", false],
      ["spk", false],
    ]);
  });

  it("falls back to split cue on this computer, saying why, when the FLX4 shows fewer than 4 outputs", () => {
    const devices = fakeDevices({ spk: 2, flx: 2 });
    const routing = createOutputRouting(phonesPlan, { headphones: true, openContext: devices.open });
    expect(routing.plan).toEqual({ kind: "split-cue", sinkId: null, fallback: "DDJ-FLX4 shows 2 outputs, not 4" });
    expect(routing.monitor).toBeInstanceOf(SplitCueMonitor);
    expect((routing.context as unknown as FakeContext).sinkId).toBeNull();
    // Nothing is left open on the FLX4, so nothing can reach its MASTER OUT.
    expect(devices.opened.filter((context) => context.sinkId === "flx").every((context) => context.closed)).toBe(true);
  });

  it("plays the master only on the speakers in a Lesson without headphone cueing, and leaves the FLX4 alone", () => {
    const devices = fakeDevices({ spk: 2, flx: 4 });
    const routing = createOutputRouting(phonesPlan, { headphones: false, openContext: devices.open });
    expect(routing.monitor).toBeInstanceOf(MasterOnlyMonitor);
    expect(devices.opened.map((context) => context.sinkId)).toEqual(["spk"]);
  });
});

describe("createOutputRouting: the other modes, with the same fake devices", () => {
  it("still falls back from a two-channel FLX4 in the controller mode", () => {
    const devices = fakeDevices({ flx: 2 });
    const routing = createOutputRouting({ kind: "controller", sinkId: "flx", label: "DDJ-FLX4" }, { headphones: true, openContext: devices.open });
    expect(routing.plan).toEqual({ kind: "split-cue", sinkId: null, fallback: "DDJ-FLX4 shows 2 outputs, not 4" });
  });

  it("opens two stereo devices' master on the speakers for two devices", () => {
    const devices = fakeDevices({ spk: 2, pods: 2 });
    const routing = createOutputRouting({ kind: "two-devices", sinkId: "spk", masterLabel: "Speakers", headphoneSinkId: "pods", headphoneLabel: "AirPods", headphoneOffsetMs: 0 }, { headphones: true, openContext: devices.open });
    expect(routing.monitor).toBeInstanceOf(TwoDeviceMonitor);
    expect(devices.opened.map((context) => context.sinkId)).toEqual(["spk"]);
  });
});
