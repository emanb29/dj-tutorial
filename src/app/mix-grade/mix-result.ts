// A graded mix in the Lessons' terms: the standing criteria it can be judged on (for the result card
// and the Coach line), one short caption per check per transition, and the summary the Learner's
// record keeps as outside practice. Pure: no I/O, no clock.
import { judge } from "@checks/criterion.ts";
import { MIX_THRESHOLDS, type MixError, type MixReport, type MixTransition } from "@analysis/mix/index.ts";
import type { CheckResult, CriterionId, CriterionResult, Threshold, Unit } from "@shared/check-result.ts";
import { MIX_CHECK_IDS, MIX_MAX_BYTES, MIX_MAX_SEC, MIX_MIN_SEC, type MixCheckId, type OutsidePractice } from "@shared/outside-practice.ts";

interface CheckRule {
  readonly criterionId: CriterionId;
  readonly unit: Unit;
  readonly threshold: Threshold;
  /** The transition's value for this check; null when it cannot be judged there (a cut has no blend). */
  readonly ofTransition: (transition: MixTransition) => number | null;
  /** The mix's value: by default the worst transition's. */
  readonly ofMix?: (report: MixReport) => number;
}

const worstOf = (values: readonly number[], higherIsWorse: boolean) => (higherIsWorse ? Math.max(...values) : Math.min(...values));

/** One owner for what each check measures and its pass mark. */
export const CHECK_RULES: Readonly<Record<MixCheckId, CheckRule>> = {
  onPhrase: {
    criterionId: "standing.on-phrase",
    unit: "beats",
    threshold: { op: "<=", value: MIX_THRESHOLDS.onPhraseBeats, unit: "beats" },
    ofTransition: (t) => (t.phraseOffsetBeats === null ? null : Math.abs(t.phraseOffsetBeats)),
  },
  drift: {
    criterionId: "standing.drift",
    unit: "ratio",
    threshold: { op: ">=", value: MIX_THRESHOLDS.driftHoldShare, unit: "ratio" },
    ofTransition: (t) => t.drift?.holdShare ?? null,
  },
  levels: {
    criterionId: "standing.level-match",
    unit: "dB",
    threshold: { op: "<=", value: MIX_THRESHOLDS.levelJumpDb, unit: "dB" },
    ofTransition: (t) => (t.levelJumpDb === null ? null : Math.abs(t.levelJumpDb)),
  },
  clipping: {
    criterionId: "standing.no-clip",
    unit: "s",
    threshold: { op: "<=", value: MIX_THRESHOLDS.clippedSec, unit: "s" },
    ofTransition: (t) => t.clippedSec,
    ofMix: (report) => report.clippedSec,
  },
  deadAir: {
    criterionId: "standing.no-dead-air",
    unit: "s",
    threshold: { op: "<", value: MIX_THRESHOLDS.deadAirSec, unit: "s" },
    ofTransition: (t) => t.deadAirSec,
    ofMix: (report) => Math.max(0, ...report.deadAir.map((span) => span.toSec - span.fromSec)),
  },
  oneBass: {
    criterionId: "standing.one-bass",
    unit: "beats",
    threshold: { op: "<=", value: MIX_THRESHOLDS.bassClashBeats, unit: "beats" },
    ofTransition: (t) => t.bassClashBeats,
  },
};

const judged = (rule: CheckRule, measured: number) => judge({ id: rule.criterionId, severity: "fail", unit: rule.unit, threshold: rule.threshold, measured });

/** Whether one transition met one check; null when the check does not apply to it. */
export function transitionMet(check: MixCheckId, transition: MixTransition): boolean | null {
  const rule = CHECK_RULES[check];
  const value = rule.ofTransition(transition);
  return value === null ? null : judged(rule, value).status === "met";
}

/** Per check: how many transitions it could judge, and how many met it. */
export function checkTallies(report: MixReport): Record<MixCheckId, { met: number; of: number }> {
  return Object.fromEntries(
    MIX_CHECK_IDS.map((check) => {
      const results = report.transitions.map((transition) => transitionMet(check, transition)).filter((met) => met !== null);
      return [check, { met: results.filter(Boolean).length, of: results.length }];
    }),
  ) as Record<MixCheckId, { met: number; of: number }>;
}

/** The mix's criterion for one check: the worst transition (or the whole mix), or notApplicable. */
export function mixCriterion(check: MixCheckId, report: MixReport): CriterionResult {
  const rule = CHECK_RULES[check];
  const values = report.transitions.map(rule.ofTransition).filter((value) => value !== null);
  if (rule.ofMix !== undefined) return judged(rule, rule.ofMix(report));
  if (values.length === 0) {
    return { id: rule.criterionId, severity: "fail", status: "notApplicable", measured: null, unit: rule.unit, threshold: rule.threshold, margin: null, evidence: [] };
  }
  return judged(rule, worstOf(values, rule.threshold.op !== ">="));
}

export interface MixAttempt {
  readonly attemptId: string;
  readonly learnerId: string;
  /** Wall clock: when the Learner picked the file and when grading finished. */
  readonly startedAt: string;
  readonly endedAt: string;
}

/**
 * The mix as a CheckResult, for the Coach line only: never applied to the Skill profile. It goes in
 * as Lesson 20's (the set, the closest Lesson) in bonus mode, which never gates anything.
 */
export function mixCheckResult(report: MixReport, attempt: MixAttempt): CheckResult {
  const criteria = MIX_CHECK_IDS.map((check) => mixCriterion(check, report));
  const failed = criteria.filter((criterion) => criterion.status === "notMet").map((criterion) => criterion.id);
  return {
    schemaVersion: 1,
    attemptId: attempt.attemptId,
    learnerId: attempt.learnerId,
    lessonId: "final-mix",
    mode: "bonus",
    variant: "full",
    startedAt: attempt.startedAt,
    endedAt: attempt.endedAt,
    inputDevice: "keyboard",
    endReason: "done",
    outcome: failed.length === 0 ? { kind: "passed" } : { kind: "failed", failedCriteria: failed },
    criteria,
    tracks: [],
    aids: { sync: false, quantize: false, bpmDisplay: false, phaseMeter: false, lessonText: false },
    metrics: { transitions: report.transitions.length, durationSec: Math.round(report.durationSec) },
  };
}

/** What the Learner's record keeps: counts only, no audio, no file name. */
export function outsidePracticeOf(report: MixReport, id: string, gradedAt: string): OutsidePractice {
  const checks = checkTallies(report);
  const clean = MIX_CHECK_IDS.every((check) => mixCriterion(check, report).status !== "notMet");
  return {
    id,
    kind: "mix-recording",
    gradedAt,
    durationSec: Math.min(MIX_MAX_SEC, Math.round(report.durationSec * 10) / 10),
    transitions: report.transitions.length,
    blends: report.transitions.filter((transition) => transition.kind === "blend").length,
    clean,
    checks,
  };
}

// ---------------------------------------------------------------------------------------------
// Captions: one short line each (built for ADHD: captions, not paragraphs).
// ---------------------------------------------------------------------------------------------

/** 75.4 s → "1:15". */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(whole / 60))}:${String(whole % 60).padStart(2, "0")}`;
}

const beats = (n: number) => `${String(n)} beat${n === 1 ? "" : "s"}`;
const roundTo = (value: number, step: number) => Math.round(value / step) * step;

export const CHECK_NAMES: Readonly<Record<MixCheckId, string>> = {
  onPhrase: "On the phrase",
  drift: "Beats in step",
  levels: "Even levels",
  clipping: "No clipping",
  deadAir: "No dead air",
  oneBass: "One bassline",
};

/** "Blend, 14 s at 1:02" / "Cut at 0:45". */
export function transitionTitle(transition: MixTransition): string {
  const at = clock(transition.startSec);
  return transition.kind === "cut" ? `Cut at ${at}` : `Blend, ${String(Math.round(transition.endSec - transition.startSec))} s, at ${at}`;
}

/** One caption per check that applies to this transition, in MIX_CHECK_IDS order. */
export function transitionCaptions(transition: MixTransition): { check: MixCheckId; met: boolean | null; text: string }[] {
  const lines: { check: MixCheckId; met: boolean | null; text: string }[] = [];
  const add = (check: MixCheckId, text: string) => {
    lines.push({ check, met: transitionMet(check, transition), text });
  };
  const offset = transition.phraseOffsetBeats;
  if (offset === null) add("onPhrase", "Phrase: no steady beat to count");
  else {
    const off = roundTo(Math.abs(offset), 0.5);
    add("onPhrase", transitionMet("onPhrase", transition) === true ? "Came in on the phrase" : `Came in ${beats(off)} ${offset > 0 ? "late" : "early"} for the phrase`);
  }
  if (transition.kind === "blend") {
    if (transition.drift === null) add("drift", "Beats: too short to tell");
    else add("drift", transitionMet("drift", transition) === true ? "Beats stayed in step" : `Beats drifted, up to ${String(transition.drift.worstMs)} ms apart`);
  }
  const jump = transition.levelJumpDb;
  if (jump === null) add("levels", "Levels: too short to compare");
  else {
    const size = Math.abs(roundTo(jump, 0.5));
    add("levels", transitionMet("levels", transition) === true ? "Levels stayed even" : `${String(size)} dB ${jump > 0 ? "louder" : "quieter"} after`);
  }
  add("clipping", transitionMet("clipping", transition) === true ? "No clipping" : `Clipped for ${transition.clippedSec.toFixed(2)} s`);
  add("deadAir", transitionMet("deadAir", transition) === true ? "No dead air" : `${transition.deadAirSec.toFixed(1)} s of silence`);
  if (transition.kind === "blend") {
    const clash = transition.bassClashBeats;
    if (clash === null) add("oneBass", "Bass: too alike to tell apart");
    else add("oneBass", transitionMet("oneBass", transition) === true ? "One bassline at a time" : `Both basslines for ${beats(clash)}`);
  }
  return lines;
}

/** The result card's line for one check over the whole mix. */
export function criterionCaption(check: MixCheckId, report: MixReport): string {
  const tally = checkTallies(report)[check];
  const criterion = mixCriterion(check, report);
  if (check === "clipping") return criterion.status === "met" ? "No clipping" : `Clipping: ${report.clippedSec.toFixed(2)} s in all`;
  if (check === "deadAir") return criterion.status === "met" ? "No dead air" : `Dead air: ${(criterion.measured ?? 0).toFixed(1)} s at the longest`;
  if (tally.of === 0) return `${CHECK_NAMES[check]}: no blends to check`;
  return `${CHECK_NAMES[check]}: ${String(tally.met)} of ${String(tally.of)}`;
}

/** What went wrong, in one line, with what to do. */
export function mixProblemText(error: MixError): string {
  switch (error.kind) {
    case "too-short":
      return `That's ${clock(error.durationSec)}. Pick a mix of at least ${String(MIX_MIN_SEC)} s.`;
    case "too-long":
      return `That's ${clock(error.durationSec)}. Up to ${String(MIX_MAX_SEC / 60)} min: trim it or pick a shorter one.`;
    case "invalid-audio":
      return "That file has no usable audio. Export the mix again and pick that.";
    case "model-missing":
    case "model-failed":
      return "The beat finder couldn't start. Reload the page and try again.";
    case "worker-crashed":
      return "Grading stopped partway. Reload the page and try again.";
    case "aborted":
      return "Stopped.";
  }
}

export const MIX_LIMITS_CAPTION = `Audio only · ${String(MIX_MIN_SEC)} s to ${String(MIX_MAX_SEC / 60)} min · up to ${String(MIX_MAX_BYTES / 1024 / 1024)} MB`;
