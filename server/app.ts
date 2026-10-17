import { Hono } from "hono";
import type { ApiFailure, ApiSuccess, HealthData } from "@shared";
import { HEALTH_PATH } from "@shared";

/** Builds the API without binding a port, so tests can call it directly. */
export function createApp(): Hono {
  const app = new Hono();

  app.get(HEALTH_PATH, (context) =>
    context.json({ success: true, data: { status: "ok" } } satisfies ApiSuccess<HealthData>),
  );

  app.notFound((context) =>
    context.json(
      {
        success: false,
        error: `No API route matches ${context.req.method} ${context.req.path}.`,
      } satisfies ApiFailure,
      404,
    ),
  );

  return app;
}
