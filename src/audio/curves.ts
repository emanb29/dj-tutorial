// Pure control curves: how a knob or fader position becomes a gain, a dB value or a filter setting.
// The channel-fader and crossfader curves are owned by shared/attempt.ts, so the engine and the Checks
// cannot disagree; this module only turns them into gains.

import { channelFaderGainDb, crossfaderGainDb, GAIN_FLOOR_DB, type DeckId } from "@shared/attempt.ts";

/** A centred knob: -1 is fully left, 0 is the centre detent, +1 is fully right. */
export type CentredKnob = number;
/** A fader or one-sided knob: 0 is the bottom, 1 is the top. */
export type FaderPosition = number;


export function decibelsToGain(decibels: number): number {
  return decibels === Number.NEGATIVE_INFINITY ? 0 : 10 ** (decibels / 20);
}

export function gainToDecibels(gain: number): number {
  return gain === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(gain);
}

/** A level knob that is silent fully left, 0 dB in the centre and `maxBoostDb` fully right. */
function levelKnobToDecibels(knob: CentredKnob, cutJustBeforeSilenceDb: number, maxBoostDb: number): number {
  if (knob <= -1) return Number.NEGATIVE_INFINITY;
  return knob >= 0 ? knob * maxBoostDb : -knob * cutJustBeforeSilenceDb;
}

/** Isolator EQ band (DDJ-FLX4 style): kill fully left, -26 dB just before it, +6 dB fully right. */
export function eqKnobToDecibels(knob: CentredKnob): number {
  return levelKnobToDecibels(knob, -26, 6);
}

/** Channel trim: silent fully left, -24 dB just before it, +9 dB fully right. */
export function trimKnobToDecibels(knob: CentredKnob): number {
  return levelKnobToDecibels(knob, -24, 9);
}

/** Master level: silent fully left, -24 dB just before it, +6 dB fully right. */
export function masterKnobToDecibels(knob: CentredKnob): number {
  return levelKnobToDecibels(knob, -24, 6);
}

/**
 * Headphone LEVEL, 0…1: silent at 0, a fader-like curve up to unity at the centre (0.25 is about −12 dB),
 * then up to +6 dB at the top.
 */
export function headphoneLevelToDecibels(level: FaderPosition): number {
  if (level <= 0) return Number.NEGATIVE_INFINITY;
  return level <= 0.5 ? 40 * Math.log10(2 * level) : 6 * (2 * level - 1);
}

/** Channel fader gain (amplitude), from the curve the Checks use: amplitude = position². */
export function channelFaderGain(position: FaderPosition): number {
  return decibelsToGain(channelFaderGainDb(position));
}

/**
 * Crossfader gain (amplitude) for one deck, from the curve the Checks use. Position is 0 (full A) … 1
 * (full B): each deck is at unity from its own side to the centre, then fades linearly to the far side.
 */
export function crossfaderGain(deck: DeckId, position: FaderPosition): number {
  return decibelsToGain(crossfaderGainDb(deck, position));
}

/** dB for the attempt timeline: silence becomes the contract's gain floor so values stay finite. */
export function toTimelineDecibels(decibels: number): number {
  return Math.max(GAIN_FLOOR_DB, decibels);
}

export type FilterSettings =
  | { kind: "off" }
  | { kind: "lowpass" | "highpass"; cutoffHz: number; resonanceDb: number };

/** Knob positions this close to the centre leave the filter off. */
export const FILTER_DEAD_ZONE = 0.02;
const LOWPASS_OPEN_HZ = 20_000;
const LOWPASS_CLOSED_HZ = 100;
const HIGHPASS_OPEN_HZ = 20;
const HIGHPASS_CLOSED_HZ = 10_000;
/** A little resonance at the cutoff, as on DJ mixer filters (Web Audio takes Q in dB for these types). */
const FILTER_RESONANCE_DB = 1;

/** Filter knob: off at the centre, low-pass to the left, high-pass to the right, swept exponentially. */
export function filterKnobSettings(knob: CentredKnob): FilterSettings {
  const amount = Math.abs(knob);
  if (amount < FILTER_DEAD_ZONE) return { kind: "off" };
  return knob < 0
    ? { kind: "lowpass", cutoffHz: sweep(LOWPASS_OPEN_HZ, LOWPASS_CLOSED_HZ, amount), resonanceDb: FILTER_RESONANCE_DB }
    : { kind: "highpass", cutoffHz: sweep(HIGHPASS_OPEN_HZ, HIGHPASS_CLOSED_HZ, amount), resonanceDb: FILTER_RESONANCE_DB };
}

function sweep(fromHz: number, toHz: number, amount: number): number {
  return fromHz * (toHz / fromHz) ** amount;
}
