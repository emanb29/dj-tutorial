import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";

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
    });
  });
});
