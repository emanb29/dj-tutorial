// A MIDI message's time on the performance.now() clock, which grading maps to heard time.
//
// Chrome stamps a MIDIMessageEvent with the OS's packet time, converted to the page's clock
// (Event::timeStamp → Performance::MonotonicTimeToDOMHighResTimeStamp). That conversion returns 0 for a
// null time and for any time before the page's time origin, and on macOS the packet time is CoreMIDI's
// MIDIPacket.timeStamp (media/midi/midi_manager_mac.cc: TimeTicks::FromMachAbsoluteTime), which a driver
// may leave 0, meaning "now". A tap stamped 0 is heard minutes before the Check began: it lands in no
// section and counts as nothing, not even an extra tap. So a stamp that cannot be the message's arrival
// is replaced by the time the handler ran, which is at most a frame or two late.

/** A real stamp is at most this far before the handler runs (a long main-thread stall). */
export const MIDI_STAMP_MAX_AGE_MS = 1000;
/** Nor after it, beyond clock rounding. */
export const MIDI_STAMP_MAX_AHEAD_MS = 5;

export type MidiEventTime =
  | { readonly kind: "stamped"; readonly timeMs: number }
  /** The stamp was unusable; `offsetMs` is how far it was from the handler's time (for the log). */
  | { readonly kind: "handler-time"; readonly timeMs: number; readonly offsetMs: number };

/** The message's time: its own stamp when that is plausible, else `handlerNowMs`. */
export function midiEventTime(timeStamp: number, handlerNowMs: number): MidiEventTime {
  const ageMs = handlerNowMs - timeStamp;
  if (Number.isFinite(timeStamp) && timeStamp > 0 && ageMs <= MIDI_STAMP_MAX_AGE_MS && ageMs >= -MIDI_STAMP_MAX_AHEAD_MS) return { kind: "stamped", timeMs: timeStamp };
  return { kind: "handler-time", timeMs: handlerNowMs, offsetMs: timeStamp - handlerNowMs };
}
