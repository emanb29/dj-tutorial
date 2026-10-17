// Placement (docs/placement-design.md): which task runs next, what a run credits, and what it writes
// to the Skill profile. Pure: the attempt's own times are "now"; the 6:00 cap is the caller's clock.
import { applyCheckResult, DUE_SLACK_HOURS, lessonOfCriterion, RETENTION_LADDER_DAYS } from "@checks";
import { LESSON_IDS, lessonById, type LessonId, type SkipGroupId } from "@shared/catalogue.ts";
import type { CheckResult, CriterionId, VoidAttempt } from "@shared/check-result.ts";
import type { CurriculumRequest } from "@shared/coach-contract.ts";
import { deterministicCurriculum, requiredRoute } from "@shared/coach-deterministic.ts";
import { describeIssues, LearnerRecordSchema, type LearnerRecord } from "@shared/learner.ts";
import {
  PLACEMENTS_KEPT,
  PLACEMENT_TASK_CAP,
  PLACEMENT_TIME_CAP_S,
  type PlacementCheck,
  type PlacementEndReason,
  type PlacementResult,
  type PlacementTaskRecord,
} from "@shared/placement.ts";
import type { CriterionRecord, LessonRecord, SkillProfile } from "@shared/skill-profile.ts";
import { toCoachSummary } from "./coach.ts";

export interface PlacementGroup {
  readonly groupId: SkipGroupId;
  /** The Check of the group's last Lesson (catalogue §2). */
  readonly groupTask: LessonId;
  /** The smaller task run when the group task fails (§3 table). */
  readonly narrowingTask: LessonId;
}

/** Skip groups, hardest first: the descent order (§3). */
export const PLACEMENT_GROUPS: readonly PlacementGroup[] = [
  { groupId: "byEar", groupTask: "blend-by-ear", narrowingTask: "nudge-phase" },
  { groupId: "syncMixing", groupTask: "bass-swap", narrowingTask: "sync-blend" },
  { groupId: "foundations", groupTask: "cut-on-phrase", narrowingTask: "cue-point" },
  { groupId: "timing", groupTask: "phrases", narrowingTask: "beats-and-bars" },
];

/** Every Lesson Placement can run as a task. */
export type PlacementTaskId = "blend-by-ear" | "nudge-phase" | "bass-swap" | "sync-blend" | "cut-on-phrase" | "cue-point" | "phrases" | "beats-and-bars";

export const PLACEMENT_TASK_IDS: readonly PlacementTaskId[] = ["blend-by-ear", "nudge-phase", "bass-swap", "sync-blend", "cut-on-phrase", "cue-point", "phrases", "beats-and-bars"];

/**
 * The own criteria of each group task (check-design §4). A group credited without its task being run
 * (Foundations, by a pass of `blend-by-ear`) gets these as unmeasured records, so the next warm-up
 * re-passes the group task cold (§6).
 */
export const GROUP_TASK_CRITERIA: Readonly<Partial<Record<LessonId, readonly CriterionId[]>>> = {
  phrases: ["phrases.phrase-taps", "phrases.name-sections"],
  "cut-on-phrase": ["cut-on-phrase.cut-start", "cut-on-phrase.cut-tight", "cut-on-phrase.cued-before", "cut-on-phrase.loud-jump"],
  "bass-swap": ["bass-swap.enter-low-cut", "bass-swap.swap-time", "bass-swap.clash-short"],
  "blend-by-ear": ["blend-by-ear.blend-length", "blend-by-ear.phase-hold", "blend-by-ear.swap-time", "blend-by-ear.clash-short", "blend-by-ear.loud-steady"],
};

/** The tempo-fader skill shows only when the Learner matched tempos by hand (ISS-81). */
const TEMPO_FADER: LessonId = "tempo-fader";
const TEMPO_MATCHED: CriterionId = "tempo-fader.tempo-matched";

/** Every catalogue ancestor of a Lesson (prerequisites, transitively), in catalogue order. */
export function ancestorsOf(lessonId: LessonId): LessonId[] {
  const found = new Set<LessonId>();
  const visit = (id: LessonId) => {
    for (const prerequisite of lessonById(id).prerequisites) {
      if (found.has(prerequisite)) continue;
      found.add(prerequisite);
      visit(prerequisite);
    }
  };
  visit(lessonId);
  return LESSON_IDS.filter((id) => found.has(id));
}

function met(check: PlacementCheck | null, id: CriterionId): boolean {
  return check?.criteria.some((criterion) => criterion.id === id && criterion.status === "met") === true;
}

/**
 * What one task credits (§3 rule 2): nothing unless passed; otherwise its Lesson and every catalogue
 * ancestor. A group task's ancestors hold its whole skip group, so the group comes with it.
 *
 * `tempo-fader` is the exception: credit rests on a measurement, and a sync blend or a nudge with the
 * tempos already equal shows nothing about the tempo fader. It is credited only when the task measured
 * `tempo-fader.tempo-matched` as met (the `bass-swap` task, SYNC off, tempos started apart), or by
 * `blend-by-ear`, where SYNC is locked off and the tempos start 0.5–2% apart (catalogue §2 note).
 */
export function creditedByTask(task: Pick<PlacementTaskRecord, "lessonId" | "outcome" | "checkResult">): LessonId[] {
  if (task.outcome !== "passed") return [];
  const closure = [...ancestorsOf(task.lessonId), task.lessonId];
  const tempoShown = task.lessonId === "blend-by-ear" || met(task.checkResult, TEMPO_MATCHED);
  return LESSON_IDS.filter((id) => closure.includes(id) && (id !== TEMPO_FADER || tempoShown));
}

/** Every Lesson a Placement credits, in catalogue order. Derived from `tasks`, never stored. */
export function creditedLessons(result: Pick<PlacementResult, "tasks">): LessonId[] {
  const credited = new Set(result.tasks.flatMap(creditedByTask));
  return LESSON_IDS.filter((id) => credited.has(id));
}

type PassedLessons = Pick<SkillProfile, "lessons">;

function passedIn(profile: PassedLessons): LessonId[] {
  return LESSON_IDS.filter((id) => profile.lessons[id]?.passedAt != null);
}

export interface PlacementTask {
  readonly lessonId: PlacementTaskId;
  readonly groupId: SkipGroupId;
  readonly step: "group" | "narrowing";
}

export type PlacementStep = { readonly kind: "task"; readonly task: PlacementTask } | { readonly kind: "end"; readonly reason: PlacementEndReason };

function asTaskId(id: LessonId): PlacementTaskId {
  const found = PLACEMENT_TASK_IDS.find((candidate) => candidate === id);
  // Unreachable: the group table only names Placement tasks.
  if (found === undefined) throw new Error(`${id} is not a Placement task.`);
  return found;
}

/**
 * The next task, or why Placement ends (§3). `profileBefore` is the Skill profile before this
 * Placement: on a re-take, Lessons already passed count as credited and are never re-tested.
 * `elapsedS` is from the first hook, on the caller's monotonic clock.
 */
export function nextStep(result: Pick<PlacementResult, "tasks">, profileBefore: PassedLessons, elapsedS: number): PlacementStep {
  if (result.tasks.length >= PLACEMENT_TASK_CAP) return { kind: "end", reason: "taskCap" };
  if (elapsedS >= PLACEMENT_TIME_CAP_S) return { kind: "end", reason: "timeCap" };
  const credited = new Set([...passedIn(profileBefore), ...creditedLessons(result)]);
  const ran = new Map(result.tasks.map((task) => [task.lessonId, task]));
  const notPassedHere = (id: LessonId) => {
    const task = ran.get(id);
    return task !== undefined && task.outcome !== "passed";
  };

  // Descent: group tasks top to bottom; the first pass (or a group already passed) ends it.
  for (const group of PLACEMENT_GROUPS) {
    if (credited.has(group.groupTask)) break;
    if (!ran.has(group.groupTask)) return { kind: "task", task: { lessonId: asTaskId(group.groupTask), groupId: group.groupId, step: "group" } };
  }

  // Narrowing: one smaller task per failed group, hardest first, never on top of a just-failed prerequisite.
  for (const group of PLACEMENT_GROUPS.filter((candidate) => notPassedHere(candidate.groupTask))) {
    const lessonId = group.narrowingTask;
    if (credited.has(lessonId) || ran.has(lessonId)) continue;
    if (ancestorsOf(lessonId).some(notPassedHere)) continue;
    return { kind: "task", task: { lessonId: asTaskId(lessonId), groupId: group.groupId, step: "narrowing" } };
  }
  return { kind: "end", reason: "noTaskLeft" };
}

/** The design's `nextTask`: the next task's Lesson, or null when Placement ends. */
export function nextTask(result: Pick<PlacementResult, "tasks">, profileBefore: PassedLessons, elapsedS: number): PlacementTaskId | null {
  const step = nextStep(result, profileBefore, elapsedS);
  return step.kind === "task" ? step.task.lessonId : null;
}

/** What is kept of a graded attempt: its outcome and each criterion's status. */
export function placementCheckOf(result: CheckResult): PlacementCheck {
  return {
    attemptId: result.attemptId,
    endedAt: result.endedAt,
    outcome: result.outcome.kind === "passed" ? "passed" : "failed",
    criteria: result.criteria.map((criterion) => ({ id: criterion.id, status: criterion.status })),
  };
}

export type TaskOutcome =
  | { readonly kind: "graded"; readonly result: CheckResult }
  | { readonly kind: "void"; readonly attempt?: VoidAttempt }
  | { readonly kind: "notYet" };

/**
 * One attempt's outcome. A first void re-runs the same task (`rerun`) and records nothing; a second
 * void counts as Not yet (§4.3).
 */
export function withTaskOutcome(
  result: PlacementResult,
  task: PlacementTask,
  outcome: TaskOutcome,
  voidRunsBefore: 0 | 1,
): { readonly result: PlacementResult; readonly rerun: boolean } {
  if (outcome.kind === "void" && voidRunsBefore === 0) return { result, rerun: true };
  const voidRuns = outcome.kind === "void" ? 2 : voidRunsBefore;
  const record: PlacementTaskRecord =
    outcome.kind === "graded"
      ? { ...task, outcome: outcome.result.outcome.kind === "passed" ? "passed" : "failed", checkResult: placementCheckOf(outcome.result), voidRuns }
      : { ...task, outcome: "notYet", checkResult: null, voidRuns };
  return { result: { ...result, tasks: [...result.tasks, record] }, rerun: false };
}

/** First Lesson of the deterministic required route that is not passed (`final-mix` when all are). */
export function startLesson(profile: PassedLessons): LessonId {
  return requiredRoute(passedIn(profile))[0] ?? "final-mix";
}

const HOUR_MS = 3_600_000;

function newLessonRecord(lessonId: LessonId): LessonRecord {
  return { lessonId, passedAt: null, passedVia: null, attempts: 0, reviewSuggestedAt: null, reviewDeclinedAt: null };
}

/** A credited-but-unmeasured criterion: passed, not measured, due for its first cold re-pass in a day. */
function unmeasuredRecord(criterionId: CriterionId, at: string): CriterionRecord {
  const nextDueAt = new Date(Date.parse(at) + (RETENTION_LADDER_DAYS[0] * 24 - DUE_SLACK_HOURS) * HOUR_MS).toISOString();
  return {
    criterionId,
    lessonId: lessonOfCriterion(criterionId),
    last: null,
    best: null,
    firstPassedAt: at,
    passDates: [],
    consecutiveFails: 0,
    retention: { state: "passed", step: 0, nextDueAt, lastColdPassAt: null },
    practice: { attempts: 0, met: 0, lastAt: null },
  };
}

/**
 * The Skill profile after a Placement (§6). Passed tasks write their measured criteria as a Lesson
 * Check would (always `passed`, never `retained`); every credited Lesson is passed via Placement; a
 * group credited without its task run gets that task's criteria unmeasured. Fails write nothing. It
 * only adds: a Lesson already passed, and a criterion already recorded, keep what they had.
 *
 * `graded` is every graded attempt of this Placement, in the order run.
 */
export function applyPlacement(profile: SkillProfile, result: PlacementResult, graded: readonly CheckResult[]): SkillProfile {
  const measured = graded
    .filter((check) => check.mode === "placement" && check.outcome.kind === "passed")
    .reduce((current, check) => applyCheckResult(current, check).profile, profile);

  const credited = creditedLessons(result);
  const lessons = Object.fromEntries(
    credited.flatMap((lessonId) => {
      const before = measured.lessons[lessonId] ?? newLessonRecord(lessonId);
      return before.passedAt != null ? [] : [[lessonId, { ...before, passedAt: result.endedAt, passedVia: "placement" } satisfies LessonRecord]];
    }),
  );

  const passedTasks = new Set(result.tasks.filter((task) => task.outcome === "passed").map((task) => task.lessonId));
  const unmeasured = PLACEMENT_GROUPS.filter((group) => credited.includes(group.groupTask) && !passedTasks.has(group.groupTask))
    .flatMap((group) => GROUP_TASK_CRITERIA[group.groupTask] ?? [])
    .filter((criterionId) => measured.criteria[criterionId] === undefined)
    .map((criterionId) => [criterionId, unmeasuredRecord(criterionId, result.endedAt)] as const);

  return {
    ...measured,
    lessons: { ...measured.lessons, ...lessons },
    criteria: { ...measured.criteria, ...Object.fromEntries(unmeasured) },
  };
}

/**
 * The Coach's Curriculum request when the Summary appears (§7): unchanged contract, `reason:
 * "placement"`, every Lesson ever passed, and one summary per graded attempt (passed and failed).
 */
export function placementCurriculumRequest(
  input: { readonly mission: string; readonly profileAfter: PassedLessons; readonly graded: readonly CheckResult[] },
  requestId: string,
): CurriculumRequest {
  return {
    requestId,
    mission: input.mission.trim(),
    demonstrated: passedIn(input.profileAfter),
    placementResults: input.graded.map(toCoachSummary),
    reason: "placement",
  };
}

/**
 * The Learner's record after a Placement: the Skill profile with its credits, the Mission, the run
 * itself, and the deterministic Curriculum, so the Start Lesson is right before the Coach answers
 * (§7: the Coach only merges electives later). Checked against the schema the server enforces.
 */
export function withPlacement(
  record: LearnerRecord,
  result: PlacementResult,
  graded: readonly CheckResult[],
): { readonly ok: true; readonly record: LearnerRecord } | { readonly ok: false; readonly issues: readonly string[] } {
  const skillProfile = applyPlacement(record.skillProfile, result, graded);
  const parsed = LearnerRecordSchema.safeParse({
    ...record,
    mission: result.mission,
    placements: [...(record.placements ?? []), result].slice(-PLACEMENTS_KEPT),
    curriculum: deterministicCurriculum(passedIn(skillProfile)).curriculum,
    skillProfile,
  });
  return parsed.success ? { ok: true, record: parsed.data } : { ok: false, issues: describeIssues(parsed.error) };
}

/** Whether the Learner has ever been placed (or skipped Placement at the Mission). */
export function hasPlacement(record: Pick<LearnerRecord, "placements">): boolean {
  return (record.placements ?? []).length > 0;
}
