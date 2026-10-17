// The Learner's record and the Coach line, through the local API (server/app.ts). The server may be
// down: the profile then lives in memory for the session and the Coach falls back to its built-in
// line (coach-design §4, no-key mode), so a Lesson never waits on the network.
import { z } from "zod";
import { learnerPaths, type CheckLineRequest } from "@shared/coach-contract.ts";
import { deterministicLine } from "@shared/coach-deterministic.ts";
import { emptyLearnerRecord, LearnerRecordSchema, type LearnerId, type LearnerRecord } from "@shared/learner.ts";

export type ApiProblem = { readonly kind: "offline"; readonly message: string } | { readonly kind: "refused"; readonly status: number; readonly message: string };

export type Loaded<Value> = { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly problem: ApiProblem };

const RecordEnvelope = z.object({ success: z.literal(true), data: LearnerRecordSchema });

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
  const parsed = RecordEnvelope.safeParse(await response.json());
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
