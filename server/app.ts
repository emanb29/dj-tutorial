import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { z } from "zod";
import type { ApiErrorCode, ApiFailure, ApiSuccess, HealthData } from "@shared";
import { HEALTH_PATH } from "@shared";
import { CheckLineRequestSchema, CurriculumRequestSchema } from "@shared/coach-contract.ts";
import {
  FINAL_PROJECT_MIME_TYPES,
  LearnerIdSchema,
  LearnerRecordSchema,
  MAX_FINAL_PROJECT_BYTES,
  describeIssues,
  type FinalProjectMimeType,
  type LearnerId,
  type LearnerRecord,
} from "@shared/learner.ts";
import type { CoachService } from "./coach/coach-service.ts";
import type { FinalProjectStore } from "./final-projects.ts";
import type { AudioExporter } from "./audio-export.ts";
import { EXPORT_FORMATS, EXPORT_STATUS_PATH, exportFileName, exportTags, type ExportStatus } from "@shared/final-project-export.ts";
import { RateLimiter, type BucketRule } from "./rate-limiter.ts";
import { consoleLogger, type Logger } from "./logger.ts";
import type { ProfileStore } from "./profile-store.ts";
import { requireSameOrigin, sameOriginPolicy, type SameOriginPolicy } from "./same-origin.ts";
import { DEFAULT_ALLOWED_ORIGINS } from "./config.ts";
import { originalsRoutes } from "./originals.ts";
import { ORIGINALS_PATH } from "@shared/originals.ts";

export const MAX_BODY_BYTES = 32 * 1024;
/**
 * A profile is saved whole and grows with every attempt and Placement (32 KB after 9 Lessons). The store
 * keeps at most `MAX_LEARNERS` of them, so the file stays bounded at this times that.
 */
export const MAX_PROFILE_BODY_BYTES = 1024 * 1024;
const PROFILE_PATH = /^\/api\/learners\/[^/]+\/profile$/;
const FINAL_PROJECT_AUDIO_PATH = /^\/api\/learners\/[^/]+\/final-project\/audio$/;

export interface AppServices {
  readonly profiles: ProfileStore;
  readonly coach: CoachService;
  /** The final project's audio, one file per Learner. Unset = no `…/final-project/audio` route. */
  readonly finalProjects?: FinalProjectStore;
  /** ffmpeg, found (or not) at startup. Unset = exports report "unavailable". */
  readonly audioExport?: AudioExporter;
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

type Status = 400 | 403 | 404 | 413 | 415 | 429 | 500 | 503 | 504;

/** Each export runs ffmpeg for up to two minutes: 3 at once, then 12 an hour per Learner. */
export const EXPORT_RATE_RULE: BucketRule = { burst: 3, perWindow: 12, windowMs: 60 * 60_000 };
const EXPORT_FAILURE_STATUS = { unavailable: 503, timedOut: 504, tooLarge: 413, failed: 500 } as const;

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
  const jsonLimit = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (context) => failure(context, 413, "tooLarge", `The body is over ${String(MAX_BODY_BYTES / 1024)} KB. Send less.`),
  });
  const profileLimit = bodyLimit({
    maxSize: MAX_PROFILE_BODY_BYTES,
    onError: (context) => failure(context, 413, "tooLarge", `The profile is over ${String(MAX_PROFILE_BODY_BYTES / 1024 / 1024)} MB. Export it and report this.`),
  });
  const audioLimit = bodyLimit({
    maxSize: MAX_FINAL_PROJECT_BYTES,
    onError: (context) =>
      failure(context, 413, "tooLarge", `The recording is over ${String(MAX_FINAL_PROJECT_BYTES / 1024 / 1024)} MB. Record a shorter set.`),
  });
  // The final project's audio and the whole profile are the bodies that are not small; each has its own (bounded) limit.
  const limits: MiddlewareHandler = (context, next) =>
    FINAL_PROJECT_AUDIO_PATH.test(context.req.path) ? audioLimit(context, next) : PROFILE_PATH.test(context.req.path) ? profileLimit(context, next) : jsonLimit(context, next);
  app.use("/api/*", limits);

  app.get(HEALTH_PATH, (context) =>
    context.json({ success: true, data: { status: "ok" } } satisfies ApiSuccess<HealthData>),
  );

  app.get(EXPORT_STATUS_PATH, (context) => {
    const status: ExportStatus = options.services?.audioExport?.status ?? { available: false, reason: "The server was started without the audio export. Restart it with `npm run dev`." };
    return context.json({ success: true, data: status } satisfies ApiSuccess<ExportStatus>);
  });

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
      return failure(context, 403, "forbidden", `The store already holds ${String(profiles.maxLearners)} Learners. Reuse an existing Learner id.`);
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

  const { finalProjects } = services;
  if (finalProjects !== undefined) {
    learners.put("/:learnerId/final-project/audio", async (context) => {
      const mimeType = (context.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
      if (!(FINAL_PROJECT_MIME_TYPES as readonly string[]).includes(mimeType)) {
        return failure(context, 415, "badRequest", `Send the recording as ${FINAL_PROJECT_MIME_TYPES.join(", ")}; got "${mimeType}".`);
      }
      const bytes = new Uint8Array(await context.req.arrayBuffer());
      if (bytes.byteLength === 0) return failure(context, 400, "badRequest", "The recording is empty. Record the set again.");
      const meta = await finalProjects.put(context.get("learnerId"), mimeType as FinalProjectMimeType, bytes);
      return context.json({ success: true, data: meta });
    });

    learners.get("/:learnerId/final-project/audio", async (context) => {
      const learnerId = context.get("learnerId");
      const kept = await finalProjects.get(learnerId);
      if (kept === undefined) return failure(context, 404, "notFound", `Learner "${learnerId}" has kept no final project yet.`);
      const extension = kept.meta.mimeType.split("/")[1] ?? "audio";
      return context.body(new Uint8Array(kept.bytes), 200, {
        "Content-Type": kept.meta.mimeType,
        "Content-Disposition": `attachment; filename="learn-to-dj-${learnerId}-final-project.${extension === "mp4" ? "m4a" : extension}"`,
        "Cache-Control": "no-store",
      });
    });
  }

  if (finalProjects !== undefined) {
    const exportLimiter = new RateLimiter(() => now().getTime());
    for (const format of EXPORT_FORMATS) {
      learners.get(`/:learnerId/final-project/export.${format}`, async (context) => {
        const learnerId = context.get("learnerId");
        const exporter = services.audioExport;
        if (!exporter?.status.available) {
          return failure(context, 503, "unavailable", exporter?.status.available === false ? exporter.status.reason : "The server was started without the audio export. Restart it with `npm run dev`.");
        }
        const project = profiles.get(learnerId)?.finalProject;
        const stored = await finalProjects.audioFile(learnerId);
        if (project === undefined || stored === undefined) return failure(context, 404, "notFound", `Learner "${learnerId}" has kept no final project yet. Keep a set first.`);
        if (!exportLimiter.tryTake(learnerId, EXPORT_RATE_RULE)) {
          return failure(context, 429, "rateLimited", "Too many downloads in the last hour. Use the file you already downloaded, or wait a few minutes.");
        }
        const result = await exporter.transcode(stored.path, format, exportTags(project));
        if (!result.ok) {
          services.logger?.warn("export.failed", { learnerId, format, kind: result.failure.kind, message: result.failure.message });
          return failure(context, EXPORT_FAILURE_STATUS[result.failure.kind], result.failure.kind === "tooLarge" ? "tooLarge" : "unavailable", result.failure.message);
        }
        return context.body(result.body, 200, {
          "Content-Type": format === "mp3" ? "audio/mpeg" : "audio/wav",
          "Content-Length": String(result.bytes),
          "Content-Disposition": `attachment; filename="${exportFileName(project, format)}"`,
          "Cache-Control": "no-store",
        });
      });
    }
  }

  learners.post("/:learnerId/coach/warm", async (context) => context.json(await coach.warm(context.get("learnerId"))));

  app.route("/api/learners", learners);
}
