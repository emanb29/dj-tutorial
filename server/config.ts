/** Where the API server listens. Vite's dev and preview proxies read the same values. */
export interface ServerConfig {
  readonly host: string;
  readonly port: number;
}

export type ServerConfigResult =
  | { readonly ok: true; readonly config: ServerConfig }
  | { readonly ok: false; readonly problems: readonly string[] };

export const DEFAULT_API_HOST = "127.0.0.1";
export const DEFAULT_API_PORT = 5180;

type Environment = Readonly<Record<string, string | undefined>>;

/** Reads `API_HOST` and `API_PORT`, collecting every problem instead of stopping at the first. */
export function loadServerConfig(env: Environment): ServerConfigResult {
  const problems: string[] = [];

  const rawHost = env["API_HOST"];
  const host = rawHost === undefined ? DEFAULT_API_HOST : rawHost.trim();
  if (host === "") {
    problems.push(
      `API_HOST is set but empty. Unset it to use ${DEFAULT_API_HOST}, or set it to an address such as 127.0.0.1.`,
    );
  }

  const rawPort = env["API_PORT"];
  const port = rawPort === undefined ? DEFAULT_API_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(
      `API_PORT is "${rawPort ?? ""}", but it must be a whole number between 1 and 65535. Unset it to use ${String(DEFAULT_API_PORT)}.`,
    );
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, config: { host, port } };
}

export class ServerConfigError extends Error {
  override readonly name = "ServerConfigError";

  constructor(readonly problems: readonly string[]) {
    super(`The API server configuration is invalid:\n- ${problems.join("\n- ")}`);
  }
}

/** For entry points: returns the config or throws, since nothing can run without it. */
export function requireServerConfig(env: Environment): ServerConfig {
  const result = loadServerConfig(env);
  if (!result.ok) throw new ServerConfigError(result.problems);
  return result.config;
}

/** Pages that may call the API: the dev app, the owner's tunnel and the end-to-end preview. */
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
  "http://127.0.0.1:5179",
  "https://dj.example.com",
  "http://127.0.0.1:4179",
];
export const DEFAULT_DATA_DIR = ".local/data";
export const DEFAULT_ORIGINALS_DIR = ".local/tracks/originals";
export const DEFAULT_COACH_MONTHLY_CAP_USD = 5;

/** Everything else the API needs: storage, the Coach key and its spend cap, and who may call it. */
export interface RuntimeConfig {
  readonly dataDir: string;
  /** The generator's Originals, served under /api/originals. */
  readonly originalsDir: string;
  /** `null` = no-key mode: every Coach answer comes from the deterministic Coach. */
  readonly anthropicApiKey: string | null;
  readonly coachMonthlyCapUsd: number;
  readonly coachLogPayloads: boolean;
  readonly allowedOrigins: readonly string[];
}

export type RuntimeConfigResult =
  | { readonly ok: true; readonly config: RuntimeConfig }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Reads `DATA_DIR`, `ORIGINALS_DIR`, `ANTHROPIC_API_KEY`, `COACH_MONTHLY_CAP_USD`, `COACH_LOG_PAYLOADS` and
 * `ALLOWED_ORIGINS`, collecting every problem. Problems never include the key's value.
 */
export function loadRuntimeConfig(env: Environment): RuntimeConfigResult {
  const problems: string[] = [];

  const rawDataDir = env["DATA_DIR"];
  const dataDir = rawDataDir === undefined ? DEFAULT_DATA_DIR : rawDataDir.trim();
  if (dataDir === "") {
    problems.push(`DATA_DIR is set but empty. Unset it to use ${DEFAULT_DATA_DIR}, or set it to a directory.`);
  }

  const rawOriginalsDir = env["ORIGINALS_DIR"];
  const originalsDir = rawOriginalsDir === undefined ? DEFAULT_ORIGINALS_DIR : rawOriginalsDir.trim();
  if (originalsDir === "") {
    problems.push(`ORIGINALS_DIR is set but empty. Unset it to use ${DEFAULT_ORIGINALS_DIR}, or set it to a directory.`);
  }

  const rawKey = env["ANTHROPIC_API_KEY"]?.trim();
  const anthropicApiKey = rawKey === undefined || rawKey === "" ? null : rawKey;

  const rawCap = env["COACH_MONTHLY_CAP_USD"];
  const coachMonthlyCapUsd = rawCap === undefined ? DEFAULT_COACH_MONTHLY_CAP_USD : Number(rawCap);
  if (rawCap !== undefined && (rawCap.trim() === "" || !Number.isFinite(coachMonthlyCapUsd) || coachMonthlyCapUsd < 0)) {
    problems.push(
      `COACH_MONTHLY_CAP_USD is "${rawCap}", but it must be a number of US dollars, 0 or more (0 stops all model calls). Unset it to use ${String(DEFAULT_COACH_MONTHLY_CAP_USD)}.`,
    );
  }

  const rawLogPayloads = env["COACH_LOG_PAYLOADS"];
  if (rawLogPayloads !== undefined && !["0", "1"].includes(rawLogPayloads)) {
    problems.push(`COACH_LOG_PAYLOADS is "${rawLogPayloads}", but it must be 1 (log Coach payloads) or 0. Unset it for 0.`);
  }

  const rawOrigins = env["ALLOWED_ORIGINS"];
  const allowedOrigins =
    rawOrigins === undefined
      ? DEFAULT_ALLOWED_ORIGINS
      : rawOrigins
          .split(",")
          .map((origin) => origin.trim())
          .filter((origin) => origin !== "");
  for (const origin of allowedOrigins) {
    if (!isOrigin(origin)) {
      problems.push(
        `ALLOWED_ORIGINS contains "${origin}", which is not an origin. Use comma-separated values like http://127.0.0.1:5179 (scheme, host and port, no path).`,
      );
    }
  }
  if (rawOrigins !== undefined && allowedOrigins.length === 0) {
    problems.push(`ALLOWED_ORIGINS is set but lists no origin. Unset it to use ${DEFAULT_ALLOWED_ORIGINS.join(",")}.`);
  }

  return problems.length > 0
    ? { ok: false, problems }
    : {
        ok: true,
        config: {
          dataDir,
          originalsDir,
          anthropicApiKey,
          coachMonthlyCapUsd,
          coachLogPayloads: rawLogPayloads === "1",
          allowedOrigins,
        },
      };
}

function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}

/** For entry points: returns the config or throws, since nothing can run without it. */
export function requireRuntimeConfig(env: Environment): RuntimeConfig {
  const result = loadRuntimeConfig(env);
  if (!result.ok) throw new ServerConfigError(result.problems);
  return result.config;
}
