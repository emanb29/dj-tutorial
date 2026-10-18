import { describe, expect, it } from "vitest";
import { isControllerPort, MidiConnection, type MidiAccessLike, type MidiInputLike, type MidiMessage, type MidiOutputLike } from "./connection.ts";

class FakeInput extends EventTarget implements MidiInputLike {
  constructor(
    readonly id: string,
    readonly name: string | null,
  ) {
    super();
  }

  emit(bytes: number[], timeStamp: number): void {
    const event = new Event("midimessage");
    Object.defineProperties(event, { data: { value: new Uint8Array(bytes) }, timeStamp: { value: timeStamp } });
    this.dispatchEvent(event);
  }
}

class FakeOutput implements MidiOutputLike {
  readonly sent: number[][] = [];
  constructor(
    readonly id: string,
    readonly name: string | null,
  ) {}

  send(data: number[]): void {
    this.sent.push(data);
  }
}

class FakeAccess extends EventTarget implements MidiAccessLike {
  readonly inputs = new Map<string, FakeInput>();
  readonly outputs = new Map<string, FakeOutput>();

  plug(name: string): { input: FakeInput; output: FakeOutput } {
    const input = new FakeInput(`in-${name}`, name);
    const output = new FakeOutput(`out-${name}`, name);
    this.inputs.set(input.id, input);
    this.outputs.set(output.id, output);
    this.dispatchEvent(new Event("statechange"));
    return { input, output };
  }

  unplug(name: string): void {
    this.inputs.delete(`in-${name}`);
    this.outputs.delete(`out-${name}`);
    this.dispatchEvent(new Event("statechange"));
  }
}

function connection(options: { permission?: PermissionState | null; deny?: boolean } = {}) {
  const access = new FakeAccess();
  let asked = 0;
  const midi = new MidiConnection({
    requestAccess: () => {
      asked += 1;
      if (options.deny === true) return Promise.reject(new DOMException("blocked", "NotAllowedError"));
      return Promise.resolve(access);
    },
    permission: () => Promise.resolve(options.permission ?? "prompt"),
  });
  return { midi, access, asked: () => asked };
}

describe("isControllerPort", () => {
  it("matches the FLX4 and the FLX4-N by name, case-insensitively", () => {
    expect(isControllerPort("DDJ-FLX4")).toBe(true);
    expect(isControllerPort("DDJ-FLX4-N")).toBe(true);
    expect(isControllerPort("Pioneer ddj-flx4 MIDI 1")).toBe(true);
    expect(isControllerPort("DDJ-FLX6")).toBe(false);
    expect(isControllerPort("IAC Driver Bus 1")).toBe(false);
    expect(isControllerPort(null)).toBe(false);
  });
});

describe("MidiConnection", () => {
  it("is unsupported where there is no Web MIDI", () => {
    const midi = new MidiConnection({ requestAccess: null, permission: () => Promise.resolve(null) });
    expect(midi.status()).toEqual({ kind: "unsupported" });
  });

  it("does not prompt by itself unless access was granted before", async () => {
    const prompt = connection({ permission: "prompt" });
    await prompt.midi.connectIfAllowed();
    expect(prompt.asked()).toBe(0);
    expect(prompt.midi.status()).toEqual({ kind: "not-asked" });

    const granted = connection({ permission: "granted" });
    await granted.midi.connectIfAllowed();
    expect(granted.asked()).toBe(1);
  });

  it("finds the controller among the ports, and lists every port", async () => {
    const { midi, access } = connection();
    access.plug("IAC Driver Bus 1");
    access.plug("DDJ-FLX4");
    await midi.connect();
    expect(midi.status()).toEqual({ kind: "connected", inputName: "DDJ-FLX4", outputName: "DDJ-FLX4", ports: ["IAC Driver Bus 1", "DDJ-FLX4"] });
  });

  it("follows the controller being plugged in and out", async () => {
    const { midi, access } = connection();
    const seen: string[] = [];
    midi.subscribe(() => seen.push(midi.status().kind));
    await midi.connect();
    expect(midi.status()).toEqual({ kind: "no-controller", ports: [] });
    access.plug("DDJ-FLX4");
    expect(midi.connected).toBe(true);
    access.unplug("DDJ-FLX4");
    expect(midi.status().kind).toBe("no-controller");
    expect(seen).toEqual(["asking", "no-controller", "connected", "no-controller"]);
  });

  it("passes the controller's messages on with their timestamps, and nobody else's", async () => {
    const { midi, access } = connection();
    const other = access.plug("Keyboard");
    const flx4 = access.plug("DDJ-FLX4");
    await midi.connect();
    const messages: MidiMessage[] = [];
    midi.onMessage((message) => messages.push(message));
    flx4.input.emit([0x90, 0x0b, 0x7f], 1234.5);
    other.input.emit([0x90, 0x3c, 0x7f], 1300);
    expect(messages.map((message) => [Array.from(message.data), message.timeStamp])).toEqual([[[0x90, 0x0b, 0x7f], 1234.5]]);
  });

  it("stops listening to a controller that was unplugged", async () => {
    const { midi, access } = connection();
    const flx4 = access.plug("DDJ-FLX4");
    await midi.connect();
    const messages: MidiMessage[] = [];
    midi.onMessage((message) => messages.push(message));
    access.unplug("DDJ-FLX4");
    flx4.input.emit([0x90, 0x0b, 0x7f], 1);
    expect(messages).toEqual([]);
  });

  it("sends LED messages to the controller's output only", async () => {
    const { midi, access } = connection();
    expect(midi.send([[0x90, 0x0b, 0x7f]])).toBe(false);
    const flx4 = access.plug("DDJ-FLX4");
    await midi.connect();
    expect(midi.send([[0x90, 0x0b, 0x7f]])).toBe(true);
    expect(flx4.output.sent).toEqual([[0x90, 0x0b, 0x7f]]);
  });

  it("explains a refusal and how to undo it", async () => {
    const { midi } = connection({ deny: true });
    await midi.connect();
    expect(midi.status()).toMatchObject({ kind: "denied", message: expect.stringContaining("site settings") as unknown });
  });
});
