import { describe, expect, it } from "vitest";
import { loadServerConfig } from "./config.ts";

describe("loadServerConfig", () => {
  it("defaults to 127.0.0.1:5180 when the environment sets nothing", () => {
    expect(loadServerConfig({})).toEqual({
      ok: true,
      config: { host: "127.0.0.1", port: 5180 },
    });
  });

  it("reads API_HOST and API_PORT from the environment", () => {
    expect(loadServerConfig({ API_HOST: "0.0.0.0", API_PORT: "4180" })).toEqual({
      ok: true,
      config: { host: "0.0.0.0", port: 4180 },
    });
  });

  it("reports every problem at once, each with a fix", () => {
    const result = loadServerConfig({ API_HOST: " ", API_PORT: "80a" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toHaveLength(2);
    expect(result.problems[0]).toMatch(/API_HOST/);
    expect(result.problems[1]).toMatch(/API_PORT.*"80a".*1 and 65535/);
  });

  it("rejects a port outside 1-65535", () => {
    const result = loadServerConfig({ API_PORT: "70000" });

    expect(result.ok).toBe(false);
  });
});
