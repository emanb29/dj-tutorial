import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { z } from "zod";
import type { ApiErrorCode, ApiFailure, ApiSuccess, HealthData } from "@shared";
import { HEALTH_PATH } from "@shared";
import { CheckLineRequestSchema, CurriculumRequestSchema } from "@shared/coach-contract.ts";
import { LearnerIdSchema, LearnerRecordSchema, describeIssues, type LearnerId, type LearnerRecord } from "@shared/learner.ts";
import type { CoachService } from "./coach/coach-service.ts";
import { consoleLogger, type Logger } from "./logger.ts";
import { MAX_LEARNERS, type ProfileStore } from "./profile-store.ts";
import { requireSameOrigin, sameOriginPolicy, type SameOriginPolicy } from "./same-origin.ts";
import { DEFAULT_ALLOWED_ORIGINS } from "./config.ts";
import { originalsRoutes } from "./originals.ts";
import { ORIGINALS_PATH } from "@shared/originals.ts";

export const MAX_BODY_BYTES = 32 * 1024;

export interface AppServices {
  readonly profiles: ProfileStore;
  readonly coach: CoachService;
  readonly logger?: Logger;
  readonly now?: () => Date;
}

export interface AppOptions {
  readonly sameOrigin?: SameOriginPolicy;
  /** Without services, only the health route (and the Originals, if set) are served. */
  readonly services?: AppServices;
  /** Folder holding the generator's Originals (shared/originals.ts). Unset = no `/api/originals`. */
  readonly originalsDir?: string;
  /** Used when there are no services; otherwise `services.logger` wins. */
  readonly logger?: Logger;
}

type Status = 400 | 403 | 404 | 413 | 415 | 500;

function failure(context: Pick<Context, "json">, status: Status, code: ApiErrorCode, error: string, issues?: readonly string[]) {
  const body: ApiFailure = issues === undefined ? { success: false, error, code } : { success: false, error, code, issues };
  return context.json(body, status);
}

/** Parses a JSON body against `schema`, collecting every problem. */
async function readBody<Schema extends z.ZodType>(
  context: Context,
  schema: Schema,
): Promise<{ ok: true; value: z.output<Schema> } | { ok: false; response: Response }> {
  const contentType = context.req.header("content-type") ?? "";
  if (!/^application\/json\b/i.test(contentType)) {
    return { ok: false, response: failure(context, 415, "badRequest", "Send the body as JSON, with Content-Type: application/json.") };
  }
  let json: unknown;
  try {
    json = await context.req.json();
  } catch {
    return { ok: false, response: failure(context, 400, "badRequest", "The body is not valid JSON.") };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issues = describeIssues(parsed.error);
    return {
      ok: false,
      response: failure(context, 400, "badRequest", `The body has ${String(issues.length)} problem(s); see issues.`, issues),
    };
  }
  return { ok: true, value: parsed.data };
}

/** Builds the API without binding a port, so tests can call it directly. */
export function createApp(options: AppOptions = {}): Hono {
  const app = new Hono();
  const policy = options.sameOrigin ?? sameOriginPolicy(DEFAULT_ALLOWED_ORIGINS, []);
  const logger = options.services?.logger ?? options.logger ?? consoleLogger;

  app.use("/api/*", requireSameOrigin(policy));
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (context) =>
        failure(context, 413, "tooLarge", `The body is over ${String(MAX_BODY_BYTES / 1024)} KB. Send less.`),
    }),
  );

  app.get(HEALTH_PATH, (context) =>
    context.json({ success: true, data: { status: "ok" } } satisfies ApiSuccess<HealthData>),
  );

  if (options.services !== undefined) mountLearnerRoutes(app, options.services);
  if (options.originalsDir !== undefined) app.route(ORIGINALS_PATH, originalsRoutes(options.originalsDir, logger));

  app.notFound((context) =>
    failure(context, 404, "notFound", `No API route matches ${context.req.method} ${context.req.path}.`),
  );

  app.onError((error, context) => {
    logger.error("api.unhandled", { method: context.req.method, path: context.req.path, error: error.message });
    return failure(context, 500, "internal", "The server hit an unexpected error. The server log has the details.");
  });

  return app;
}

function mountLearnerRoutes(app: Hono, services: AppServices): void {
  const { profiles, coach } = services;
  const now = services.now ?? (() => new Date());
  const learners = new Hono<{ Variables: { learnerId: LearnerId } }>();

  learners.use("/:learnerId/*", async (context, next) => {
    const parsed = LearnerIdSchema.safeParse(context.req.param("learnerId"));
    if (!parsed.success) return failure(context, 400, "badRequest", "Invalid Learner id.", describeIssues(parsed.error));
    // PUT /profile may create a Learner; every other route needs one that exists.
    const creating = context.req.method === "PUT" && context.req.path.endsWith("/profile");
    if (!creating && !profiles.has(parsed.data)) {
      return failure(context, 404, "notFound", `No Learner "${parsed.data}". Create one with PUT …/profile.`);
    }
    context.set("learnerId", parsed.data);
    await next();
    return undefined;
  });

  learners.get("/:learnerId/profile", (context) => {
    const record = profiles.get(context.get("learnerId"));
    // The middleware checked the Learner exists, and records are never deleted.
    if (record === undefined) throw new Error("A Learner disappeared from the profile store.");
    return context.json({ success: true, data: record } satisfies ApiSuccess<LearnerRecord>);
  });

  learners.put("/:learnerId/profile", async (context) => {
    const learnerId = context.get("learnerId");
    const body = await readBody(context, LearnerRecordSchema);
    if (!body.ok) return body.response;
    if (body.value.learnerId !== learnerId) {
      return failure(context, 400, "badRequest", "The body is for another Learner.", [
        `learnerId: the body says "${body.value.learnerId}", but the path says "${learnerId}". They must match.`,
      ]);
    }
    if (!profiles.has(learnerId) && profiles.isFull) {
      return failure(context, 403, "forbidden", `The store already holds ${String(MAX_LEARNERS)} Learners. Reuse an existing Learner id.`);
    }
    await profiles.put(body.value);
    return context.json({ success: true, data: body.value } satisfies ApiSuccess<LearnerRecord>);
  });

  learners.get("/:learnerId/export", (context) => {
    const learnerId = context.get("learnerId");
    const exportedAt = now();
    const day = exportedAt.toISOString().slice(0, 10);
    context.header("Content-Disposition", `attachment; filename="learn-to-dj-${learnerId}-${day}.json"`);
    context.header("Cache-Control", "no-store");
    return context.json({
      success: true,
      data: { exportedAt: exportedAt.toISOString(), learner: profiles.get(learnerId) },
    });
  });

  learners.post("/:learnerId/coach/curriculum", async (context) => {
    const body = await readBody(context, CurriculumRequestSchema);
    if (!body.ok) return body.response;
    return context.json(await coach.curriculum(context.get("learnerId"), body.value));
  });

  learners.post("/:learnerId/coach/line", async (context) => {
    const body = await readBody(context, CheckLineRequestSchema);
    if (!body.ok) return body.response;
    return context.json(await coach.line(context.get("learnerId"), body.value));
  });

  learners.post("/:learnerId/coach/warm", async (context) => context.json(await coach.warm(context.get("learnerId"))));

  app.route("/api/learners", learners);
}
