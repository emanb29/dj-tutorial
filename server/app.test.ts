import { afterEach, describe, expect, it } from "vitest";
import { emptyLearnerRecord } from "@shared/learner.ts";
import { createApp } from "./app.ts";
import { ProfileStore } from "./profile-store.ts";
import { APP_ORIGIN, appRequest, startTestServer, type TestServer } from "./test-support.ts";

let server: TestServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("GET /api/health", () => {
  it("answers 200 with an ok status in the response envelope", async () => {
    const response = await createApp().request("/api/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { status: "ok" } });
  });

  it("answers unknown API routes with a 404 error envelope", async () => {
    const response = await createApp().request("/api/nope");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      success: false,
      error: "No API route matches GET /api/nope.",
      code: "notFound",
    });
  });
});

describe("same-origin guard", () => {
  it("refuses a cross-site Origin and sends no CORS headers", async () => {
    server = await startTestServer({ client: null });

    const response = await server.app.request("/api/learners/default/profile", {
      headers: { origin: "http://evil.test" },
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.json()).toMatchObject({ success: false, code: "forbidden" });
  });

  it("refuses a state-changing request without an Origin", async () => {
    server = await startTestServer({ client: null });

    const response = await appRequest(server.app, "/api/learners/default/coach/warm", {
      method: "POST",
      headers: { origin: "" },
    });
    const withoutOrigin = await server.app.request("/api/learners/default/coach/warm", { method: "POST" });

    expect(response.status).toBe(403);
    expect(withoutOrigin.status).toBe(403);
  });

  it("refuses same-site and cross-site fetches, such as another port on 127.0.0.1", async () => {
    server = await startTestServer({ client: null });

    const sameSite = await server.app.request("/api/learners/default/profile", { headers: { "sec-fetch-site": "same-site" } });
    const crossSite = await server.app.request("/api/learners/default/profile", { headers: { "sec-fetch-site": "cross-site" } });

    expect([sameSite.status, crossSite.status]).toEqual([403, 403]);
  });

  it("refuses an unknown Host, which stops DNS rebinding", async () => {
    server = await startTestServer({ client: null });

    const rebound = await server.app.request("/api/learners/default/profile", { headers: { host: "evil.test:5180" } });
    const proxied = await server.app.request("/api/learners/default/profile", { headers: { host: "127.0.0.1:5179" } });

    expect(rebound.status).toBe(403);
    expect(proxied.status).toBe(200);
  });

  it("allows the app's own page", async () => {
    server = await startTestServer({ client: null });

    const response = await server.app.request("/api/learners/default/profile", {
      headers: { origin: APP_ORIGIN, "sec-fetch-site": "same-origin" },
    });

    expect(response.status).toBe(200);
  });
});

describe("Learner profile routes", () => {
  it("returns the default Learner's record", async () => {
    server = await startTestServer({ client: null });

    const response = await appRequest(server.app, "/api/learners/default/profile");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: emptyLearnerRecord("default") });
  });

  it("answers 404 for an unknown Learner and 400 for an invalid id", async () => {
    server = await startTestServer({ client: null });

    const unknown = await appRequest(server.app, "/api/learners/nobody/profile");
    const invalid = await appRequest(server.app, "/api/learners/Not_Valid/profile");

    expect(unknown.status).toBe(404);
    expect(invalid.status).toBe(400);
  });

  it("saves a valid record to disk", async () => {
    server = await startTestServer({ client: null });
    const record = {
      ...emptyLearnerRecord("default"),
      mission: "post my own mixes to SoundCloud",
      missionTags: ["record-mixes"],
      curriculum: ["deck-basics", "final-mix"],
    };

    const response = await appRequest(server.app, "/api/learners/default/profile", { method: "PUT", body: record });

    expect(response.status).toBe(200);
    expect((await ProfileStore.open(server.dataDir)).get("default")).toEqual(record);
  });

  it("creates a second Learner with PUT", async () => {
    server = await startTestServer({ client: null });

    const created = await appRequest(server.app, "/api/learners/guest/profile", {
      method: "PUT",
      body: emptyLearnerRecord("guest"),
    });
    const read = await appRequest(server.app, "/api/learners/guest/profile");

    expect([created.status, read.status]).toEqual([200, 200]);
  });

  it("refuses a new Learner once the store holds 16", async () => {
    server = await startTestServer({ client: null });
    for (let index = 1; index < 16; index += 1) {
      await server.profiles.put(emptyLearnerRecord(`learner-${String(index)}`));
    }

    const response = await appRequest(server.app, "/api/learners/one-too-many/profile", {
      method: "PUT",
      body: emptyLearnerRecord("one-too-many"),
    });
    const update = await appRequest(server.app, "/api/learners/default/profile", {
      method: "PUT",
      body: emptyLearnerRecord("default"),
    });

    expect([response.status, update.status]).toEqual([403, 200]);
  });

  it("rejects an invalid record with every problem listed, and saves nothing", async () => {
    server = await startTestServer({ client: null });

    const response = await appRequest(server.app, "/api/learners/default/profile", {
      method: "PUT",
      body: { ...emptyLearnerRecord("default"), mission: 7, missionTags: ["clubbing"], extra: true },
    });
    const body = (await response.json()) as { code: string; issues: string[] };

    expect(response.status).toBe(400);
    expect(body.code).toBe("badRequest");
    expect(body.issues).toHaveLength(3);
    expect(server.profiles.get("default")).toEqual(emptyLearnerRecord("default"));
  });

  it("rejects a body for another Learner", async () => {
    server = await startTestServer({ client: null });

    const response = await appRequest(server.app, "/api/learners/default/profile", {
      method: "PUT",
      body: emptyLearnerRecord("guest"),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      issues: ['learnerId: the body says "guest", but the path says "default". They must match.'],
    });
  });

  it("rejects a body that is not JSON, or too large", async () => {
    server = await startTestServer({ client: null });

    const wrongType = await appRequest(server.app, "/api/learners/default/profile", {
      method: "PUT",
      body: "{}",
      headers: { "content-type": "text/plain" },
    });
    const badJson = await appRequest(server.app, "/api/learners/default/profile", { method: "PUT", body: "{ nope" });
    const tooLarge = await appRequest(server.app, "/api/learners/default/profile", {
      method: "PUT",
      body: JSON.stringify({ padding: "x".repeat(33 * 1024) }),
    });

    expect([wrongType.status, badJson.status, tooLarge.status]).toEqual([415, 400, 413]);
  });

  it("exports the record as a download", async () => {
    server = await startTestServer({ client: null });

    const response = await appRequest(server.app, "/api/learners/default/export");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="learn-to-dj-default-2026-10-17.json"',
    );
    expect(await response.json()).toEqual({
      success: true,
      data: { exportedAt: "2026-10-17T12:00:00.000Z", learner: emptyLearnerRecord("default") },
    });
  });
});
