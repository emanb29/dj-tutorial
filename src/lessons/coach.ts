// What leaves the browser for the Coach (coach-design §5), and the plain-word lines on the result
// card ("3 of 32 beats missed; you need 29"). Pure.
import type { RetentionChange } from "@checks";
import { LESSON_IDS, LESSONS as CATALOGUE, SKIP_GROUP_IDS, type LessonId, type SkipGroupId } from "@shared/catalogue.ts";
import {
  COACH_CRITERIA_MAX,
  COACH_METRICS_MAX,
  RECENT_LINES_MAX,
  type CheckLineRequest,
  type CoachCheckSummary,
  type CoachCriterion,
  type CoachSuccess,
  type CurriculumData,
  type CurriculumRequest,
} from "@shared/coach-contract.ts";
import { criterionPlainName, focusCriteria } from "@shared/coach-deterministic.ts";
import type { LearnerRecord } from "@shared/learner.ts";
import { describeByEar } from "./catalogue-by-ear.ts";
import type { MissionTag } from "@shared/mission.ts";
import type { SkillProfile } from "@shared/skill-profile.ts";
import type { CheckResult, CriterionResult, Threshold, Unit } from "@shared/check-result.ts";
import type { Threshold as CoachThreshold, Unit as CoachUnit } from "@shared/check-types.ts";

/** A fader position is a 0–1 ratio to the Coach, whose contract has no "position" unit. */
function coachUnit(unit: Unit): CoachUnit {
  return unit === "position" ? "ratio" : unit;
}

function coachThreshold(threshold: Threshold | null): CoachThreshold | null {
  if (threshold === null) return null;
  const { value } = threshold;
  return { op: threshold.op === "<" ? "<=" : threshold.op, value: typeof value === "number" ? value : [value[0], value[1]], unit: coachUnit(threshold.unit) };
}

/**
 * The reduced result for the Coach, in the contract's units: every criterion that applied, misses
 * with nothing measured included, and misses first so the contract's cap never drops one.
 */
export function toCoachSummary(result: CheckResult): CoachCheckSummary {
  const applied = result.criteria.flatMap((criterion): CoachCriterion[] =>
    criterion.status === "notApplicable"
      ? []
      : [
          {
            id: criterion.id,
            severity: criterion.severity,
            status: criterion.status,
            measured: criterion.measured,
            unit: coachUnit(criterion.unit),
            threshold: coachThreshold(criterion.threshold),
            margin: criterion.margin,
          },
        ],
  );
  const criteria = [...applied.filter((criterion) => criterion.status === "notMet"), ...applied.filter((criterion) => criterion.status === "met")];
  return {
    lessonId: result.lessonId,
    mode: result.mode,
    variant: result.variant,
    outcome: result.outcome.kind === "passed" ? "passed" : "failed",
    criteria: criteria.slice(0, COACH_CRITERIA_MAX),
    metrics: Object.fromEntries(Object.entries(result.metrics).slice(0, COACH_METRICS_MAX)),
  };
}

/** What the line knows about the focus criterion beyond this result (coach-design §2.3 input). */
export interface LineFacts {
  /** The focus criterion's margins from earlier attempts, oldest first, at most 3. */
  readonly focusHistory: readonly number[];
  readonly bestMarginBefore: number | null;
  /** E.g. "retained, next in 7 days". */
  readonly retentionChange: string | null;
}

export const FOCUS_HISTORY_MAX = 3;
/** For a result with nothing to focus on, or a void attempt (which never gets a line). */
export const NO_LINE_FACTS: LineFacts = { focusHistory: [], bestMarginBefore: null, retentionChange: null };
const DAY_MS = 86_400_000;

function retentionWords(change: RetentionChange, gradedAt: string): string {
  if (change.nextDueAt === null) return change.to;
  // Both times come from the data (the result's end and the schedule), never the wall clock.
  const gapMs = Date.parse(change.nextDueAt) - Date.parse(gradedAt);
  if (!Number.isFinite(gapMs)) return change.to;
  const days = Math.max(0, Math.round(gapMs / DAY_MS));
  return `${change.to}, next in ${String(days)} ${days === 1 ? "day" : "days"}`;
}

/**
 * The focus criterion's margin history, best margin before this attempt and retention change. The
 * focus is the criterion the line talks about (`focusCriteria`), so these facts never describe another.
 */
export function lineFacts(
  result: CheckResult,
  sources: {
    readonly profileBefore: SkillProfile;
    readonly retentionChanges: readonly RetentionChange[];
    /** Margins per criterion from earlier attempts, oldest first. */
    readonly marginHistory: Readonly<Partial<Record<string, readonly number[]>>>;
  },
): LineFacts {
  const focus = focusCriteria(toCoachSummary(result), 1)[0];
  if (focus === undefined) return NO_LINE_FACTS;
  const change = sources.retentionChanges.find((candidate) => candidate.criterionId === focus.id);
  return {
    focusHistory: (sources.marginHistory[focus.id] ?? []).slice(-FOCUS_HISTORY_MAX),
    bestMarginBefore: sources.profileBefore.criteria[focus.id]?.best?.margin ?? null,
    retentionChange: change === undefined ? null : retentionWords(change, result.endedAt),
  };
}

/** The part of a Skill profile that says which Lessons are passed. */
type PassedLessons = Pick<SkillProfile, "lessons">;

const passedIn = (profile: PassedLessons, id: LessonId) => profile.lessons[id]?.passedAt != null;

/** Skip groups whose every Lesson is passed in `after` but not in `before`. */
export function skipGroupsPassed(before: PassedLessons, after: PassedLessons): SkipGroupId[] {
  const complete = (profile: PassedLessons, group: SkipGroupId) =>
    CATALOGUE.filter((lesson) => lesson.skipGroup === group).every((lesson) => passedIn(profile, lesson.id));
  return SKIP_GROUP_IDS.filter((group) => complete(after, group) && !complete(before, group));
}

/** The background Curriculum re-plan after a skip group is passed: the Mission, what is demonstrated, and the result that passed it. */
export function curriculumRequest(record: LearnerRecord, result: CheckResult, requestId: string): CurriculumRequest {
  return {
    requestId,
    mission: record.mission,
    demonstrated: LESSON_IDS.filter((id) => passedIn(record.skillProfile, id)),
    placementResults: [toCoachSummary(result)],
    reason: "skipGroupPassed",
  };
}

/** The part of the Coach's Curriculum answer the record keeps. */
export type CurriculumAnswer = Pick<CoachSuccess<CurriculumData>, "source" | "data">;

/**
 * The record with the new Curriculum. Mission tags are replaced only when the Coach chose them: the
 * fallback has none (coach-design §2.2) and must not erase tags an earlier Coach answer gave.
 */
export function withCurriculum(record: LearnerRecord, answer: CurriculumAnswer): LearnerRecord {
  const { curriculum, missionTags } = answer.data;
  return { ...record, curriculum: [...curriculum], missionTags: answer.source === "llm" ? [...missionTags] : record.missionTags };
}

export interface LineContext {
  readonly requestId: string;
  readonly lessonTitle: string;
  readonly attemptToday: number;
  readonly recentLines: readonly string[];
  readonly facts: LineFacts;
  readonly missionTags: readonly MissionTag[];
}

export function checkLineRequest(result: CheckResult, context: LineContext): CheckLineRequest {
  return {
    requestId: context.requestId,
    result: toCoachSummary(result),
    context: {
      lessonTitle: context.lessonTitle,
      focusHistory: [...context.facts.focusHistory],
      bestMarginBefore: context.facts.bestMarginBefore,
      retentionChange: context.facts.retentionChange,
      attemptToday: Math.max(1, context.attemptToday),
      missionTags: [...context.missionTags],
      recentLines: context.recentLines.slice(-RECENT_LINES_MAX),
    },
  };
}

const thresholdValue = (criterion: CriterionResult): number =>
  typeof criterion.threshold?.value === "number" ? criterion.threshold.value : 0;

function taps(label: string, criterion: CriterionResult, need: number): string {
  const matched = criterion.detail?.["matched"] ?? 0;
  const targets = criterion.detail?.["targets"] ?? 0;
  const extras = criterion.detail?.["extras"] ?? 0;
  const wrong = criterion.detail?.["wrongBeat"] ?? 0;
  const extra = extras > 0 ? `, ${String(extras)} extra` : "";
  const wrongText = wrong > 0 ? `, ${String(wrong)} on the wrong beat` : "";
  return `${label}: ${String(matched)} of ${String(targets)} on time (need ${String(need)})${extra}${wrongText}`;
}

/** A number with a true minus sign (−3.2), as on the meters. */
function signed(value: number, digits: number): string {
  const text = Math.abs(value).toFixed(digits);
  return value < 0 && Number(text) !== 0 ? `−${text}` : text;
}

const round = (value: number) => String(Math.round(value));

function peakLine(deck: "A" | "B", criterion: CriterionResult): string {
  const zone = criterion.threshold?.value;
  const need = zone === undefined || typeof zone === "number" ? "need the zone" : `need ${signed(zone[0], 0)} to ${signed(zone[1], 1)}`;
  return criterion.measured === null ? `Deck ${deck}: no Ready (R) with 8 bars after it` : `Deck ${deck} peak: ${signed(criterion.measured, 1)} dBFS (${need})`;
}

/** "Transition 2: " when a Check has several transitions and this line is about one of them. */
function transitionPrefix(criterion: CriterionResult): string {
  const transition = criterion.detail?.["transition"];
  return transition === undefined || (criterion.detail?.["transitions"] ?? 0) < 2 ? "" : `Transition ${String(transition)}: `;
}

/** Standing criteria with a line of their own; null for the rest (they read as their plain name). */
function describeStanding(criterion: CriterionResult): string | null {
  const measured = criterion.measured;
  const need = thresholdValue(criterion);
  const prefix = transitionPrefix(criterion);
  switch (criterion.id) {
    case "standing.level-match":
      return measured === null ? `${prefix}Levels: not measured` : `${prefix}Levels ${measured.toFixed(1)} dB apart at the handover (need ${String(need)} or less)`;
    case "standing.cued-first":
      return measured === null ? `${prefix}CUE 🎧: the next track never came in` : `${prefix}CUE 🎧 on ${measured.toFixed(1)} s before it came in (need ${String(need)})`;
    case "standing.trim-still": {
      const turns = criterion.detail?.["gestures"] ?? 0;
      const wrongWay = criterion.detail?.["wrongWay"] ?? 0;
      if (criterion.status !== "notMet") return turns === 0 ? "TRIM: not touched mid-transition" : `TRIM: level kept steady (moved ${String(turns)}×)`;
      if (criterion.unit === "dB") return `${prefix}TRIM: swung ${(measured ?? 0).toFixed(1)} dB mid-transition (keep it within ${String(need)}: let the faders fade)`;
      return `${prefix}TRIM: ${String(wrongWay)} ${wrongWay === 1 ? "turn" : "turns"} took the levels further apart (turn toward the other deck's level)`;
    }
    default:
      return null;
  }
}

/** Lessons 4–7; null for criteria of other Lessons. */
function describeMixing(criterion: CriterionResult): string | null {
  const measured = criterion.measured;
  const need = thresholdValue(criterion);
  switch (criterion.id) {
    case "gain-staging.trim-A":
      return peakLine("A", criterion);
    case "gain-staging.trim-B":
      return peakLine("B", criterion);
    case "gain-staging.loud-match":
      return measured === null ? "A and B loudness: not measured (Ready both decks)" : `A and B loudness: ${measured.toFixed(1)} dB apart (need ${String(need)} or less)`;
    case "headphone-cue.cued-taps":
      return taps("B's beats", criterion, Math.ceil(need * (criterion.detail?.["targets"] ?? 0) - 1e-9));
    case "headphone-cue.b-off-master": {
      const cueOn = round((criterion.detail?.["cueOnFraction"] ?? 0) * 100);
      return measured !== null && measured > need ? "B reached the speakers: fader B came up" : `B off the speakers: fader down, CUE on ${cueOn}% of the taps (need 95%)`;
    }
    case "cue-point.cue-on-downbeat": {
      const wrong = criterion.detail?.["wrongBeat"] ?? 0;
      const missing = criterion.detail?.["missing"] ?? 0;
      const head = measured === null ? "Cue points: none set" : `Cue points: worst ${round(measured)} ms off the beat (need ${String(need)} or less)`;
      return `${head}${wrong > 0 ? `, ${String(wrong)} not on a 1` : ""}${missing > 0 && measured !== null ? `, ${String(missing)} not set` : ""}`;
    }
    case "cut-on-phrase.cut-start":
      return measured === null ? "Cut: B never came in" : `Cut: ${round(measured)} ms from the phrase start (need ${String(need)} or less)`;
    case "cut-on-phrase.cut-tight":
      return measured === null ? "A out: A never went out" : `A out ${measured.toFixed(2)} beats from B in (need ${String(need)} or less)`;
    case "cut-on-phrase.cued-before":
      return measured === null ? "CUE B: B never came in" : `CUE B on ${measured.toFixed(1)} s before the cut (need ${String(need)})`;
    case "cut-on-phrase.loud-jump":
      return measured === null ? "Level jump: not measured" : `Level jump at the cut: ${measured.toFixed(1)} dB (need ${String(need)} or less)`;
    default:
      return null;
  }
}

const blendStartLine = (measured: number | null) =>
  measured === null ? "Blend start: B never came in" : `Blend start: ${measured.toFixed(2)} beats from the phrase start (need 1 or less)`;

function blendLengthLine(criterion: CriterionResult): string {
  const range = criterion.threshold?.value;
  const need = range === undefined || typeof range === "number" ? "" : ` (need ${String(Math.ceil(range[0]))}–${String(Math.floor(range[1]))})`;
  return criterion.measured === null ? "Blend length: A never went all the way out" : `Blend: ${criterion.measured.toFixed(1)} bars${need}`;
}

const loudSteadyLine = (measured: number | null) =>
  measured === null ? "Level through the blend: not measured" : `Level through the blend: moved ${measured.toFixed(1)} dB (need 3 or less)`;

/** A part of a crossfader criterion (reported as its first part not met), by its unit. */
function crossfaderPart(label: string, criterion: CriterionResult): string {
  const { measured } = criterion;
  const need = thresholdValue(criterion);
  switch (criterion.unit) {
    case "beats":
      return label === "Blend" ? blendStartLine(measured) : measured === null ? `${label}: never happened` : `${label}: A in, B out ${measured.toFixed(2)} beats apart (need ${String(need)} or less)`;
    case "bars":
      return blendLengthLine(criterion);
    case "dB":
      return label === "Blend" ? loudSteadyLine(measured) : measured === null ? "Level jump: not measured" : `Level jump at the cut: ${measured.toFixed(1)} dB (need ${String(need)} or less)`;
    case "ms":
      return measured === null ? "Cut to A: A never came in" : `Cut to A: ${round(measured)} ms from the phrase start (need ${String(need)} or less)`;
    case "s":
      return measured === null ? "CUE A: A never came in" : `CUE A on ${measured.toFixed(1)} s before the cut (need ${String(need)})`;
    default:
      return label;
  }
}

/** Lessons 8–11; null for criteria of other Lessons. */
function describeSyncMixing(criterion: CriterionResult): string | null {
  const measured = criterion.measured;
  const need = thresholdValue(criterion);
  switch (criterion.id) {
    case "tempo-fader.set-bpm": {
      const confirmed = criterion.detail?.["confirmed"] ?? 0;
      const targets = criterion.detail?.["targets"] ?? 0;
      return measured === null
        ? `BPMs set: ${String(confirmed)} of ${String(targets)} confirmed with Ready`
        : `BPMs: worst ${measured.toFixed(2)} BPM off (need ${String(need)} or less)`;
    }
    case "tempo-fader.master-tempo-ear":
      return `Master Tempo clips: ${String(measured ?? 0)} of ${String(need)} right`;
    case "sync-blend.blend-start":
      return blendStartLine(measured);
    case "sync-blend.blend-length":
      return blendLengthLine(criterion);
    case "sync-blend.loud-steady":
      return loudSteadyLine(measured);
    case "sync-blend.trim-untouched":
      return measured === 0 ? "TRIM left alone during the blend" : `TRIM turned ${String(measured ?? 0)}× during the blend (need none: the faders hold the level)`;
    case "crossfader.xf-blend":
      return criterion.status === "met" ? "Crossfader blend: on the phrase, 8–16 bars, level steady" : crossfaderPart("Blend", criterion);
    case "crossfader.xf-cut":
      return criterion.status === "met" ? "Crossfader cut to A: on the phrase, cued, level even" : crossfaderPart("Cut", criterion);
    case "crossfader.faders-up":
      return measured === null ? "Channel faders: not measured" : `Channel faders: lowest at ${String(Math.round(measured * 100))}% (keep both up)`;
    case "eq-basics.low-kill":
      return `LOW cut: ${(measured ?? 0).toFixed(1)} bars at the bottom (need ${String(need)} or more)`;
    case "eq-basics.low-return":
      return measured === null ? "LOW back: it never came back to the middle" : `LOW back ${measured.toFixed(2)} beats from the phrase start (need 1 or less)`;
    case "eq-basics.eq-centred":
      return measured === null ? "EQs at the end: not measured" : `EQs at the end: ${measured.toFixed(1)} dB from the middle at most (need ${String(need)} or less)`;
    default:
      return null;
  }
}

/** A LOW at or below this reads as all the way down (a kill is −120 dB on the timeline). */
const LOW_KILLED_DB = -60;

/** Lessons 12–13; null for criteria of other Lessons. */
function describeEqFilter(criterion: CriterionResult): string | null {
  const measured = criterion.measured;
  const need = thresholdValue(criterion);
  switch (criterion.id) {
    case "bass-swap.enter-low-cut":
      if (measured === null) return "LOW B as B came in: B never came in";
      return measured <= LOW_KILLED_DB ? "LOW B as B came in: all the way down" : `LOW B as B came in: ${signed(measured, 1)} dB (need ${signed(need, 0)} or lower)`;
    case "bass-swap.swap-time":
      return measured === null ? "Bass swap: the LOWs never swapped while both played" : `Bass swap ${measured.toFixed(2)} beats from the phrase start (need 1 or less)`;
    case "bass-swap.clash-short":
      return measured === null ? "Two basslines: not measured" : `Two basslines at once: ${measured.toFixed(2)} beats (need ${String(need)} or less)`;
    case "filter-transition.hpf-depth":
      return measured === null ? "CFX A: A never went out" : `CFX A: up to ${round(measured * 100)}% high-pass (need ${round(need * 100)}%)`;
    case "filter-transition.filter-length": {
      const range = criterion.threshold?.value;
      const span = range === undefined || typeof range === "number" ? "" : ` (need ${String(Math.ceil(range[0]))}–${String(Math.floor(range[1]))})`;
      return measured === null ? "Filter: no sweep was still on as A went out" : `Filter on ${measured.toFixed(1)} bars before A went out${span}`;
    }
    case "filter-transition.cfx-back":
      return measured === null ? "CFX A: not back to the middle after A went out" : `CFX A back ${measured.toFixed(2)} bars after A went out (need ${String(need)} or less)`;
    default:
      return null;
  }
}

const beatsOff = (label: string, measured: number | null, never: string) =>
  measured === null ? `${label}: ${never}` : `${label}: ${measured.toFixed(2)} beats off the 1 (need 1 or less)`;

/** Lessons 17–19; null for criteria of other Lessons. */
function describePerformance(criterion: CriterionResult): string | null {
  const measured = criterion.measured;
  const need = thresholdValue(criterion);
  const count = (key: string) => criterion.detail?.[key] ?? 0;
  switch (criterion.id) {
    case "hot-cues.hc-place": {
      const head = measured === null ? "Hot cues: none set" : `Hot cues: worst ${round(measured)} ms off a phrase start (need ${String(need)} or less)`;
      return count("notSet") > 0 && measured !== null ? `${head}, ${String(count("notSet"))} pad not set` : head;
    }
    case "hot-cues.hc-trigger": {
      const head = measured === null ? "Pad presses: none while A played" : `Pad presses: worst ${round(measured)} ms from the phrase start (need ${String(need)} or less)`;
      return count("untriggered") > 0 && measured !== null ? `${head}, ${String(count("untriggered"))} pad never pressed` : head;
    }
    case "loop-transition.loop-length": {
      const loopBeats = criterion.detail?.["loopBeats"];
      return measured === null || loopBeats === undefined
        ? "Loop: A never looped"
        : `Loop: ${(loopBeats / 4).toFixed(2)} bars, ${round(measured)} ms off 4 or 8 bars (need ${String(need)} or less)`;
    }
    case "loop-transition.loop-in":
      return beatsOff("Loop start", measured, "no loop");
    case "loop-transition.loop-exit":
      return beatsOff("EXIT", measured, "never pressed");
    case "loop-transition.loop-entry":
      return measured === null ? "B in: B never came in" : criterion.status === "met" ? "B in: on the loop's 1, on B's phrase" : `B in: ${measured.toFixed(2)} beats off (need 1 or less, while A loops)`;
    case "loop-transition.no-double":
      return measured === 0 ? "Loop buttons: one press each" : `Loop buttons: ${String(measured ?? 0)} double presses (need none)`;
    case "echo-out.echo-cut":
      return count("echoOn") === 0 ? "Echo cut: ECHO was not on A as it went out" : beatsOff("Echo cut", measured, "A never went out");
    case "echo-out.echo-entry":
      return measured === null ? "B in: B never came in" : `B in ${measured.toFixed(2)} beats from the phrase start (need 1 or less)`;
    case "echo-out.fx-off":
      return measured === null ? "FX off: Beat FX stayed on" : measured <= 0 ? "FX off: before the echoes died out" : `FX off ${measured.toFixed(1)} bars after the echoes died (need ${String(need)} or less)`;
    default:
      return null;
  }
}

/** One cue under the cue-point criterion on the result card. */
export interface CueLine {
  readonly met: boolean;
  readonly text: string;
}

/** Offsets under this read "on the 1" with no number: below what anyone can hear or jog to. */
const CUE_EXACT_MS = 0.5;

/**
 * One short line per cue for `cue-point.cue-on-downbeat` (from its per-cue detail), e.g. "Cue 2: 34 ms
 * late" or "Cue 3: on beat 3, not the 1". Empty for every other criterion, and for a result recorded
 * before the detail carried each cue.
 */
export function describeCues(criterion: CriterionResult): readonly CueLine[] {
  if (criterion.id !== "cue-point.cue-on-downbeat" || criterion.unit !== "ms") return [];
  const detail = criterion.detail ?? {};
  const tolerance = thresholdValue(criterion);
  const count = detail["tracks"] ?? 0;
  const set = Array.from({ length: count }, (_, index) => detail[`cue${String(index + 1)}.beat`]).filter((beat) => beat !== undefined).length;
  // A result recorded before the detail carried each cue has only the counts: nothing per cue to say.
  if (set !== count - (detail["missing"] ?? 0)) return [];
  return Array.from({ length: count }, (_, index) => {
    const label = `Cue ${String(index + 1)}`;
    const offset = detail[`cue${String(index + 1)}.offsetMs`];
    const beat = detail[`cue${String(index + 1)}.beat`];
    if (offset === undefined || beat === undefined) return { met: false, text: `${label}: not set` };
    if (beat !== 1) return { met: false, text: `${label}: on beat ${String(beat)}, not the 1` };
    const met = Math.abs(offset) <= tolerance;
    if (Math.abs(offset) < CUE_EXACT_MS) return { met, text: `${label}: on the 1` };
    return { met, text: `${label}: ${round(Math.abs(offset))} ms ${offset < 0 ? "early" : "late"}` };
  });
}

/** One plain line per criterion for the result card: what was measured against what was needed. */
export function describeCriterion(criterion: CriterionResult): string {
  const measured = criterion.measured;
  switch (criterion.id) {
    case "deck-basics.fade-in":
      return measured === null ? "Fade in: never heard" : `Fade in: heard after ${measured.toFixed(1)} bars (need 4 or less)`;
    case "deck-basics.fade-out":
      return `Fade out: fader ended at ${String(Math.round((measured ?? 0) * 100))}% (needs 0%)`;
    case "deck-basics.no-clip-local":
      return measured === null ? "Master level: no sound measured" : `Master peak: ${measured.toFixed(1)} dBFS (stay under −0.1)`;
    case "beats-and-bars.beat-taps":
      return taps("Beats", criterion, Math.ceil(thresholdValue(criterion) * (criterion.detail?.["targets"] ?? 0) - 1e-9));
    case "beats-and-bars.downbeat-taps":
      return taps("Downbeats", criterion, thresholdValue(criterion));
    case "phrases.phrase-taps":
      return taps("Phrase starts", criterion, thresholdValue(criterion));
    case "phrases.name-sections": {
      const questions = criterion.detail?.["questions"] ?? 0;
      return `Sections named: ${String(questions - (measured ?? questions))} of ${String(questions)} right`;
    }
    default: {
      const mixing =
        describeStanding(criterion) ?? describeMixing(criterion) ?? describeSyncMixing(criterion) ?? describeEqFilter(criterion) ?? describeByEar(criterion) ?? describePerformance(criterion);
      if (mixing !== null) return mixing;
      const name = criterionPlainName(criterion.id);
      const label = name.charAt(0).toUpperCase() + name.slice(1);
      return measured === null ? label : `${label}: ${String(Math.round(measured * 100) / 100)} ${criterion.unit}`;
    }
  }
}
