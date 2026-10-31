// rekordbox's beat grid (TEMPO elements, xml.ts) as the app's. The app's decks and Checks grade on a
// constant-tempo 4/4 grid (bpm, first beat, which beat is bar 1), so:
// - TEMPOs that carry on one grid (same BPM, each on a beat of the one before) are that grid;
// - a grid whose tempo changes (a live drummer, an old record) is "variable": the app keeps its own
//   analysis for grading and uses rekordbox's BPM only to list the track;
// - a meter other than 4/4 is not used.
// Inizio is a beat's time in seconds and Battito its number in the bar (1 = bar start): see xml.ts
// for the sources.
import type { KnownBeatGrid } from "../types.ts";
import type { RekordboxTempo } from "./xml.ts";

const BEATS_PER_BAR = 4;
/** The analysis's own rule (src/analysis/types.ts): the first grid beat is at or after -50 ms. */
const EARLIEST_BEAT_SEC = -0.05;
/** How close a later TEMPO must sit on the earlier grid to be the same grid. */
const SAME_GRID_SEC = 0.002;
const SAME_BPM = 0.01;
/** A deck's beat list stops here (about 2 h 45 min at 120 BPM), whatever the file claims. */
const MAX_BEATS = 20_000;

export type RekordboxGrid =
  | { readonly kind: "constant"; readonly bpm: number; readonly firstBeatSec: number; readonly downbeatPhase: number }
  | { readonly kind: "variable"; readonly segments: number; readonly bpmRange: readonly [number, number] }
  | { readonly kind: "not-four-four"; readonly metro: string }
  | { readonly kind: "none" };

const modulo = (value: number, by: number) => ((value % by) + by) % by;

/** Whether `next` lies on `previous`'s grid: same BPM, on one of its beats, with the beat number that beat has. */
function continues(previous: RekordboxTempo, next: RekordboxTempo): boolean {
  if (Math.abs(previous.bpm - next.bpm) > SAME_BPM) return false;
  const beat = 60 / previous.bpm;
  const beats = Math.round((next.inizioSec - previous.inizioSec) / beat);
  if (Math.abs(next.inizioSec - (previous.inizioSec + beats * beat)) > SAME_GRID_SEC) return false;
  return modulo(previous.battito - 1 + beats, BEATS_PER_BAR) + 1 === next.battito;
}

export function rekordboxGrid(tempos: readonly RekordboxTempo[]): RekordboxGrid {
  const first = tempos[0];
  if (first === undefined) return { kind: "none" };
  const odd = tempos.find((tempo) => tempo.metro !== "4/4");
  if (odd !== undefined) return { kind: "not-four-four", metro: odd.metro };
  const oneGrid = tempos.every((tempo, index) => index === 0 || continues(tempos[index - 1] ?? tempo, tempo));
  if (!oneGrid) {
    const bpms = tempos.map((tempo) => tempo.bpm);
    return { kind: "variable", segments: tempos.length, bpmRange: [Math.min(...bpms), Math.max(...bpms)] };
  }
  const beat = 60 / first.bpm;
  const back = Math.floor((first.inizioSec - EARLIEST_BEAT_SEC) / beat);
  const firstBeatSec = first.inizioSec - back * beat;
  const firstBattito = modulo(first.battito - 1 - back, BEATS_PER_BAR) + 1;
  return { kind: "constant", bpm: first.bpm, firstBeatSec, downbeatPhase: modulo(1 - firstBattito, BEATS_PER_BAR) };
}

/** Every beat of a rekordbox grid, variable or not, from the first at or after -50 ms to `durationSec`. */
export function rekordboxBeatTimes(tempos: readonly RekordboxTempo[], durationSec: number): number[] {
  const beats: number[] = [];
  tempos.forEach((tempo, index) => {
    const beat = 60 / tempo.bpm;
    const from = index === 0 ? tempo.inizioSec - Math.floor((tempo.inizioSec - EARLIEST_BEAT_SEC) / beat) * beat : tempo.inizioSec;
    const until = Math.min(durationSec, tempos[index + 1]?.inizioSec ?? durationSec);
    for (let count = 0; from + count * beat < until - 1e-9 && beats.length < MAX_BEATS; count += 1) beats.push(from + count * beat);
  });
  return beats;
}

/** A constant rekordbox grid as the grid a deck loads (Originals use the same shape). */
export function knownGridFromRekordbox(grid: Extract<RekordboxGrid, { kind: "constant" }>, durationSec: number): KnownBeatGrid {
  const tempo: RekordboxTempo = { inizioSec: grid.firstBeatSec, bpm: grid.bpm, metro: "4/4", battito: 1 };
  return {
    origin: "rekordbox",
    bpm: grid.bpm,
    durationSec,
    firstBeatSec: grid.firstBeatSec,
    downbeatPhase: grid.downbeatPhase,
    beatGrid: rekordboxBeatTimes([tempo], durationSec).map((beat) => Number(beat.toFixed(9))),
    phrases: [],
  };
}

/** Camelot numbers of the major keys (B) by pitch class from C; a minor key has its relative major's number (A). */
const MAJOR_CAMELOT = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1] as const;
const PITCH: Readonly<Record<string, number>> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/**
 * rekordbox's Tonality as a Camelot key ("8A"), whichever notation the Learner's rekordbox shows:
 * Camelot already ("8A"), or a classical key ("Am", "F#m", "Db"). Null when it is neither.
 */
export function camelotFromTonality(tonality: string): string | null {
  const trimmed = tonality.trim();
  const camelot = /^0?(1[0-2]|[1-9])\s*([AaBb])$/.exec(trimmed);
  if (camelot !== null) return `${camelot[1] ?? ""}${(camelot[2] ?? "").toUpperCase()}`;
  const classical = /^([A-Ga-g])\s*([#♯b♭]?)\s*(m|min|minor|maj|major)?$/.exec(trimmed);
  if (classical === null) return null;
  const letter = PITCH[(classical[1] ?? "").toUpperCase()];
  if (letter === undefined) return null;
  const accidental = classical[2] === "#" || classical[2] === "♯" ? 1 : classical[2] === "b" || classical[2] === "♭" ? -1 : 0;
  const minor = classical[3] === "m" || classical[3] === "min" || classical[3] === "minor";
  const pitch = modulo(letter + accidental, 12);
  // A minor key shares its Camelot number with the major key 3 semitones above it (Am and C are 8).
  const number = MAJOR_CAMELOT[minor ? modulo(pitch + 3, 12) : pitch];
  return number === undefined ? null : `${String(number)}${minor ? "A" : "B"}`;
}
