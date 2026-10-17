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
