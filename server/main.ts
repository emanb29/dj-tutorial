import { existsSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { CoachService } from "./coach/coach-service.ts";
import { requireRuntimeConfig, requireServerConfig } from "./config.ts";
import { consoleLogger } from "./logger.ts";
import { ProfileStore } from "./profile-store.ts";
import { sameOriginPolicy } from "./same-origin.ts";
import { SpendLedger } from "./spend-ledger.ts";

// The owner mounts a 1Password Environment as `.env` at the repo root. It is gitignored; values
// already in the environment win over it.
const ENV_FILE = ".env";
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const { host, port } = requireServerConfig(process.env);
const runtime = requireRuntimeConfig(process.env);

const profiles = await ProfileStore.open(runtime.dataDir);
const ledger = await SpendLedger.open(runtime.dataDir, runtime.coachMonthlyCapUsd);
const client = runtime.anthropicApiKey === null ? null : new Anthropic({ apiKey: runtime.anthropicApiKey });
if (client === null) consoleLogger.info("coach.noKey", { message: "Coach: no API key, using built-in Curriculum and lines" });

const coach = new CoachService({ client, ledger, logger: consoleLogger, logPayloads: runtime.coachLogPayloads });
const ownAddress = `${host}:${String(port)}`;
const app = createApp({
  sameOrigin: sameOriginPolicy(runtime.allowedOrigins, [ownAddress, `localhost:${String(port)}`]),
  services: { profiles, coach, logger: consoleLogger },
  originalsDir: runtime.originalsDir,
});

serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  consoleLogger.info("api.listening", {
    url: `http://${info.address}:${String(info.port)}`,
    dataDir: runtime.dataDir,
    originalsDir: runtime.originalsDir,
    coach: client === null ? "noKey" : "key",
    monthlyCapUsd: runtime.coachMonthlyCapUsd,
  });
});
