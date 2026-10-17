// The deterministic Coach (docs/coach-design.md §1–2, §4). The browser uses it directly in no-key
// mode, and the server uses it as the fallback for every model call, so the two cannot disagree.
// Pure functions only: no I/O, no clock.
import {
  ELECTIVE_IDS,
  FINAL_LESSON_ID,
  REQUIRED_LESSON_IDS,
  catalogueIndex,
  lessonById,
  type ElectiveId,
  type LessonId,
} from "./catalogue.ts";
import type { CriterionId, StandingId } from "./check-types.ts";
import type {
  CheckLineRequest,
  CoachCheckSummary,
  CoachCriterion,
  CurriculumData,
  CurriculumOutput,
} from "./coach-contract.ts";

// ---------------------------------------------------------------------------------------------
// Curriculum (job a)
// ---------------------------------------------------------------------------------------------

/** The required route: catalogue order minus demonstrated Lessons. `final-mix` is never skipped. */
export function requiredRoute(demonstrated: readonly LessonId[]): LessonId[] {
  const done = new Set(demonstrated);
  return REQUIRED_LESSON_IDS.filter((id) => id === FINAL_LESSON_ID || !done.has(id));
}

/** Electives the Learner has not demonstrated, in catalogue order. */
export function availableElectives(demonstrated: readonly LessonId[]): ElectiveId[] {
  const done = new Set<LessonId>(demonstrated);
  return ELECTIVE_IDS.filter((id) => !done.has(id));
}

/** Where an elective goes: after `placeAfter`, or at the start when `placeAfter` is `null`. */
export interface ElectivePlacement {
  readonly lessonId: ElectiveId;
  readonly placeAfter: LessonId | null;
}

/**
 * Inserts electives after their anchors. Electives sharing an anchor keep catalogue order.
 * Placements whose anchor is not in the route are a programming error and crash.
 */
export function mergeCurriculum(
  route: readonly LessonId[],
  placements: readonly ElectivePlacement[],
): LessonId[] {
  const byCatalogue = [...placements].sort((a, b) => catalogueIndex(a.lessonId) - catalogueIndex(b.lessonId));
  for (const placement of byCatalogue) {
    if (placement.placeAfter !== null && !route.includes(placement.placeAfter)) {
      throw new Error(`Elective ${placement.lessonId} is anchored to ${placement.placeAfter}, which is not in the route.`);
    }
  }
  const after = (anchor: LessonId | null) =>
    byCatalogue.filter((placement) => placement.placeAfter === anchor).map((placement) => placement.lessonId);
  return [...after(null), ...route.flatMap((id) => [id, ...after(id)])];
}

/** Each available elective right after the last of its prerequisites in the route. */
export function deterministicPlacements(
  route: readonly LessonId[],
  electives: readonly ElectiveId[],
): ElectivePlacement[] {
  return electives.map((lessonId) => {
    const positions = lessonById(lessonId)
      .prerequisites.map((prerequisite) => route.indexOf(prerequisite))
      .filter((position) => position >= 0);
    const last = positions.length === 0 ? null : (route[Math.max(...positions)] ?? null);
    return { lessonId, placeAfter: last };
  });
}

/** The no-key Curriculum: every available elective included, placed by its prerequisites. */
export function deterministicCurriculum(demonstrated: readonly LessonId[]): CurriculumData {
  const route = requiredRoute(demonstrated);
  const placements = deterministicPlacements(route, availableElectives(demonstrated));
  return { job: "curriculum", curriculum: mergeCurriculum(route, placements), missionTags: [], electiveNotes: {} };
}

export const WHY_MAX_CHARS = 120;

/**
 * The server-side rules for the model's Curriculum output (coach-design §2.2). Returns every
 * broken rule, each naming the rule, so a rejection can be logged honestly. Empty = valid.
 */
export function curriculumOutputProblems(output: CurriculumOutput, demonstrated: readonly LessonId[]): string[] {
  const route = requiredRoute(demonstrated);
  const available = availableElectives(demonstrated);
  const done = new Set(demonstrated);
  const problems: string[] = [];

  for (const id of available) {
    const count = output.electives.filter((elective) => elective.lessonId === id).length;
    if (count !== 1) problems.push(`rule 1: available elective ${id} appears ${String(count)} times; it must appear once.`);
  }
  for (const elective of output.electives) {
    if (!available.includes(elective.lessonId)) {
      problems.push(`rule 1: elective ${elective.lessonId} is not available (already demonstrated).`);
    }
  }

  for (const elective of output.electives.filter((candidate) => candidate.include)) {
    if (elective.placeAfter === FINAL_LESSON_ID) {
      problems.push(`rule 3: ${elective.lessonId} is placed after final-mix, which must stay last.`);
      continue;
    }
    const anchorPosition = route.indexOf(elective.placeAfter);
    if (anchorPosition < 0) {
      problems.push(`rule 2: ${elective.lessonId} is placed after ${elective.placeAfter}, which is not in the route.`);
      continue;
    }
    for (const prerequisite of lessonById(elective.lessonId).prerequisites) {
      const position = route.indexOf(prerequisite);
      if (!done.has(prerequisite) && (position < 0 || position > anchorPosition)) {
        problems.push(`rule 2: ${elective.lessonId} would come before its prerequisite ${prerequisite}.`);
      }
    }
  }

  for (const elective of output.electives) {
    const why = elective.why;
    if (why.length < 1 || why.length > WHY_MAX_CHARS || /[\r\n]/.test(why)) {
      problems.push(`rule 4: the "why" for ${elective.lessonId} must be 1–${String(WHY_MAX_CHARS)} characters on one line.`);
    }
  }
  return problems;
}

/** Merges validated model output. Call only when `curriculumOutputProblems` returned nothing. */
export function curriculumFromOutput(output: CurriculumOutput, demonstrated: readonly LessonId[]): CurriculumData {
  const included = output.electives.filter((elective) => elective.include);
  const curriculum = mergeCurriculum(
    requiredRoute(demonstrated),
    included.map(({ lessonId, placeAfter }) => ({ lessonId, placeAfter })),
  );
  const electiveNotes: Partial<Record<ElectiveId, string>> = Object.fromEntries(
    included.map((elective) => [elective.lessonId, elective.why]),
  );
  return { job: "curriculum", curriculum, missionTags: [...new Set(output.missionTags)], electiveNotes };
}

// ---------------------------------------------------------------------------------------------
// Post-Check line (job b)
// ---------------------------------------------------------------------------------------------

const STANDING_PLAIN_NAMES: Readonly<Record<StandingId, string>> = {
  "no-clip": "staying out of the red",
  "no-dead-air": "no dead air",
  "on-phrase": "starting on the phrase",
  "level-match": "matching the levels",
  "cued-first": "cueing in headphones first",
  "trim-still": "leaving the trim alone",
  "no-boost": "cutting, not boosting, the EQ",
  "controls-reset": "resetting EQ, filter and FX",
  "sync-kept": "keeping sync on",
  "no-recue": "nudging instead of re-cueing",
  "one-bass": "one bassline at a time",
  drift: "holding the blend in phase",
  overcorrect: "small tempo corrections",
  "key-clash": "key-compatible tracks",
  "technique-mix": "mixing up your transitions",
};

/** A plain-language name for a criterion. Lesson criteria use their kebab-case name as words. */
export function criterionPlainName(id: CriterionId): string {
  const [scope, name = ""] = id.split(".", 2) as [string, string | undefined];
  if (scope === "standing") return STANDING_PLAIN_NAMES[name as StandingId];
  return name.replaceAll("-", " ");
}

const MARGIN_THIN = 0.15;

/** Up to `max` criteria the line can be about: not-met first (fail severity first), then thin margins. */
export function focusCriteria(result: CoachCheckSummary, max = 4): CoachCriterion[] {
  const severityRank = { fail: 0, warn: 1, report: 2 } as const;
  const rank = (criterion: CoachCriterion) => [
    criterion.status === "notMet" ? 0 : 1,
    severityRank[criterion.severity],
    criterion.margin ?? Number.POSITIVE_INFINITY,
  ] as const;
  return [...result.criteria]
    .sort((a, b) => {
      const [ra, rb] = [rank(a), rank(b)];
      return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2];
    })
    .slice(0, max);
}

type LineSituation = "failedOne" | "failedSeveral" | "passedRetained" | "passedThin" | "passedClean";

const LINE_TEMPLATES: Readonly<Record<LineSituation, readonly string[]>> = {
  failedOne: [
    "Almost: just {criterion}. Everything else held.",
    "One thing to fix: {criterion}. The rest was there.",
    "So close. Put your attention on {criterion} next time.",
  ],
  failedSeveral: [
    "Start with {criterion}; the rest gets easier once that holds.",
    "Pick one thing for the next try: {criterion}.",
    "Next attempt, think only about {criterion}.",
  ],
  passedRetained: [
    "Still there after a break: {criterion} held up.",
    "You kept it. {criterion} came back without the Lesson.",
  ],
  passedThin: [
    "In. {criterion} was close: that's the one to tighten next time.",
    "Passed, with {criterion} near the edge. Tighten that one.",
    "You're through. Next time, give {criterion} a little more room.",
  ],
  passedClean: [
    "Clean pass. Keep that same feel next time.",
    "That one held together well. On to the next.",
    "Solid. Everything landed with room to spare.",
  ],
};

function lineSituation(request: CheckLineRequest, focus: CoachCriterion | undefined): LineSituation {
  const failedCount = request.result.criteria.filter((criterion) => criterion.status === "notMet").length;
  if (request.result.outcome === "failed") return failedCount > 1 ? "failedSeveral" : "failedOne";
  if (request.context.retentionChange?.startsWith("retained") === true && focus !== undefined) return "passedRetained";
  if (focus?.margin !== null && focus?.margin !== undefined && focus.margin < MARGIN_THIN) return "passedThin";
  return "passedClean";
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The canned post-Check line: a template by situation, rotated against the last lines shown. */
export function deterministicLine(request: CheckLineRequest): string {
  const focus = focusCriteria(request.result, 1)[0];
  const templates = LINE_TEMPLATES[lineSituation(request, focus)];
  const name = focus === undefined ? "that" : criterionPlainName(focus.id);
  const lines = templates.map((template) => {
    const filled = template.replace("{criterion}", name);
    return template.startsWith("{criterion}") ? capitalise(filled) : filled;
  });
  const recent = new Set(request.context.recentLines.map(normaliseLine));
  const start = request.context.attemptToday % lines.length;
  const rotated = [...lines.slice(start), ...lines.slice(0, start)];
  return rotated.find((line) => !recent.has(normaliseLine(line))) ?? rotated[0] ?? "";
}

function normaliseLine(line: string): string {
  return line.trim().toLowerCase();
}

export const LINE_MAX_CHARS = 110;
export const LINE_MAX_WORDS = 18;

/** Every number that appears in a value (recursively), as written and rounded, for the number rule. */
export function numbersIn(value: unknown): Set<string> {
  const found = new Set<string>();
  const add = (n: number) => {
    for (const candidate of [n, Math.abs(n)]) {
      found.add(String(candidate));
      found.add(String(Math.round(candidate)));
      found.add(String(Math.round(candidate * 10) / 10));
      found.add(String(Math.round(candidate * 100) / 100));
    }
  };
  const visit = (node: unknown): void => {
    if (typeof node === "number") add(node);
    else if (typeof node === "string") for (const match of node.match(/\d+(?:\.\d+)?/g) ?? []) add(Number(match));
    else if (Array.isArray(node)) node.forEach(visit);
    else if (typeof node === "object" && node !== null) Object.values(node).forEach(visit);
  };
  visit(value);
  return found;
}

/**
 * The server-side rules for a model's line (coach-design §2.3). `modelInput` is exactly what the
 * model was shown, so any number in the line must come from it. Returns every broken rule.
 */
export function lineProblems(line: string, request: CheckLineRequest, modelInput: unknown): string[] {
  const text = line.trim();
  const problems: string[] = [];
  if (text.length < 1 || text.length > LINE_MAX_CHARS) {
    problems.push(`length: ${String(text.length)} characters; it must be 1–${String(LINE_MAX_CHARS)}.`);
  }
  if (/[\r\n]/.test(text)) problems.push("lines: the line must be a single line.");
  if (text.split(/\s+/).filter(Boolean).length > LINE_MAX_WORDS) {
    problems.push(`words: more than ${String(LINE_MAX_WORDS)} words.`);
  }
  const allowed = numbersIn(modelInput);
  for (const number of text.match(/\d+(?:\.\d+)?/g) ?? []) {
    if (!allowed.has(String(Number(number)))) problems.push(`numbers: ${number} is not in the input.`);
  }
  if (request.result.outcome === "passed" && /\bfail(ed|s|ing)?\b|missed it/i.test(text)) {
    problems.push("outcome: a passed result must not say it failed.");
  }
  if (request.result.outcome === "failed" && /\bpass(ed)?\b|\bnailed\b/i.test(text)) {
    problems.push("outcome: a failed result must not say it passed.");
  }
  if (/\b(score|grade)s?\b/i.test(text)) problems.push('voice: never say "score" or "grade".');
  if (request.context.recentLines.some((recent) => normaliseLine(recent) === normaliseLine(text))) {
    problems.push("repeat: identical to one of the last lines shown.");
  }
  return problems;
}
