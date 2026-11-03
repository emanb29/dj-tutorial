// Test helpers: a real Anthropic client whose HTTP is faked, so tests run the SDK's own request
// building, timeouts and error classes without any network call or spend.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { Hono } from "hono";
import { createApp } from "./app.ts";
import { CoachService, type CoachTimings } from "./coach/coach-service.ts";
import { memoryLogger } from "./logger.ts";
import { FinalProjectStore } from "./final-projects.ts";
import type { AudioExporter } from "./audio-export.ts";
import { ProfileStore } from "./profile-store.ts";
import { RenderStore } from "./renders.ts";
import { sameOriginPolicy } from "./same-origin.ts";
import { SpendLedger } from "./spend-ledger.ts";

export const APP_ORIGIN = "http://127.0.0.1:5179";

export interface FakeReply {
  readonly status?: number;
  readonly body?: unknown;
  /** Waits this long before answering, unless the request is aborted first. */
  readonly delayMs?: number;
}

export interface RecordedRequest {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

/** Answers each Messages API request with the next reply in `replies` (the last one repeats). */
export function fakeAnthropic(replies: readonly FakeReply[]) {
  const requests: RecordedRequest[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const index = Math.min(requests.length, replies.length - 1);
    const reply = replies[index] ?? { status: 500, body: {} };
    requests.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      headers: new Headers(init?.headers),
      body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>,
    });
    if (reply.delayMs !== undefined) {
      const signal = init?.signal;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, reply.delayMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("The request was aborted.", "AbortError"));
        });
      });
    }
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", "request-id": `req_${String(requests.length)}` },
    });
  };
  const client = new Anthropic({ apiKey: "test-key-not-real", fetch, maxRetries: 0 });
  return { client, requests };
}

export function messageReply(options: {
  text: string;
  model?: string;
  stopReason?: string;
  usage?: Partial<Record<"input_tokens" | "output_tokens" | "cache_creation_input_tokens" | "cache_read_input_tokens", number>>;
}): FakeReply {
  return {
    body: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: options.model ?? "claude-haiku-5-5",
      content: options.text === "" ? [] : [{ type: "text", text: options.text }],
      stop_reason: options.stopReason ?? "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        ...options.usage,
      },
    },
  };
}

export interface TestServer {
  readonly app: Hono;
  readonly dataDir: string;
  readonly ledger: SpendLedger;
  readonly logger: ReturnType<typeof memoryLogger>;
  readonly profiles: ProfileStore;
  close(): Promise<void>;
}

export async function startTestServer(options: {
  client: Anthropic | null;
  capUsd?: number;
  timings?: Partial<CoachTimings>;
  now?: () => Date;
  audioExport?: AudioExporter;
  /** Serve `/api/renders` too, from a store in the test's data folder. */
  renders?: boolean;
}): Promise<TestServer> {
  const dataDir = await mkdtemp(join(tmpdir(), "ltd-app-"));
  const profiles = await ProfileStore.open(dataDir);
  const ledger = await SpendLedger.open(dataDir, options.capUsd ?? 5);
  const logger = memoryLogger();
  const now = options.now ?? (() => new Date("2026-10-17T12:00:00Z"));
  const coach = new CoachService({
    client: options.client,
    ledger,
    logger,
    now,
    ...(options.timings === undefined ? {} : { timings: options.timings }),
  });
  const renders = options.renders === true ? await RenderStore.open(dataDir, () => now().getTime()) : undefined;
  const app = createApp({
    sameOrigin: sameOriginPolicy([APP_ORIGIN], ["127.0.0.1:5180"]),
    services: {
      profiles,
      coach,
      logger,
      now,
      finalProjects: FinalProjectStore.forDataDir(dataDir, now),
      ...(options.audioExport === undefined ? {} : { audioExport: options.audioExport }),
      ...(renders === undefined ? {} : { renders }),
    },
  });
  return {
    app,
    dataDir,
    ledger,
    logger,
    profiles,
    close: () => rm(dataDir, { recursive: true, force: true }),
  };
}

/** A request as the app's own page would send it. */
export function appRequest(app: Hono, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const method = init.method ?? (init.body === undefined ? "GET" : "POST");
  const headers: Record<string, string> = {
    ...(method === "GET" ? {} : { origin: APP_ORIGIN }),
    ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    ...init.headers,
  };
  return app.request(path, {
    method,
    headers,
    ...(init.body === undefined ? {} : { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) }),
  });
}
