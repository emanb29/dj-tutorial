import { describe, expect, it } from "vitest";
import { DEFAULT_ALLOWED_ORIGINS, loadPublicHosts, loadRuntimeConfig, loadServerConfig } from "./config.ts";

describe("loadRuntimeConfig", () => {
  it("runs in no-key mode with a $5 cap and data under .local/data when nothing is set", () => {
    expect(loadRuntimeConfig({})).toEqual({
      ok: true,
      config: {
        dataDir: ".local/data",
        originalsDir: ".local/tracks/originals",
        musicDir: null,
        rekordboxXml: null,
        anthropicApiKey: null,
        coachMonthlyCapUsd: 5,
        coachLogPayloads: false,
        allowedOrigins: DEFAULT_ALLOWED_ORIGINS,
        publicHosts: [],
        maxLearners: 16,
      },
    });
  });

  it("treats an empty MUSIC_DIR or REKORDBOX_XML as none, so an empty value in the environment overrides .env", () => {
    const result = loadRuntimeConfig({ MUSIC_DIR: "", REKORDBOX_XML: "  " });
    expect(result.ok && [result.config.musicDir, result.config.rekordboxXml]).toEqual([null, null]);
  });

  it("treats a blank ANTHROPIC_API_KEY as no key", () => {
    const result = loadRuntimeConfig({ ANTHROPIC_API_KEY: "  " });
    expect(result.ok && result.config.anthropicApiKey).toBeNull();
  });

  it("reads every variable", () => {
    const result = loadRuntimeConfig({
      DATA_DIR: "/tmp/dj",
      ORIGINALS_DIR: "/tmp/originals",
      MUSIC_DIR: " /srv/Music ",
      REKORDBOX_XML: "/srv/rekordbox.xml",
      ANTHROPIC_API_KEY: "test-key-not-real",
      COACH_MONTHLY_CAP_USD: "2.5",
      COACH_LOG_PAYLOADS: "1",
      ALLOWED_ORIGINS: "http://127.0.0.1:5179, https://example.test",
      MAX_LEARNERS: "500",
    });
    expect(result).toEqual({
      ok: true,
      config: {
        dataDir: "/tmp/dj",
        originalsDir: "/tmp/originals",
        musicDir: "/srv/Music",
        rekordboxXml: "/srv/rekordbox.xml",
        anthropicApiKey: "test-key-not-real",
        coachMonthlyCapUsd: 2.5,
        coachLogPayloads: true,
        allowedOrigins: ["http://127.0.0.1:5179", "https://example.test"],
        publicHosts: [],
        maxLearners: 500,
      },
    });
  });

  it("reports every problem at once, without echoing the key", () => {
    const result = loadRuntimeConfig({
      ANTHROPIC_API_KEY: "test-key-not-real",
      DATA_DIR: "",
      ORIGINALS_DIR: " ",
      COACH_MONTHLY_CAP_USD: "-1",
      COACH_LOG_PAYLOADS: "yes",
      ALLOWED_ORIGINS: "http://127.0.0.1:5179/app",
      MAX_LEARNERS: "0",
      PUBLIC_HOSTS: "https://dj.example.com",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toHaveLength(7);
    expect(result.problems.join("\n")).not.toContain("test-key-not-real");
  });
});

describe("PUBLIC_HOSTS", () => {
  it("lets each public host call the API over HTTPS, besides the local defaults", () => {
    const result = loadRuntimeConfig({ PUBLIC_HOSTS: "dj.example.com, dj.example.org" });
    expect(result.ok && result.config.publicHosts).toEqual(["dj.example.com", "dj.example.org"]);
    expect(result.ok && result.config.allowedOrigins).toEqual([...DEFAULT_ALLOWED_ORIGINS, "https://dj.example.com", "https://dj.example.org"]);
  });

  it("adds nothing to ALLOWED_ORIGINS when that is set, since it lists every origin itself", () => {
    const result = loadRuntimeConfig({ PUBLIC_HOSTS: "dj.example.com", ALLOWED_ORIGINS: "http://127.0.0.1:5179" });
    expect(result.ok && result.config.allowedOrigins).toEqual(["http://127.0.0.1:5179"]);
  });

  it("refuses anything but a bare host name, naming each one", () => {
    const result = loadPublicHosts({ PUBLIC_HOSTS: "https://dj.example.com,dj.example.com/app,dj.example.com:443, ok.example.com" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toHaveLength(3);
    expect(result.problems[0]).toContain("https://dj.example.com");
  });
});

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
