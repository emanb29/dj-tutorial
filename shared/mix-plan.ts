// The Mix Plan (the Mix Editor's saved set): tracks in play order and one Transition between each
// neighbouring pair. It stores musical intent only, lanes of keyframes in beats, never controller
// moves: the Execution plan and Complexity rating are derived from it and never saved, so changing
// the derivation needs no migration. It stores each track's content hash, name and length, never
// audio or a path (src/app/mix-plans/resolve.ts finds the file again on this device).
//
// The schemas check shape (a plan file is untrusted input); mix-plan-validate.ts checks meaning, with
// every problem and its fix. Reading a stored or uploaded plan goes through mix-plan-file.ts, which
// migrates older versions first.
import { z } from "zod";
import { IsoTimeSchema } from "./check-types.ts";

/** The schema version. A change to the stored shape bumps it and adds a migration (mix-plan-file.ts). */
export const MIX_PLAN_VERSION = 1;

export const BEATS_PER_BAR = 4;
export const BARS_PER_PHRASE = 8;
export const BEATS_PER_PHRASE = BEATS_PER_BAR * BARS_PER_PHRASE;

/**
 * One sound parameter of one track:
 * - `volume`: the track's level in the mix, 0…1 (channel fader and crossfader, merged);
 * - `eq-low`, `eq-mid`, `eq-high`, `filter`: −1…1 as on the mixer (0 is flat, −1 a kill, filter −1 low-pass, +1 high-pass);
 * - `tempo`: the track's BPM (matched to the outgoing track unless a ride is drawn);
 * - `echo-send`: 0…1 wet, with the echo's length in `Lane.echoBeats`;
 * - `loop`: 0 off, 1 on, with the loop's length in `Lane.loopBeats` ("hold this bar").
 */
export const LANE_PARAMS = ["volume", "eq-low", "eq-mid", "eq-high", "filter", "tempo", "echo-send", "loop"] as const;
export type LaneParam = (typeof LANE_PARAMS)[number];

/** The range of each lane's values. Tempo is wide on purpose: the design is never limited by the tempo fader. */
export const CONTROL_RANGES: Readonly<Record<LaneParam, { readonly min: number; readonly max: number }>> = {
  volume: { min: 0, max: 1 },
  "eq-low": { min: -1, max: 1 },
  "eq-mid": { min: -1, max: 1 },
  "eq-high": { min: -1, max: 1 },
  filter: { min: -1, max: 1 },
  tempo: { min: 40, max: 240 },
  "echo-send": { min: 0, max: 1 },
  loop: { min: 0, max: 1 },
};

/** The echo lengths, in beats: BEAT ◀/▶'s steps (src/audio/beat-fx.ts BEAT_FX_BEATS; a test keeps them equal). */
export const ECHO_BEATS: readonly number[] = [0.125, 0.25, 0.5, 0.75, 1, 2, 4];
/** The loop lengths, in beats. */
export const LOOP_BEATS: readonly number[] = [0.25, 0.5, 1, 2, 4, 8, 16, 32];
/** A track's level match, dB: the trim knob's span (src/lessons/track.ts trimKnobFor). */
export const GAIN_DB_RANGE = { min: -24, max: 9 } as const;

/**
 * The ready-made Transitions (mix-plan-recipes.ts). Crossfades are named by their length in bars; a
 * 16-bar crossfade is the long blend. Adding one is not a migration: older plans stay valid.
 */
export const RECIPE_IDS = ["crossfade-8", "crossfade-16", "crossfade-32", "bass-swap", "cut-on-the-1", "filter-sweep", "echo-out", "loop-to-extend", "tempo-ride"] as const;
export type RecipeId = (typeof RECIPE_IDS)[number];

const finite = z.number().refine(Number.isFinite, { message: "Must be a finite number." });

/** A position on one track's beat grid, 1-based as the captions say: bar 1 starts at the first downbeat. */
export const GridPosSchema = z.strictObject({
  bar: z.int().min(1),
  beat: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
});
export type GridPos = z.infer<typeof GridPosSchema>;

export const KeyframeSchema = z.strictObject({
  /** Beats from the Transition's `outgoingAt`; fractions are allowed (0.5 is an eighth note). */
  beat: finite,
  /** In the lane's range (CONTROL_RANGES). */
  value: finite,
  /** How the lane reaches this value from the one before. */
  curve: z.enum(["jump", "linear", "ease"]),
});
export type Keyframe = z.infer<typeof KeyframeSchema>;

export const LaneSchema = z.strictObject({
  track: z.enum(["outgoing", "incoming"]),
  param: z.enum(LANE_PARAMS),
  /** In beat order. Before the first one the lane holds its resting value (`restingValue`), and between them the last value. */
  keyframes: z.array(KeyframeSchema),
  echoBeats: finite.optional(),
  loopBeats: finite.optional(),
});
export type Lane = z.infer<typeof LaneSchema>;

export const TransitionSchema = z.strictObject({
  recipe: z.union([z.enum(RECIPE_IDS), z.literal("custom")]),
  /** On the outgoing track: where the Transition starts (a phrase start by default). */
  outgoingAt: GridPosSchema,
  /** On the incoming track: what is heard at that moment. */
  incomingAt: GridPosSchema,
  /** The span from `outgoingAt`, in beats. The incoming track is tempo-matched, so it covers as many of its own beats. */
  lengthBeats: finite,
  lanes: z.array(LaneSchema).max(32),
});
export type Transition = z.infer<typeof TransitionSchema>;

export const PlanTrackSchema = z.strictObject({
  /** shared/track-hash.ts: the key the analysis cache uses. */
  contentHash: z.string().regex(/^[0-9a-f]{64}$/, { message: "A content hash is 64 lower-case hex digits (shared/track-hash.ts)." }),
  source: z.literal("local"),
  /** For display and for finding the file again; never a path. */
  fileName: z.string().min(1).max(255),
  durationMs: z.int().positive(),
  title: z.string().max(300).optional(),
  artist: z.string().max(300).optional(),
  /** Which beat grid (`gridHashOf`) the plan's positions on this track refer to. */
  gridHash: z.string().min(1).max(64),
  /** Where the track starts: the set's start for the first track, the cue set up front for the others. */
  startAt: GridPosSchema,
  /** The level match, dB (what TRIM does). */
  gainDb: finite,
});
export type PlanTrack = z.infer<typeof PlanTrackSchema>;

/** The shape of a version-1 plan. Bounded so an uploaded file cannot be huge: plans are kilobytes. */
export const MixPlanSchema = z.strictObject({
  id: z.string().min(1).max(64),
  name: z.string().max(120),
  /** Wall-clock metadata only; never compared with audio time. */
  createdAt: IsoTimeSchema,
  updatedAt: IsoTimeSchema,
  version: z.literal(MIX_PLAN_VERSION),
  tracks: z.array(PlanTrackSchema).max(500),
  /** `transitions[i]` hands `tracks[i]` over to `tracks[i + 1]`. */
  transitions: z.array(TransitionSchema).max(499),
});
export type MixPlan = z.infer<typeof MixPlanSchema>;

/** A lane's value before its first keyframe: the outgoing track playing at full, the incoming one silent, everything else flat. */
export function restingValue(track: Lane["track"], param: Exclude<LaneParam, "tempo">): number {
  return param === "volume" && track === "outgoing" ? 1 : 0;
}

// --- Grid positions ---

/** The parts of a beat grid the plan needs: TrackAnalysis's (src/analysis/types.ts), or a known grid's. */
export interface PlanGrid {
  readonly bpm: number;
  /** First grid beat, seconds. */
  readonly firstBeatSec: number;
  /** Index (0–3) of bar 1 among the grid beats; null (no downbeats found) counts from the first beat. */
  readonly downbeatPhase: number | null;
  readonly durationSec: number;
}

/** Beats from bar 1, beat 1 (0) to `pos`. */
export function beatIndexOf(pos: GridPos): number {
  return (pos.bar - 1) * BEATS_PER_BAR + (pos.beat - 1);
}

/** The position of the beat at or before `beatIndex` (beats from bar 1, beat 1; 0 or more). */
export function gridPosAt(beatIndex: number): GridPos {
  const whole = Math.max(0, Math.floor(beatIndex + 1e-9));
  return { bar: Math.floor(whole / BEATS_PER_BAR) + 1, beat: ((whole % BEATS_PER_BAR) + 1) as GridPos["beat"] };
}

/** `pos` moved by a whole number of beats (never before bar 1, beat 1). */
export function addBeats(pos: GridPos, beats: number): GridPos {
  return gridPosAt(beatIndexOf(pos) + beats);
}

/** Where bar 1 starts in the track, seconds (as src/analysis/phrases.ts counts it). */
export function bar1Sec(grid: PlanGrid): number {
  return grid.firstBeatSec + (grid.downbeatPhase ?? 0) * (60 / grid.bpm);
}

/** The track time of a beat counted from bar 1, beat 1 (fractions allowed), at the track's own tempo. */
export function secondsAtBeat(grid: PlanGrid, beatIndex: number): number {
  return bar1Sec(grid) + (beatIndex * 60) / grid.bpm;
}

/** How many beats there are from bar 1, beat 1 to the end of the track (fractional). */
export function beatsInTrack(grid: PlanGrid): number {
  return ((grid.durationSec - bar1Sec(grid)) * grid.bpm) / 60;
}

/** The 1-based phrase (8 bars) a position is in, and the bar within it. */
export function phraseOf(pos: GridPos): { readonly phrase: number; readonly barInPhrase: number } {
  return { phrase: Math.floor((pos.bar - 1) / BARS_PER_PHRASE) + 1, barInPhrase: ((pos.bar - 1) % BARS_PER_PHRASE) + 1 };
}

/** Where phrase `phrase` (1-based) starts. */
export function phraseStart(phrase: number): GridPos {
  return { bar: (phrase - 1) * BARS_PER_PHRASE + 1, beat: 1 };
}

/** The last phrase start from which `lengthBeats` still fit before the track ends; null when none does. */
export function lastPhraseStartFitting(grid: PlanGrid, lengthBeats: number): GridPos | null {
  const phrases = Math.floor((beatsInTrack(grid) - lengthBeats) / BEATS_PER_PHRASE + 1e-9);
  return phrases < 0 ? null : phraseStart(phrases + 1);
}

/**
 * Names one beat grid, so a plan can tell when a track was re-analysed and its positions may have
 * moved. Rounded (0.1 ms, 0.0001 BPM) so the same grid always gives the same name. FNV-1a, not a
 * security hash: it only tells grids apart.
 */
export function gridHashOf(grid: PlanGrid): string {
  const text = `bpm=${grid.bpm.toFixed(4)}|first=${grid.firstBeatSec.toFixed(4)}|downbeat=${String(grid.downbeatPhase ?? 0)}`;
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `grid1-${hash.toString(16).padStart(8, "0")}`;
}
