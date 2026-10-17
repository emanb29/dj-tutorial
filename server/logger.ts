/** One JSON line per event. Callers must never pass the API key or, by default, Learner payloads. */
export interface Logger {
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
  error(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

function write(level: "info" | "warn" | "error", event: string, fields: Readonly<Record<string, unknown>> = {}) {
  const line = JSON.stringify({ time: new Date().toISOString(), level, event, ...fields });
  if (level === "info") console.log(line);
  else if (level === "warn") console.warn(line);
  else console.error(line);
}

export const consoleLogger: Logger = {
  info: (event, fields) => {
    write("info", event, fields);
  },
  warn: (event, fields) => {
    write("warn", event, fields);
  },
  error: (event, fields) => {
    write("error", event, fields);
  },
};

export interface LoggedEvent {
  readonly level: "info" | "warn" | "error";
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

/** A logger that keeps events in memory, for tests. */
export function memoryLogger(): Logger & { readonly events: LoggedEvent[] } {
  const events: LoggedEvent[] = [];
  const push = (level: LoggedEvent["level"]) => (event: string, fields: Readonly<Record<string, unknown>> = {}) => {
    events.push({ level, event, fields });
  };
  return { events, info: push("info"), warn: push("warn"), error: push("error") };
}
