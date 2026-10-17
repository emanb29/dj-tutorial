import { afterEach, describe, expect, it, vi } from "vitest";
import type { CheckLineRequest, CurriculumRequest } from "@shared/coach-contract.ts";
import { deterministicLine } from "@shared/coach-deterministic.ts";
import { coachLine, loadLearner, requestCurriculum } from "./api-client.ts";

const CURRICULUM_REQUEST: CurriculumRequest = { requestId: "6f1c1f0e-8a8b-4c39-9d43-1f2a3b4c5d6e", mission: "", demonstrated: [], placementResults: [], reason: "skipGroupPassed" };

const LINE_REQUEST: CheckLineRequest = {
  requestId: "6f1c1f0e-8a8b-4c39-9d43-1f2a3b4c5d6e",
  result: { lessonId: "deck-basics", mode: "lesson", variant: "full", outcome: "passed", criteria: [], metrics: {} },
  context: { lessonTitle: "Play a track out loud", focusHistory: [], bestMarginBefore: null, retentionChange: null, attemptToday: 1, missionTags: [], recentLines: [] },
};

function answering(body: unknown, status = 200) {
  const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/** A server that answers 200 with a body that is not JSON (e.g. an SPA fallback serving index.html). */
function htmlInsteadOfJson(): void {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("<!doctype html><html></html>", { status: 200, headers: { "Content-Type": "text/html" } }))));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the API client when the server answers with something that is not JSON", () => {
  it("loading the profile reports a refused problem instead of throwing (the list would wait forever)", async () => {
    htmlInsteadOfJson();
    const loaded = await loadLearner("default");
    expect(loaded).toMatchObject({ ok: false, problem: { kind: "refused", status: 200 } });
  });

  it("the Curriculum re-plan gives null (keep the current Curriculum) instead of rejecting", async () => {
    htmlInsteadOfJson();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(requestCurriculum("default", CURRICULUM_REQUEST)).resolves.toBeNull();
  });
});

describe("loading the profile", () => {
  it("says whether the server had one: an unknown Learner starts empty, on a first run", async () => {
    answering({ success: false, error: { code: "notFound", message: "No Learner" } }, 404);
    await expect(loadLearner("default")).resolves.toMatchObject({ ok: true, value: { found: false, record: { learnerId: "default", curriculum: null } } });
  });
});

describe("the Curriculum answer is checked against the shared contract", () => {
  it("accepts a well-formed answer", async () => {
    answering({ success: true, source: "fallback", data: { job: "curriculum", curriculum: ["gain-staging"], missionTags: [], electiveNotes: { "hot-cues": "for bass music" } } });
    await expect(requestCurriculum("default", CURRICULUM_REQUEST)).resolves.toMatchObject({ source: "fallback", data: { curriculum: ["gain-staging"] } });
  });

  it("refuses elective notes for a Lesson that is not an elective", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    answering({ success: true, source: "llm", data: { job: "curriculum", curriculum: [], missionTags: [], electiveNotes: { "gain-staging": "?" } } });
    await expect(requestCurriculum("default", CURRICULUM_REQUEST)).resolves.toBeNull();
  });
});

describe("the post-Check Coach line", () => {
  it("does not send a request whose result is already gone (aborted), and gives the built-in line", async () => {
    const fetch = answering({ success: true, data: { job: "checkLine", line: "Nice." } });
    const abort = new AbortController();
    abort.abort();
    await expect(coachLine("default", LINE_REQUEST, abort.signal)).resolves.toBe(deterministicLine(LINE_REQUEST));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the Coach's line when the answer has the contract's shape", async () => {
    answering({ success: true, source: "llm", data: { job: "checkLine", line: "Clean fade." } });
    await expect(coachLine("default", LINE_REQUEST, new AbortController().signal)).resolves.toBe("Clean fade.");
  });

  it("logs the HTTP status of a refused answer and falls back", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    answering({ success: false, error: "nope" }, 503);
    await expect(coachLine("default", LINE_REQUEST, new AbortController().signal)).resolves.toBe(deterministicLine(LINE_REQUEST));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("HTTP 503"));
  });

  it("logs an answer of the wrong shape and falls back", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    answering({ success: true, data: { job: "checkLine", line: "" } });
    await expect(coachLine("default", LINE_REQUEST, new AbortController().signal)).resolves.toBe(deterministicLine(LINE_REQUEST));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("shape"));
  });
});
