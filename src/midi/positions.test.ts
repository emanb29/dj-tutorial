import { describe, expect, it } from "vitest";
import type { MidiMessage } from "./connection.ts";
import { HardwarePositions, trackPositions } from "./positions.ts";

/** A stand-in for the MIDI connection: messages and connection changes on demand. */
function fakeConnection() {
  const messages = new Set<(message: MidiMessage) => void>();
  const statuses = new Set<() => void>();
  const connection = {
    connected: true,
    onMessage(listener: (message: MidiMessage) => void) {
      messages.add(listener);
      return () => messages.delete(listener);
    },
    subscribe(listener: () => void) {
      statuses.add(listener);
      return () => statuses.delete(listener);
    },
  };
  return {
    connection,
    send(bytes: number[], timeStamp = 10) {
      for (const listener of messages) listener({ data: new Uint8Array(bytes), timeStamp });
    },
    unplug() {
      connection.connected = false;
      for (const listener of statuses) listener();
    },
  };
}

describe("HardwarePositions", () => {
  it("learns each fader and knob from its 14-bit messages, and ignores buttons", () => {
    const fake = fakeConnection();
    const positions = new HardwarePositions();
    trackPositions(fake.connection, positions);
    // Deck B channel fader at the top: MSB 0x7F, LSB 0x7F.
    fake.send([0xb1, 0x13, 0x7f], 10);
    fake.send([0xb1, 0x33, 0x7f], 11);
    fake.send([0x90, 0x0b, 0x7f], 12);
    expect(positions.get("B.channel-fader")).toEqual({ value: 1, atMs: 11 });
    expect([...positions.ids()]).toEqual(["B.channel-fader"]);
  });

  it("forgets everything when the controller is unplugged, and tells its listeners", () => {
    const fake = fakeConnection();
    const positions = new HardwarePositions();
    trackPositions(fake.connection, positions);
    fake.send([0xb6, 0x1f, 0x40]);
    fake.send([0xb6, 0x3f, 0x00]);
    const before = positions.snapshot();
    fake.unplug();
    expect(positions.get("crossfader")).toBeNull();
    expect(positions.snapshot()).toBeGreaterThan(before);
  });
});
