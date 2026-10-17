// The Learner's record and the Coach line, through the local API (server/app.ts). The server may be
// down: the profile then lives in memory for the session and the Coach falls back to its built-in
// line (coach-design §4, no-key mode), so a Lesson never waits on the network.
import { z } from "zod";
import type { CurriculumAnswer } from "@lessons";
import { LessonIdSchema } from "@shared/check-types.ts";
import { learnerPaths, type CheckLineRequest, type CurriculumRequest } from "@shared/coach-contract.ts";
import { deterministicLine } from "@shared/coach-deterministic.ts";
import { emptyLearnerRecord, LearnerRecordSchema, type LearnerId, type LearnerRecord } from "@shared/learner.ts";
import { MissionTagSchema } from "@shared/mission.ts";

export type ApiProblem = { readonly kind: "offline"; readonly message: string } | { readonly kind: "refused"; readonly status: number; readonly message: string };

export type Loaded<Value> = { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly problem: ApiProblem };

/**
 * The body as JSON; undefined when it is not JSON or could not be read (an SPA fallback page, a
 * timeout mid-body). The caller's schema then rejects it and reports the problem.
 */
async function jsonOrUndefined(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

const RecordEnvelope =z.object({ success: z.literal(true), data: LearnerRecordSchema });

/** The Learner's record; a Learner the server has never seen starts empty. */
export async function loadLearner(learnerId: LearnerId, signal?: AbortSignal): Promise<Loaded<LearnerRecord>> {
  let response: Response;
  try {
    response = await fetch(learnerPaths.profile(learnerId), { signal: signal ?? null, credentials: "same-origin" });
  } catch (error) {
    return { ok: false, problem: { kind: "offline", message: `The API is not reachable (${String(error)}). Start it with npm run dev.` } };
  }
  if (response.status === 404) return { ok: true, value: emptyLearnerRecord(learnerId) };
  if (!response.ok) {
    return { ok: false, problem: { kind: "refused", status: response.status, message: `Loading the profile failed with HTTP ${String(response.status)}; the server log says why.` } };
  }
  const parsed = RecordEnvelope.safeParse(await jsonOrUndefined(response));
  if (!parsed.success) {
    return { ok: false, problem: { kind: "refused", status: response.status, message: "The server sent a profile this app cannot read. Check that the server and app versions match." } };
  }
  return { ok: true, value: parsed.data.data };
}

export async function saveLearner(record: LearnerRecord): Promise<Loaded<LearnerRecord>> {
  let response: Response;
  try {
    response = await fetch(learnerPaths.profile(record.learnerId), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
      credentials: "same-origin",
    });
  } catch (error) {
    return { ok: false, problem: { kind: "offline", message: `The API is not reachable (${String(error)}); progress is kept for this session only.` } };
  }
  if (!response.ok) {
    return { ok: false, problem: { kind: "refused", status: response.status, message: `Saving the profile failed with HTTP ${String(response.status)}; the server log says why.` } };
  }
  return { ok: true, value: record };
}

/** A background re-plan may take the server's whole retry budget (coach-design §3: ~95 s). */
export const CURRICULUM_DEADLINE_MS = 120_000;

const CurriculumEnvelope = z.object({
  success: z.literal(true),
  source: z.enum(["llm", "fallback"]),
  data: z.object({
    job: z.literal("curriculum"),
    curriculum: z.array(LessonIdSchema),
    missionTags: z.array(MissionTagSchema),
    electiveNotes: z.record(z.string(), z.string()),
  }),
});

/**
 * Asks the Coach for a new Curriculum. Null when the API is unreachable or refuses: the old
 * Curriculum stays, and the next skip-group pass tries again (coach-design §2.2).
 */
export async function requestCurriculum(learnerId: LearnerId, request: CurriculumRequest): Promise<CurriculumAnswer | null> {
  let response: Response;
  try {
    response = await fetch(learnerPaths.curriculum(learnerId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(CURRICULUM_DEADLINE_MS),
      credentials: "same-origin",
    });
  } catch (error) {
    console.warn(`[coach] the Curriculum re-plan did not reach the API (${String(error)}); keeping the current Curriculum.`);
    return null;
  }
  const parsed = response.ok ? CurriculumEnvelope.safeParse(await jsonOrUndefined(response)) : null;
  if (parsed?.success !== true) {
    console.warn(`[coach] the Curriculum re-plan failed (HTTP ${String(response.status)}); keeping the current Curriculum. The server log says why.`);
    return null;
  }
  return { source: parsed.data.source, data: parsed.data.data };
}

/** The line fills at min(Coach answers, this) and never changes after it appears (coach-design §2.3). */
export const COACH_LINE_DEADLINE_MS = 1200;

const LineEnvelope = z.object({ success: z.literal(true), data: z.object({ job: z.literal("checkLine"), line: z.string().min(1) }) });

/**
 * The post-Check line: the Coach's if it answers within the deadline, else the deterministic one,
 * computed up front so it is ready at once.
 */
export async function coachLine(learnerId: LearnerId, request: CheckLineRequest, signal: AbortSignal): Promise<string> {
  const fallback = deterministicLine(request);
  const deadline = new AbortController();
  const abort = () => {
    deadline.abort();
  };
  signal.addEventListener("abort", abort);
  const timer = setTimeout(abort, COACH_LINE_DEADLINE_MS);
  try {
    const response = await fetch(learnerPaths.line(learnerId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      signal: deadline.signal,
      credentials: "same-origin",
    });
    if (!response.ok) return fallback;
    const parsed = LineEnvelope.safeParse(await response.json());
    return parsed.success ? parsed.data.data.line : fallback;
  } catch {
    // Late, offline or aborted: the built-in line is the answer (an expected condition, not an error).
    return fallback;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
