// Synthetic attempts for tests. 120 BPM by default: a beat is 0.5 s, a bar 2 s, a phrase 16 s.
import type {
  Aids,
  Attempt,
  BeatGrid,
  ChannelSnapshot,
  ControlEvent,
  CtxSpan,
  DeckId,
  LessonId,
  LessonTask,
  MeterFrame,
  PlayheadSegment,
  TaskSpec,
} from "@shared/attempt.ts";

export const BPM = 120;
export const BEAT = 60 / BPM;
export const BAR = 4 * BEAT;
export const PHRASE = 8 * BAR;
export const FRAME = 1 / 50;

export function grid(overrides: Partial<BeatGrid> = {}): BeatGrid {
  return { bpm: BPM, firstBeat: 0, downbeatIndex: 0, rmsResidualMs: 3, ...overrides };
}

/** Phrase markers every 8 bars from track time 0 up to `bars`. */
export function phraseMarkersEvery8Bars(bars = 128): number[] {
  return Array.from({ length: Math.floor(bars / 8) + 1 }, (_, index) => index * PHRASE);
}

/** Plays from track position `pos` at heard time `fromCtx`, optionally pausing at `untilCtx`. */
export function playing(fromCtx: number, pos = 0, untilCtx?: number, rate = 1): PlayheadSegment[] {
  const segments: PlayheadSegment[] = [{ fromCtx, pos, rate }];
  if (untilCtx !== undefined) segments.push({ fromCtx: untilCtx, pos: pos + rate * (untilCtx - fromCtx), rate: 0 });
  return segments;
}

export interface FrameLevels {
  readonly peak: number;
  readonly momentary: number;
  readonly shortTerm?: number;
}

/** 50 Hz frames over `[from, to)`, levels from `levelsAt(t)`. */
export function frames(from: number, to: number, levelsAt: (t: number) => FrameLevels): MeterFrame[] {
  const count = Math.round((to - from) / FRAME);
  return Array.from({ length: count }, (_, index) => {
    const ctx = from + index * FRAME;
    const levels = levelsAt(ctx);
    return {
      ctx,
      samplePeakDb: levels.peak,
      momentaryLufs: levels.momentary,
      shortTermLufs: levels.shortTerm ?? levels.momentary,
    };
  });
}

export const SILENT: FrameLevels = { peak: -120, momentary: -120 };
export const MUSIC: FrameLevels = { peak: -3, momentary: -14 };

export function channel(overrides: Partial<ChannelSnapshot> = {}): ChannelSnapshot {
  return {
    channelFader: 0,
    trimDb: 0,
    eqHighDb: 0,
    eqMidDb: 0,
    eqLowDb: 0,
    cueMonitor: false,
    ...overrides,
  };
}

export function attempt(overrides: Partial<Attempt> = {}): Attempt {
  return {
    attemptId: "attempt-1",
    learnerId: "learner-1",
    startedAt: "2026-10-17T10:00:00.000Z",
    endedAt: "2026-10-17T10:01:00.000Z",
    endReason: "done",
    inputDevice: "keyboard",
    abandoned: false,
    interruptions: [],
    events: [],
    decks: {},
    grids: { "track-a": grid(), "track-b": grid() },
    phraseMarkers: { "track-a": phraseMarkersEvery8Bars(), "track-b": phraseMarkersEvery8Bars() },
    cuePoints: [],
    meters: { master: [] },
    initialMixer: { A: channel(), B: channel(), crossfader: 0.5 },
    answers: {},
    ...overrides,
  };
}

export const LESSON_AIDS: Aids = {
  sync: false,
  quantize: false,
  bpmDisplay: true,
  phaseMeter: false,
  lessonText: true,
};

export function spec(task: LessonTask, window: CtxSpan, overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    mode: "lesson",
    variant: "full",
    task,
    tracks: [
      { trackId: "track-a", trackSetId: "set-1", deck: "A" },
      { trackId: "track-b", trackSetId: "set-1", deck: "B" },
    ],
    aids: LESSON_AIDS,
    window,
    passedLessons: [],
    ...overrides,
  };
}

export function event(ctx: number, control: ControlEvent["control"], value: number, deck?: DeckId): ControlEvent {
  return deck === undefined ? { ctx, control, value } : { ctx, control, value, deck };
}

export function taps(times: readonly number[]): ControlEvent[] {
  return times.map((ctx) => event(ctx, "tap", 1));
}

/** Every Lesson in `all` before `lessonId`, for standing-criteria tests. */
export function passedBefore(all: readonly LessonId[], lessonId: LessonId): LessonId[] {
  return all.slice(0, all.indexOf(lessonId));
}

export interface CutScenario {
  /** When B starts playing (A's phrase starts are every 16 s; default 32 s). */
  readonly playB?: number;
  /** B's track position when it starts (default 0, its first phrase marker). */
  readonly bStartPos?: number;
  /** A's fader events; default: a keyboard cut at `playB`. */
  readonly closeA?: readonly ControlEvent[];
  /** B's CUE turns on at this time (default 2 s); `null` = never. */
  readonly cueOnAt?: number | null;
  /** Master and B channel loudness change after the cut, dB. */
  readonly jumpDb?: number;
  /** B's channel short-term loudness offset from A's, dB (default `jumpDb`). */
  readonly bShortTermOffsetDb?: number;
  /** More events (trim, EQ, deck CUE …), merged in time order. */
  readonly extraEvents?: readonly ControlEvent[];
  /** Master levels at `t` when it returns some (dead air, clips). */
  readonly masterOverride?: (t: number) => FrameLevels | null;
  /** B's channel peak (default −3). */
  readonly bPeak?: number;
}

export const CUT_WINDOW: CtxSpan = { from: 0, to: 48 };

/** A plays from 0 with its fader up; B (cued at 2 s) is cut in at `playB`. Window [0, 48). */
export function cutScenario(options: CutScenario = {}): Attempt {
  const { playB = 2 * PHRASE, bStartPos = 0, closeA, cueOnAt = 2, jumpDb = 0, extraEvents = [], masterOverride, bPeak = -3 } = options;
  const bOffset = options.bShortTermOffsetDb ?? jumpDb;
  const events = [
    ...(cueOnAt === null ? [] : [event(cueOnAt, "cueMonitor", 1, "B")]),
    event(playB, "channelFader", 1, "B"),
    ...(closeA ?? [event(playB, "channelFader", 0, "A")]),
    ...extraEvents,
  ].sort((a, b) => a.ctx - b.ctx);
  return attempt({
    decks: {
      A: { trackId: "track-a", playhead: { segments: playing(0) } },
      B: { trackId: "track-b", playhead: { segments: playing(playB, bStartPos) } },
    },
    initialMixer: { A: channel({ channelFader: 1 }), B: channel(), crossfader: 0.5 },
    events,
    cuePoints: [{ ctx: 1, deck: "B", trackId: "track-b", pos: bStartPos }],
    meters: {
      master: frames(0, 48, (t) => masterOverride?.(t) ?? { peak: -3, momentary: t < playB ? -14 : -14 + jumpDb }),
      A: frames(0, 48, () => ({ peak: -3, momentary: -14 })),
      B: frames(0, 48, (t) =>
        t >= playB ? { peak: bPeak, momentary: -14 + jumpDb, shortTerm: -14 + bOffset } : { peak: -120, momentary: -120 },
      ),
    },
  });
}
