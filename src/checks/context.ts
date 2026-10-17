// What every criterion function reads: the spec, the attempt and per-deck lookups.
import type {
  BeatGrid,
  CtxSpan,
  CtxTime,
  DeckId,
  LessonId,
  LessonTask,
  MeterFrame,
  PlayheadModel,
  TaskSpec,
} from "@shared/attempt.ts";
import type { CriterionResult, Evidence } from "@shared/check-result.ts";
import type { GradedAttempt } from "./deck-controls.ts";
import { framesIn } from "./mix.ts";
import { beatSeconds } from "./timeline.ts";

export interface CheckContext {
  readonly spec: TaskSpec;
  readonly attempt: GradedAttempt;
  readonly window: CtxSpan;
  readonly lessonId: LessonId;
}

/** One loaded deck: its playhead, its track's grid and phrase markers. */
export interface LoadedDeck {
  readonly deck: DeckId;
  readonly trackId: string;
  readonly playhead: PlayheadModel;
  readonly grid: BeatGrid;
  readonly phraseMarkers: readonly number[];
}

export function loadedDeck(context: CheckContext, deck: DeckId): LoadedDeck | null {
  const recording = context.attempt.decks[deck];
  if (recording === undefined) return null;
  const grid = context.attempt.grids[recording.trackId];
  if (grid === undefined) return null;
  return {
    deck,
    trackId: recording.trackId,
    playhead: recording.playhead,
    grid,
    phraseMarkers: context.attempt.phraseMarkers[recording.trackId] ?? [],
  };
}

/** A bar's heard length on a deck at `t` (4 beats). */
export function barSeconds(loaded: LoadedDeck, t: CtxTime): number {
  return 4 * beatSeconds(loaded.playhead, loaded.grid, t);
}

/** What a Lesson's own criteria produce. */
export interface OwnCriteria {
  readonly criteria: readonly CriterionResult[];
  /** Report-only values for the Coach. */
  readonly metrics: Readonly<Record<string, number>>;
}

/** Situations a task can contain; standing criteria apply only when theirs is present. */
export interface Situations {
  /** One deck hands over to another on the master. */
  readonly transition: boolean;
}

/** A Lesson task's parameters, by Lesson id. */
export type TaskOf<Id extends LessonTask["lessonId"]> = Extract<LessonTask, { readonly lessonId: Id }>;

export interface LessonCheck<Task extends LessonTask = LessonTask> {
  readonly situations: Situations;
  readonly run: (context: CheckContext, task: Task) => OwnCriteria;
}

/** Maximal runs of frames that match, as evidence spans. */
export function framesWhere(
  frames: readonly MeterFrame[] | undefined,
  window: CtxSpan,
  predicate: (frame: MeterFrame) => boolean,
  label: string,
): Evidence[] {
  const spans: Evidence[] = [];
  let open: CtxTime | null = null;
  let previous: CtxTime | null = null;
  for (const frame of framesIn(frames, window)) {
    if (predicate(frame)) {
      open ??= frame.ctx;
    } else if (open !== null) {
      spans.push({ from: open, to: frame.ctx, label });
      open = null;
    }
    previous = frame.ctx;
  }
  if (open !== null && previous !== null) spans.push({ from: open, to: Math.min(window.to, previous + 0.02), label });
  return spans;
}

/** Highest value of a frame field in the window; `null` with no frames. */
export function maxOf(frames: readonly MeterFrame[] | undefined, window: CtxSpan, pick: (frame: MeterFrame) => number): number | null {
  const values = framesIn(frames, window).map(pick);
  return values.length === 0 ? null : values.reduce((highest, value) => Math.max(highest, value), -Infinity);
}
