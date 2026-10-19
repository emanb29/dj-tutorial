// Lesson 6 (Set a cue point by ear) practice: a target that narrows to the Check's tolerance.
// ±40 ms, then ±30, then the Check's ±20. Two hits in a row at a rung move down one; two misses in a
// row move back up one. Practice is done after two hits in a row at ±20. Pure: the runtime keeps one
// `CueLadder` in the practice phase and the screen reads its lines.
import { CUE_PLACEMENT_TOLERANCE_MS, type CuePlacement } from "@checks";

/** The targets, widest first. The last is the Check's own tolerance. */
export const CUE_LADDER_TARGETS_MS: readonly number[] = [40, 30, CUE_PLACEMENT_TOLERANCE_MS];
/** Hits (or misses) in a row that move one rung. */
export const CUE_LADDER_STREAK = 2;

export type CueLean = "late" | "early";

export interface CueRep {
  readonly placement: CuePlacement;
  /** The target this cue was judged against (± ms). */
  readonly targetMs: number;
  readonly hit: boolean;
}

export interface CueLadder {
  /** Index into `CUE_LADDER_TARGETS_MS`. */
  readonly rung: number;
  /** Hits in a row at this rung. */
  readonly hits: number;
  /** Misses in a row at this rung. */
  readonly misses: number;
  /** Two hits in a row at the last rung. It stays done. */
  readonly complete: boolean;
  readonly last: CueRep | null;
  /** Which way the last misses leaned, oldest first, at most 2. `null`: not on the 1, so no lean. */
  readonly missLeans: readonly (CueLean | null)[];
}

export const CUE_LADDER_START: CueLadder = { rung: 0, hits: 0, misses: 0, complete: false, last: null, missLeans: [] };

const LAST_RUNG = CUE_LADDER_TARGETS_MS.length - 1;

export function cueLadderTargetMs(ladder: CueLadder): number {
  // The rung is always kept in range by `stepCueLadder`.
  return CUE_LADDER_TARGETS_MS[ladder.rung] ?? CUE_PLACEMENT_TOLERANCE_MS;
}

/** A hit: on the 1 and within the target, as the Check judges at ±20 (`<=`). */
export function isCueHit(placement: CuePlacement, targetMs: number): boolean {
  return placement.downbeat && Math.abs(placement.signedMs) <= targetMs;
}

/** One cue point set: judged at the current target, then the ladder moves. */
export function stepCueLadder(ladder: CueLadder, placement: CuePlacement): CueLadder {
  const targetMs = cueLadderTargetMs(ladder);
  const hit = isCueHit(placement, targetMs);
  const last: CueRep = { placement, targetMs, hit };
  if (hit) {
    const hits = ladder.hits + 1;
    if (hits < CUE_LADDER_STREAK) return { ...ladder, hits, misses: 0, last };
    if (ladder.rung === LAST_RUNG) return { ...ladder, hits, misses: 0, complete: true, last };
    return { ...ladder, rung: ladder.rung + 1, hits: 0, misses: 0, last };
  }
  const lean: CueLean | null = placement.downbeat ? (placement.signedMs > 0 ? "late" : "early") : null;
  const missLeans = [...ladder.missLeans, lean].slice(-CUE_LADDER_STREAK);
  const misses = ladder.misses + 1;
  if (misses < CUE_LADDER_STREAK) return { ...ladder, hits: 0, misses, last, missLeans };
  return { ...ladder, rung: Math.max(0, ladder.rung - 1), hits: 0, misses: 0, last, missLeans };
}

/** The caption's target: "Target ±30 ms · 1 of 2". */
export function cueTargetLine(ladder: CueLadder): string {
  return `Target ±${String(cueLadderTargetMs(ladder))} ms · ${String(ladder.hits)} of ${String(CUE_LADDER_STREAK)}`;
}

/** The last cue, at once: "Cue: 34 ms late", "Cue: 8 ms early ✓", "Cue: on beat 3, not the 1". */
export function cueRepLine(rep: CueRep): string {
  const { placement } = rep;
  if (!placement.downbeat) return `Cue: on beat ${String(placement.beatOfBar)}, not the 1`;
  const ms = Math.round(Math.abs(placement.signedMs));
  const offset = ms === 0 ? "on the beat" : `${String(ms)} ms ${placement.signedMs > 0 ? "late" : "early"}`;
  return `Cue: ${offset}${rep.hit ? " ✓" : ""}`;
}

export const LATE_HINT = "Late? Scrub slower over the last few ticks; stop just before the thump.";
export const EARLY_HINT = "Early? Nudge forward a tick or two.";

/** Right after a miss, when the last two misses leaned the same way: one line on which way to fix it. */
export function cueMissHint(ladder: CueLadder): string | null {
  if (ladder.last === null || ladder.last.hit || ladder.missLeans.length < CUE_LADDER_STREAK) return null;
  if (ladder.missLeans.every((lean) => lean === "late")) return LATE_HINT;
  if (ladder.missLeans.every((lean) => lean === "early")) return EARLY_HINT;
  return null;
}
