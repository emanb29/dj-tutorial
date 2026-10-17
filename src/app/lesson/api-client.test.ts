import { afterEach, describe, expect, it, vi } from "vitest";
import type { CurriculumRequest } from "@shared/coach-contract.ts";
import { loadLearner, requestCurriculum } from "./api-client.ts";

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
    const request: CurriculumRequest = { requestId: "6f1c1f0e-8a8b-4c39-9d43-1f2a3b4c5d6e", mission: "", demonstrated: [], placementResults: [], reason: "skipGroupPassed" };
    await expect(requestCurriculum("default", request)).resolves.toBeNull();
  });
});
