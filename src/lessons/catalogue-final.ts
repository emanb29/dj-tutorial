// Lesson 20, `final-mix` (docs/lesson-catalogue.md §1 and "Final project"; check-design §5): the
// Learner's own set, recorded as the final project. Unlike Lessons 1–19 it has no fixed track or
// plan: the Learner builds a set of 3+ tracks, warms up with a free transition, then plays the set by
// ear while the master is recorded. This file holds the pure parts: the set rules and the set
// builder's warnings, track prep, the grading window and spec, and the result wording.
import type { Aids, Attempt, CheckMode, CtxSpan, LessonId, SetTrack, TaskSpec, TaskTrack } from "@shared/attempt.ts";
import type { CheckResult, CriterionId, CriterionResult } from "@shared/check-result.ts";
import type { SkillProfile } from "@shared/skill-profile.ts";
import { LESSONS, type BuiltLesson } from "./catalogue.ts";
import { barsSec } from "./plan.ts";
import type { SyntheticLayout } from "./synthetic-track.ts";
import type { ControlId, HookStep, LessonTrack } from "./types.ts";

/** The set's rules (check-design §5.1). The Check grades them; the set builder checks them first. */
export const SET_RULES = {
  minTracks: 3,
  /** More tracks than this is a long set: the recording and the profile notes stay bounded. */
  maxTracks: 8,
  maxTempoApart: 0.02,
  minBarsEach: 16,
  /** `grid-trust`: a track whose grid fit is worse is refused in prep. */
  maxGridResidualMs: 15,
  /** The set (and its recording) stops by itself after this. */
  maxSetSec: 30 * 60,
} as const;

/** Exam conditions: no sync or quantize, the BPM displays and the phase meter covered, no Lesson text. */
export const FINAL_MIX_AIDS: Aids = { sync: false, quantize: false, bpmDisplay: false, phaseMeter: false, lessonText: false };

/** Genres the set builder offers as tags (any source genre is kept as well). */
export const SET_GENRES = ["house", "techno", "bass music", "other"] as const;

export interface SetLessonDefinition {
  readonly id: "final-mix";
  readonly title: string;
  /** Controls the set covers, over everything earlier Lessons unlocked. */
  readonly lockedOff: readonly ControlId[];
  /** The warm-up: one transition, nothing counts. Captions only; the Learner moves on with Start the set. */
  readonly warmUp: readonly Pick<HookStep, "caption" | "control">[];
  readonly checkCaption: string;
  readonly tips: Readonly<Partial<Record<CriterionId, readonly string[]>>>;
}

export const FINAL_MIX: SetLessonDefinition = {
  id: "final-mix",
  title: "Your first set",
  lockedOff: ["A.sync", "B.sync", "A.bpm", "B.bpm", "phase-meter"],
  warmUp: [
    { caption: "Warm up: Press X to play track 1", control: "A.play" },
    { caption: "Cue track 2 in your headphones (CUE 🎧 B)", control: "B.headphone-cue" },
    { caption: "Bring it in on a phrase's 1. Nothing counts yet", control: "B.play" },
  ],
  checkCaption: "This one counts: your set, by ear. End set when the music stops",
  tips: {
    "final-mix.track-count": ["Play every track for at least 2 phrases (16 bars)."],
    "final-mix.technique": ["Mix it up: at least one long blend and one cut."],
    "final-mix.tempo-range": ["Pick tracks within 2% of the first one's BPM."],
    "final-mix.one-genre": ["Keep the set to one genre."],
    "standing.on-phrase": ["Start each new track on the 1 of a phrase: count the 8 bars."],
    "standing.drift": ["Ride the tempo fader in small steps; nudge the jog to pull it back."],
    "standing.level-match": ["Match the channel meters with TRIM before each handover."],
    "standing.no-dead-air": ["Have the next track cued before the last one ends."],
  },
};

/** Every Lesson the list shows, in catalogue order: the built Lessons, then the set. */
export type CourseLessonId = BuiltLesson["id"] | "final-mix";
export const COURSE: readonly { readonly id: CourseLessonId; readonly title: string }[] = [...LESSONS, FINAL_MIX];

// ---------------------------------------------------------------------------------------------
// The set builder
// ---------------------------------------------------------------------------------------------

/** The synthetic library (`?track=synthetic`, and end-to-end tests): grooves with a steady main section. */
const SET_GROOVE = (bpm: number, id: string, title: string, padHz: readonly number[]): SyntheticLayout => ({
  bpm,
  sections: [
    { name: "intro", bars: 8, layers: ["kick", "hat", "bass"] },
    { name: "main", bars: 40, layers: ["kick", "hat", "bass", "pad"] },
    { name: "outro", bars: 8, layers: ["kick", "hat", "bass"] },
  ],
  tailSec: 1,
  peakDbfs: -6,
  padHz,
  id,
  title,
});

export const SYNTHETIC_SET: readonly { readonly layout: SyntheticLayout; readonly camelot: string }[] = [
  { layout: SET_GROOVE(123, "synthetic/set-123", "Set Groove C (synthetic)", [261.63, 329.63, 392]), camelot: "8B" },
  { layout: SET_GROOVE(124, "synthetic/set-124a", "Set Groove Am (synthetic)", [220, 261.63, 329.63]), camelot: "8A" },
  { layout: SET_GROOVE(124, "synthetic/set-124e", "Set Groove Em (synthetic)", [164.81, 196, 246.94]), camelot: "9A" },
  { layout: SET_GROOVE(120, "synthetic/set-120", "Set Groove G (synthetic)", [196, 246.94, 293.66]), camelot: "9B" },
];

/** A library track the Learner can put in a set: a Lesson track, plus what the builder shows. */
export interface SetCandidate {
  readonly track: LessonTrack;
  readonly artist: string;
  /** The source's genre, lower case; null when it has none (a local file). */
  readonly genre: string | null;
  /** Camelot key ("8A"), when the source knows it. */
  readonly camelot: string | null;
  /** May a recording with this track be shared (licence)? */
  readonly shareable: boolean;
}

/** A track as picked into the set, after prep. */
export interface SetEntry {
  readonly candidate: SetCandidate;
  /** The genre tag (prep may set one for a file without a genre). */
  readonly genre: string | null;
  /** Track prep: whole bars the phrase anchor is moved later (0–7), for a file whose bar 1 is a hint. */
  readonly phraseShiftBars: number;
}

export function setEntry(candidate: SetCandidate): SetEntry {
  return { candidate, genre: candidate.genre, phraseShiftBars: 0 };
}

/** "8A", "8A (A minor)", "08b" → "8A"; anything else → null. */
export function camelotOf(text: string | null | undefined): string | null {
  const match = /^\s*0?(1[0-2]|[1-9])\s*([AaBb])\b/.exec(text ?? "");
  return match === null ? null : `${match[1] ?? ""}${(match[2] ?? "").toUpperCase()}`;
}

/** Harmonic mixing's safe moves: the same key, ±1 on the wheel, or the relative major/minor. */
export function keysCompatible(first: string, second: string): boolean {
  const parse = (key: string) => ({ number: Number(key.slice(0, -1)), letter: key.slice(-1) });
  const a = parse(first);
  const b = parse(second);
  const step = Math.min((a.number - b.number + 12) % 12, (b.number - a.number + 12) % 12);
  return (a.letter === b.letter && step <= 1) || (a.number === b.number);
}

export type SetWarning =
  | { readonly kind: "tempo"; readonly index: number; readonly apartPercent: number }
  | { readonly kind: "key"; readonly index: number; readonly from: string; readonly to: string };

export interface SetProblems {
  /** Reasons the set cannot start, each with the fix. */
  readonly blocking: readonly string[];
  /** Allowed, but the Learner should know (a tempo gap fails the Check; a key clash only sounds rough). */
  readonly warnings: readonly SetWarning[];
}

const tag = (genre: string | null) => (genre ?? "").trim().toLowerCase();

/** Everything wrong with a set, all at once. */
export function setProblems(entries: readonly SetEntry[]): SetProblems {
  const genres = new Set(entries.map((entry) => tag(entry.genre)).filter((genre) => genre !== ""));
  const untagged = entries.filter((entry) => tag(entry.genre) === "").length;
  const untrusted = entries.filter((entry) => !(entry.candidate.track.grid.rmsResidualMs <= SET_RULES.maxGridResidualMs));
  const blocking = [
    entries.length < SET_RULES.minTracks ? `Pick ${String(SET_RULES.minTracks - entries.length)} more track(s): a set needs ${String(SET_RULES.minTracks)}.` : null,
    entries.length > SET_RULES.maxTracks ? `Take ${String(entries.length - SET_RULES.maxTracks)} track(s) out: a set has ${String(SET_RULES.maxTracks)} at most.` : null,
    untagged > 0 ? `Give ${String(untagged)} track(s) a genre.` : null,
    genres.size > 1 ? `One genre per set: you have ${[...genres].join(", ")}. Take some out, or retag them.` : null,
    ...untrusted.map((entry) => `"${entry.candidate.track.title}": this track's beat grid is too uneven to grade; pick another.`),
  ].filter((problem) => problem !== null);
  const first = entries[0]?.candidate.track.grid.bpm;
  const warnings: SetWarning[] = entries.flatMap((entry, index): SetWarning[] => {
    const tempo = first === undefined ? 0 : Math.abs(entry.candidate.track.grid.bpm / first - 1);
    const previous = entries[index - 1]?.candidate.camelot ?? null;
    const key = entry.candidate.camelot;
    return [
      ...(tempo > SET_RULES.maxTempoApart + 1e-9 ? [{ kind: "tempo" as const, index, apartPercent: tempo * 100 }] : []),
      ...(previous !== null && key !== null && !keysCompatible(previous, key) ? [{ kind: "key" as const, index, from: previous, to: key }] : []),
    ];
  });
  return { blocking, warnings };
}

export function warningText(warning: SetWarning, entries: readonly SetEntry[]): string {
  const title = entries[warning.index]?.candidate.track.title ?? "A track";
  return warning.kind === "tempo"
    ? `"${title}" is ${warning.apartPercent.toFixed(1)}% off track 1's tempo: the Check allows 2%.`
    : `"${title}" (${warning.to}) may clash with the track before (${warning.from}). Allowed: blend it short, or cut.`;
}

/** The track as the set plays it: phrase markers moved by the prep's whole bars. */
export function preparedTrack(entry: SetEntry): LessonTrack {
  const { track } = entry.candidate;
  if (entry.phraseShiftBars === 0) return track;
  const shift = barsSec(track, entry.phraseShiftBars);
  return { ...track, phraseStarts: track.phraseStarts.map((start) => start + shift).filter((start) => start < track.durationSec) };
}

// ---------------------------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------------------------

/** Below this the master is silent (`no-dead-air`'s line). */
const SILENT_LUFS = -45;
const METER_FRAME_S = 0.02;

/**
 * The span a set is graded over: from the set's own cue (the first time each deck was cued after the
 * recorder started; before it the warm-up is still heard) to the end of the last master audio, so the
 * silence after the last track (before "End set") is the set's end, not dead air.
 */
export function finalMixWindow(attempt: Attempt, startedCtx: number, endedCtx: number): CtxSpan {
  const cues = (["A", "B"] as const).flatMap((deck) => {
    const recording = attempt.decks[deck];
    const first = recording?.earlier?.[0] ?? recording;
    const cued = first?.playhead.segments.find((segment) => segment.fromCtx >= startedCtx)?.fromCtx;
    return cued === undefined ? [] : [cued];
  });
  const from = Math.min(endedCtx, Math.max(startedCtx, ...cues));
  const lastAudio = attempt.meters.master.findLast((frame) => frame.ctx >= from && frame.ctx < endedCtx && frame.momentaryLufs >= SILENT_LUFS);
  return { from, to: lastAudio === undefined ? endedCtx : Math.min(endedCtx, lastAudio.ctx + METER_FRAME_S) };
}

/** The first set is a rehearsal (a Lesson Check); once passed, a set is the cold re-pass that is the final project (C2). */
export function finalMixMode(profile: SkillProfile): CheckMode {
  return profile.lessons["final-mix"]?.passedAt == null ? "lesson" : "cold";
}

export interface PlayedTrack {
  readonly entry: SetEntry;
  /** The deck the set played it on. */
  readonly deck: "A" | "B";
}

/** The TaskSpec a recorded set is graded with. */
export function finalMixSpec(
  played: readonly PlayedTrack[],
  attempt: Attempt,
  options: { readonly startedCtx: number; readonly endedCtx: number; readonly passedLessons: readonly LessonId[]; readonly mode: CheckMode },
): TaskSpec {
  const set: SetTrack[] = played.map(({ entry }) => ({ trackId: entry.candidate.track.trackId, genre: tag(entry.genre), camelot: entry.candidate.camelot }));
  const tracks: TaskTrack[] = played.map(({ entry, deck }) => ({ trackId: entry.candidate.track.trackId, trackSetId: null, deck }));
  return {
    mode: options.mode,
    variant: "full",
    task: { lessonId: "final-mix", set },
    tracks,
    aids: FINAL_MIX_AIDS,
    window: finalMixWindow(attempt, options.startedCtx, options.endedCtx),
    passedLessons: options.passedLessons,
  };
}

// ---------------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------------

const need = (criterion: CriterionResult) => {
  const value = criterion.threshold?.value;
  return typeof value === "number" ? value : 0;
};

/** One line per criterion of a set, in plain words; null for criteria described elsewhere. */
export function describeSetCriterion(criterion: CriterionResult): string | null {
  const { measured } = criterion;
  switch (criterion.id) {
    case "final-mix.track-count":
      return `Tracks played 16 bars or more: ${String(measured ?? 0)} (need ${String(need(criterion))})`;
    case "final-mix.one-genre":
      return measured === 1 ? "One genre" : `Genres in the set: ${String(measured ?? 0)} (need 1)`;
    case "final-mix.tempo-range":
      return measured === null ? "Tempos: not measured" : `Tempos: at most ${(measured * 100).toFixed(1)}% from track 1 (need 2% or less)`;
    case "final-mix.technique": {
      const blends = criterion.detail?.["blends"] ?? 0;
      const cuts = criterion.detail?.["cuts"] ?? 0;
      return `Blends: ${String(blends)}, cuts: ${String(cuts)} (need one of each)`;
    }
    case "standing.on-phrase":
      return measured === null ? "On the phrase: a track never came in" : `On the phrase: worst entry ${measured.toFixed(2)} beats off (need 1 or less)`;
    case "standing.drift": {
      const run = criterion.detail?.["worstRunBars"];
      return measured === null
        ? "Beatmatching: not measured"
        : `Beatmatching: ${String(Math.round(measured * 100))}% of the worst blend within 25 ms (need 85%)${run === undefined ? "" : `, ${run.toFixed(1)} bars over 60 ms at most (need 1)`}`;
    }
    case "standing.level-match":
      return measured === null ? "Levels at the handovers: not measured" : `Levels at the handovers: worst ${measured.toFixed(1)} dB apart (need 2 or less)`;
    case "standing.no-dead-air":
      return measured === null ? "No dead air: no sound measured" : measured < 1 ? "No dead air" : `Dead air: ${measured.toFixed(1)} s of silence (need under 1 s)`;
    case "standing.no-clip":
      return measured === null ? "No clipping: no sound measured" : criterion.status === "met" ? "No clipping" : `Clipping: peak ${measured.toFixed(1)} dBFS`;
    default:
      return null;
  }
}

/** What happened in each transition, for the notes beside the recording. */
export interface TransitionNote {
  readonly number: number;
  readonly from: string;
  readonly to: string;
  readonly kind: "cut" | "blend" | "unclassified";
  readonly met: boolean;
  readonly phraseBeats: number | null;
  readonly levelDb: number | null;
  readonly phaseHold: number | null;
}

/** The set's notes as text: track list and per-transition results, to paste under an upload. */
export function setNotesText(input: {
  readonly title: string;
  readonly recordedAt: string;
  readonly tracks: readonly { readonly title: string; readonly artist: string; readonly bpm: number; readonly credit: string }[];
  readonly transitions: readonly TransitionNote[];
  readonly result: Pick<CheckResult, "outcome">;
}): string {
  const outcome = input.result.outcome;
  const band = outcome.kind === "passed" && outcome.bands !== undefined ? ` (${outcome.bands.overall})` : "";
  const lines = [
    input.title,
    `Recorded ${input.recordedAt.slice(0, 16).replace("T", " ")} with learn-to-dj. Check: ${outcome.kind}${band}.`,
    "",
    "Track list",
    ...input.tracks.map((track, index) => `${String(index + 1)}. ${track.artist} – ${track.title} (${track.bpm.toFixed(1)} BPM). ${track.credit}`),
    "",
    "Transitions",
    ...input.transitions.map((transition) => {
      const parts = [
        transition.phraseBeats === null ? null : `${transition.phraseBeats.toFixed(2)} beats off the phrase`,
        transition.levelDb === null ? null : `levels ${transition.levelDb.toFixed(1)} dB apart`,
        transition.phaseHold === null ? null : `${String(Math.round(transition.phaseHold * 100))}% in phase`,
      ].filter((part) => part !== null);
      return `${String(transition.number)}. ${transition.from} → ${transition.to}: ${transition.kind}, ${transition.met ? "met" : "not met"}${parts.length === 0 ? "" : ` (${parts.join(", ")})`}`;
    }),
    "",
  ];
  return lines.join("\n");
}
