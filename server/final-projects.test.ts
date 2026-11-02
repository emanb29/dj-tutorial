import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_FINAL_PROJECT_BYTES } from "@shared/learner.ts";
import { FINAL_PROJECTS_DIR } from "./final-projects.ts";
import { APP_ORIGIN, startTestServer, type TestServer } from "./test-support.ts";

let server: TestServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

const PATH = "/api/learners/default/final-project/audio";

function upload(test: TestServer, body: Uint8Array<ArrayBuffer>, contentType = "audio/webm;codecs=opus", path = PATH) {
  return test.app.request(path, { method: "PUT", headers: { origin: APP_ORIGIN, "content-type": contentType }, body });
}

describe("the final project's audio", () => {
  it("keeps one recording per Learner and gives it back as a download, replacing the last one", async () => {
    server = await startTestServer({ client: null });
    const first = await upload(server, new Uint8Array([1, 2, 3]));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ success: true, data: { mimeType: "audio/webm", bytes: 3, savedAt: "2026-10-17T12:00:00.000Z" } });

    expect((await upload(server, new Uint8Array([9, 8]), "audio/ogg")).status).toBe(200);
    const download = await server.app.request(PATH);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("audio/ogg");
    expect(download.headers.get("content-disposition")).toContain('filename="dj-tutorial-default-final-project.ogg"');
    expect([...new Uint8Array(await download.arrayBuffer())]).toEqual([9, 8]);
    // Bounded: one audio file and its metadata per Learner, no leftovers.
    expect((await readdir(join(server.dataDir, FINAL_PROJECTS_DIR))).sort()).toEqual(["default.audio", "default.json"]);
  });

  it("answers 404 before anything is kept, and for a Learner that does not exist", async () => {
    server = await startTestServer({ client: null });
    expect((await server.app.request(PATH)).status).toBe(404);
    expect((await upload(server, new Uint8Array([1]), "audio/webm", "/api/learners/nobody/final-project/audio")).status).toBe(404);
  });

  it("refuses other content types, empty bodies, a body over the limit, and a write from another origin", async () => {
    server = await startTestServer({ client: null });
    expect((await upload(server, new Uint8Array([1]), "application/json")).status).toBe(415);
    expect((await upload(server, new Uint8Array([]))).status).toBe(400);
    const tooLarge = await upload(server, new Uint8Array(MAX_FINAL_PROJECT_BYTES + 1));
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toMatchObject({ code: "tooLarge" });
    const crossSite = await server.app.request(PATH, { method: "PUT", headers: { origin: "http://evil.test", "content-type": "audio/webm" }, body: new Uint8Array([1]) });
    expect(crossSite.status).toBe(403);
  });

  it("still limits JSON bodies on the other small-JSON routes to 32 KB", async () => {
    server = await startTestServer({ client: null });
    const response = await server.app.request("/api/learners/default/coach/line", {
      method: "POST",
      headers: { origin: APP_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(40 * 1024) }),
    });
    expect(response.status).toBe(413);
  });
});
