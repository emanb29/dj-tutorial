// Decodes DDJ-FLX4 MIDI messages into what was touched, per AlphaTheta's "DDJ-FLX4 List of MIDI
// messages" Ver 1.0 (docs/research/flx4-midi.md has every row). Pure apart from two bits of state the
// protocol itself needs: the MSB of each 14-bit control (its LSB completes the value) and the four
// notes that together give the Beat FX CH SELECT lever's position.

import type { DeckId } from "@audio";

export type PadMode = "hot-cue" | "pad-fx-1" | "beat-jump" | "sampler" | "keyboard" | "pad-fx-2" | "beat-loop" | "key-shift";
/** The four pad-mode buttons, named by their unshifted mode. */
export type PadModeButton = "hot-cue" | "pad-fx-1" | "beat-jump" | "sampler";

export type DeckButton =
  | "play"
  | "cue"
  | "shift"
  | "sync"
  /** BEAT SYNC held: its own note, sent at the long press (a short press sends `sync` on release). */
  | "sync-long"
  | "headphone-cue"
  | "loop-in"
  | "loop-out"
  | "loop-exit"
  | "call-back"
  | "call-forward"
  | "load"
  /** SHIFT + a fader moved off or to its end ("fader start"): no meaning in the app. */
  | "fader-start";

export type SharedButton = "master-cue" | "smart-cfx" | "smart-fader" | "mono-stereo" | "browse-press" | "fx-select" | "fx-beat-back" | "fx-beat-forward" | "fx-on";

export type ContinuousName =
  | "tempo"
  | "trim"
  | "eq-high"
  | "eq-mid"
  | "eq-low"
  | "filter"
  | "channel-fader"
  | "crossfader"
  | "master-level"
  | "mic-level"
  | "headphone-mix"
  | "headphone-level"
  | "beat-fx-depth";

export type Flx4Input =
  | { readonly kind: "button"; readonly control: DeckButton; readonly deck: DeckId; readonly shift: boolean; readonly pressed: boolean }
  | { readonly kind: "button"; readonly control: SharedButton; readonly deck: null; readonly shift: boolean; readonly pressed: boolean }
  /** A pad-mode button: `mode` is the mode it selects (its SHIFT layer is the second mode), `button` which one it is. */
  | { readonly kind: "button"; readonly control: "pad-mode"; readonly deck: DeckId; readonly mode: PadMode; readonly button: PadModeButton; readonly shift: boolean; readonly pressed: boolean }
  /** `pad` is 0-based; `mode` is the pad mode the unit is in, which sets the note. */
  | { readonly kind: "pad"; readonly deck: DeckId; readonly mode: PadMode; readonly pad: number; readonly shift: boolean; readonly pressed: boolean }
  /** `raw` is 0…16383 and `value` 0…1 (bottom, left, or fully counter-clockwise is 0; tempo's "−" end is 0). */
  | { readonly kind: "continuous"; readonly control: ContinuousName; readonly deck: DeckId | null; readonly raw: number; readonly value: number }
  /** Relative: ticks since the last message, clockwise positive. */
  | { readonly kind: "jog-turn"; readonly deck: DeckId; readonly surface: "platter" | "side"; readonly shift: boolean; readonly ticks: number }
  | { readonly kind: "jog-touch"; readonly deck: DeckId; readonly shift: boolean; readonly touched: boolean }
  | { readonly kind: "browse-turn"; readonly shift: boolean; readonly ticks: number }
  | { readonly kind: "fx-channel"; readonly channels: "1" | "2" | "1&2" }
  | { readonly kind: "unknown"; readonly bytes: readonly number[] };

export const FOURTEEN_BIT_MAX = 16383;

const DECK_CHANNELS: Readonly<Record<number, DeckId>> = { 0: "A", 1: "B" };
const MIXER_CHANNEL = 6;
const FX_CHANNELS = [4, 5] as const;
/** Pads: deck A on channel 8 (SHIFT 9), deck B on 10 (SHIFT 11); 0-based here. */
const PAD_CHANNELS: Readonly<Record<number, { deck: DeckId; shift: boolean }>> = {
  7: { deck: "A", shift: false },
  8: { deck: "A", shift: true },
  9: { deck: "B", shift: false },
  10: { deck: "B", shift: true },
};
/** The pad mode is the high nibble of the pad's note; the pad is the low one. */
const PAD_MODES: readonly PadMode[] = ["hot-cue", "pad-fx-1", "beat-jump", "sampler", "keyboard", "pad-fx-2", "beat-loop", "key-shift"];

interface NoteMeaning<Control> {
  readonly control: Control;
  readonly shift: boolean;
}

const DECK_NOTES: ReadonlyMap<number, NoteMeaning<DeckButton>> = new Map([
  [0x0b, { control: "play", shift: false }],
  [0x0e, { control: "play", shift: true }],
  [0x0c, { control: "cue", shift: false }],
  [0x48, { control: "cue", shift: true }],
  [0x3f, { control: "shift", shift: false }],
  [0x58, { control: "sync", shift: false }],
  [0x60, { control: "sync", shift: true }],
  [0x5c, { control: "sync-long", shift: false }],
  [0x54, { control: "headphone-cue", shift: false }],
  [0x68, { control: "headphone-cue", shift: true }],
  [0x10, { control: "loop-in", shift: false }],
  [0x4c, { control: "loop-in", shift: true }],
  [0x11, { control: "loop-out", shift: false }],
  [0x4e, { control: "loop-out", shift: true }],
  [0x4d, { control: "loop-exit", shift: false }],
  [0x50, { control: "loop-exit", shift: true }],
  [0x51, { control: "call-back", shift: false }],
  [0x3e, { control: "call-back", shift: true }],
  [0x53, { control: "call-forward", shift: false }],
  [0x3d, { control: "call-forward", shift: true }],
  [0x66, { control: "fader-start", shift: true }],
  [0x52, { control: "fader-start", shift: true }],
] as const);

const PAD_MODE_NOTES: ReadonlyMap<number, { mode: PadMode; button: PadModeButton; shift: boolean }> = new Map([
  [0x1b, { mode: "hot-cue", button: "hot-cue", shift: false }],
  [0x69, { mode: "keyboard", button: "hot-cue", shift: true }],
  [0x1e, { mode: "pad-fx-1", button: "pad-fx-1", shift: false }],
  [0x6b, { mode: "pad-fx-2", button: "pad-fx-1", shift: true }],
  [0x20, { mode: "beat-jump", button: "beat-jump", shift: false }],
  [0x6d, { mode: "beat-loop", button: "beat-jump", shift: true }],
  [0x22, { mode: "sampler", button: "sampler", shift: false }],
  [0x6f, { mode: "key-shift", button: "sampler", shift: true }],
] as const);

const MIXER_NOTES: ReadonlyMap<number, NoteMeaning<SharedButton | "load-A" | "load-B">> = new Map([
  [0x63, { control: "master-cue", shift: false }],
  [0x78, { control: "master-cue", shift: true }],
  [0x00, { control: "smart-cfx", shift: false }],
  [0x08, { control: "smart-cfx", shift: true }],
  [0x01, { control: "smart-fader", shift: false }],
  [0x09, { control: "smart-fader", shift: true }],
  [0x6d, { control: "mono-stereo", shift: false }],
  [0x41, { control: "browse-press", shift: false }],
  [0x42, { control: "browse-press", shift: true }],
  [0x46, { control: "load-A", shift: false }],
  [0x68, { control: "load-A", shift: true }],
  [0x47, { control: "load-B", shift: false }],
  [0x7a, { control: "load-B", shift: true }],
] as const);

const FX_NOTES: ReadonlyMap<number, NoteMeaning<SharedButton>> = new Map([
  [0x63, { control: "fx-select", shift: false }],
  [0x64, { control: "fx-select", shift: true }],
  [0x4a, { control: "fx-beat-back", shift: false }],
  [0x66, { control: "fx-beat-back", shift: true }],
  [0x4b, { control: "fx-beat-forward", shift: false }],
  [0x6b, { control: "fx-beat-forward", shift: true }],
  [0x47, { control: "fx-on", shift: false }],
  [0x43, { control: "fx-on", shift: true }],
] as const);

/** The FX SELECT notes come only on channel 5; FX ON/OFF on 5 or 6, by the lever's channel. */
const FX_NOTES_ON_CHANNEL_6: ReadonlySet<number> = new Set([0x47, 0x43]);

/** MSB control numbers; each LSB is the same plus 0x20. */
const DECK_CCS: ReadonlyMap<number, ContinuousName> = new Map([
  [0x00, "tempo"],
  [0x04, "trim"],
  [0x07, "eq-high"],
  [0x0b, "eq-mid"],
  [0x0f, "eq-low"],
  [0x13, "channel-fader"],
] as const);

const MIXER_CCS: ReadonlyMap<number, { control: ContinuousName; deck: DeckId | null }> = new Map([
  [0x08, { control: "master-level", deck: null }],
  [0x17, { control: "filter", deck: "A" }],
  [0x18, { control: "filter", deck: "B" }],
  [0x1f, { control: "crossfader", deck: null }],
  [0x05, { control: "mic-level", deck: null }],
  [0x0c, { control: "headphone-mix", deck: null }],
  [0x0d, { control: "headphone-level", deck: null }],
] as const);

const FX_CCS: ReadonlyMap<number, { control: ContinuousName; deck: DeckId | null }> = new Map([[0x02, { control: "beat-fx-depth", deck: null }]] as const);

const JOG_CCS: ReadonlyMap<number, { surface: "platter" | "side"; shift: boolean }> = new Map([
  [0x22, { surface: "platter", shift: false }],
  [0x23, { surface: "platter", shift: false }],
  [0x29, { surface: "platter", shift: true }],
  [0x21, { surface: "side", shift: false }],
] as const);

const LSB_OFFSET = 0x20;
/** Jog: clockwise counts up from 0x41, counter-clockwise down from 0x3F. */
const JOG_CENTRE = 0x40;

export class Flx4Decoder {
  /** Last MSB per "status:cc". */
  private readonly msb = new Map<string, number>();
  /** The CH SELECT lever: notes 94 10 (CH1 part) and 95 11 (CH2 part). */
  private fxChannel1 = false;
  private fxChannel2 = false;
  private lastFxChannels: "1" | "2" | "1&2" | null = null;

  /**
   * What a message means, or null when it only carries part of a value (a 14-bit MSB, a lever note
   * that leaves the lever where it was). Messages the list does not have come back as `unknown`.
   */
  decode(bytes: ArrayLike<number>): Flx4Input | null {
    const data = Array.from(bytes);
    const [status = 0, data1 = -1, data2 = -1] = data;
    const unknown: Flx4Input = { kind: "unknown", bytes: data };
    if (data.length !== 3 || data1 < 0 || data2 < 0) return unknown;
    const type = status & 0xf0;
    const channel = status & 0x0f;
    const decoded =
      type === 0x90 || type === 0x80 ? this.note(channel, data1, type === 0x90 && data2 > 0, data2) : type === 0xb0 ? this.controlChange(status, channel, data1, data2) : undefined;
    return decoded === undefined ? unknown : decoded;
  }

  private note(channel: number, note: number, pressed: boolean, velocity: number): Flx4Input | null | undefined {
    const deck = DECK_CHANNELS[channel];
    if (deck !== undefined) {
      if (note === 0x36 || note === 0x67) return { kind: "jog-touch", deck, shift: note === 0x67, touched: pressed };
      const button = DECK_NOTES.get(note);
      if (button !== undefined) return { kind: "button", control: button.control, deck, shift: button.shift, pressed };
      const mode = PAD_MODE_NOTES.get(note);
      if (mode !== undefined) return { kind: "button", control: "pad-mode", deck, ...mode, pressed };
      return undefined;
    }
    const pads = PAD_CHANNELS[channel];
    if (pads !== undefined) {
      const mode = PAD_MODES[note >> 4];
      const pad = note & 0x0f;
      if (mode === undefined || pad > 7) return undefined;
      return { kind: "pad", deck: pads.deck, mode, pad, shift: pads.shift, pressed };
    }
    if (channel === MIXER_CHANNEL) {
      const meaning = MIXER_NOTES.get(note);
      if (meaning === undefined) return undefined;
      if (meaning.control === "load-A" || meaning.control === "load-B") {
        return { kind: "button", control: "load", deck: meaning.control === "load-A" ? "A" : "B", shift: meaning.shift, pressed };
      }
      return { kind: "button", control: meaning.control, deck: null, shift: meaning.shift, pressed };
    }
    if (channel === FX_CHANNELS[0] || channel === FX_CHANNELS[1]) {
      if (note === 0x10 || note === 0x11) return this.fxLever(channel, note, velocity > 0);
      const meaning = FX_NOTES.get(note);
      if (meaning === undefined || (channel === FX_CHANNELS[1] && !FX_NOTES_ON_CHANNEL_6.has(note))) return undefined;
      return { kind: "button", control: meaning.control, deck: null, shift: meaning.shift, pressed };
    }
    return undefined;
  }

  private fxLever(channel: number, note: number, on: boolean): Flx4Input | null {
    if (channel === FX_CHANNELS[0] && note === 0x10) this.fxChannel1 = on;
    else if (channel === FX_CHANNELS[1] && note === 0x11) this.fxChannel2 = on;
    // 94 11 and 95 10 are always 00 in the list: they carry no position.
    const channels = this.fxChannel1 && this.fxChannel2 ? "1&2" : this.fxChannel1 ? "1" : this.fxChannel2 ? "2" : null;
    if (channels === null || channels === this.lastFxChannels) return null;
    this.lastFxChannels = channels;
    return { kind: "fx-channel", channels };
  }

  private controlChange(status: number, channel: number, cc: number, value: number): Flx4Input | null | undefined {
    const deck = DECK_CHANNELS[channel];
    if (deck !== undefined) {
      const jog = JOG_CCS.get(cc);
      if (jog !== undefined) return { kind: "jog-turn", deck, surface: jog.surface, shift: jog.shift, ticks: value - JOG_CENTRE };
      return this.fourteenBit(status, cc, value, (msbCc) => {
        const control = DECK_CCS.get(msbCc);
        return control === undefined ? undefined : { control, deck };
      });
    }
    if (channel === MIXER_CHANNEL) {
      if (cc === 0x40 || cc === 0x64) return { kind: "browse-turn", shift: cc === 0x64, ticks: value >= 0x40 ? value - 0x80 : value };
      return this.fourteenBit(status, cc, value, (msbCc) => MIXER_CCS.get(msbCc));
    }
    if (channel === FX_CHANNELS[0]) return this.fourteenBit(status, cc, value, (msbCc) => FX_CCS.get(msbCc));
    return undefined;
  }

  private fourteenBit(
    status: number,
    cc: number,
    value: number,
    lookup: (msbCc: number) => { control: ContinuousName; deck: DeckId | null } | undefined,
  ): Flx4Input | null | undefined {
    if (lookup(cc) !== undefined) {
      this.msb.set(`${String(status)}:${String(cc)}`, value);
      return null;
    }
    const meaning = lookup(cc - LSB_OFFSET);
    if (meaning === undefined) return undefined;
    const msb = this.msb.get(`${String(status)}:${String(cc - LSB_OFFSET)}`) ?? 0;
    const raw = (msb << 7) | value;
    return { kind: "continuous", control: meaning.control, deck: meaning.deck, raw, value: raw / FOURTEEN_BIT_MAX };
  }
}

/**
 * The physical control an input came from, the same for every layer and value: "A.play" for PLAY with
 * or without SHIFT, "A.jog" for the platter, its touch and the wheel side. Null for messages that are
 * no control's own (fader start, unknown, a 14-bit MSB).
 */
export function physicalControlOf(input: Flx4Input): string | null {
  switch (input.kind) {
    case "button":
      if (input.control === "fader-start") return null;
      if (input.control === "pad-mode") return `${input.deck}.pad-mode-${input.button}`;
      if (input.control === "sync-long") return `${input.deck}.sync`;
      if (input.control === "browse-press") return "browse";
      return input.deck === null ? input.control : `${input.deck}.${input.control}`;
    case "pad":
      return `${input.deck}.pad-${String(input.pad + 1)}`;
    case "continuous":
      return input.deck === null ? input.control : `${input.deck}.${input.control}`;
    case "jog-turn":
    case "jog-touch":
      return `${input.deck}.jog`;
    case "browse-turn":
      return "browse";
    case "fx-channel":
      return "fx-channel";
    case "unknown":
      return null;
  }
}
