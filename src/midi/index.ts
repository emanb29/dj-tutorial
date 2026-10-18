// Hardware controller support for the DDJ-FLX4 (docs/research/flx4-midi.md): Web MIDI access and
// device detection, a pure decoder from MIDI messages to what was touched, LED output, soft takeover
// for faders and knobs, and the jog wheel's ticks as jog gestures. The controller session
// (src/app/controller) turns decoded input into engine commands, the same path as the screen.

export { isControllerPort, MidiConnection, midiConnection } from "./connection.ts";
export { HardwarePositions, hardwarePositions, trackPositions } from "./positions.ts";
export type { KnownPosition } from "./positions.ts";
export type { MidiAccessLike, MidiConnectionOptions, MidiInputLike, MidiMessage, MidiOutputLike, MidiStatus } from "./connection.ts";
export { Flx4Decoder, FOURTEEN_BIT_MAX, physicalControlOf } from "./decoder.ts";
export type { ContinuousName, DeckButton, Flx4Input, PadMode, PadModeButton, SharedButton } from "./decoder.ts";
export { ALL_LEDS, allLedsOff, ledMessages, levelMeterMessage, levelMeterValue, trackLoadedMessage } from "./encoder.ts";
export type { LedId } from "./encoder.ts";
export { JOG_STILL_MS, JOG_TURN_INTERVAL_MS, JogDriver, TICKS_PER_REVOLUTION, ticksToRadians } from "./jog.ts";
export type { JogDriverOptions, JogTurns } from "./jog.ts";
export { PICKUP_TOLERANCE, SoftTakeover } from "./soft-takeover.ts";
export type { TakeoverMove, TakeoverStatus } from "./soft-takeover.ts";
export { CHECKLIST, describeInput } from "./describe.ts";
export type { ChecklistItem } from "./describe.ts";
