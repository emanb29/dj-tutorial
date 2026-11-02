import { describe, expect, it } from "vitest";
import { AUDIUS_API_TERMS_URL, AUDIUS_PRIVACY_POLICY_URL, createAudiusSource } from "./audius.ts";
import { createRateLimiter } from "./rate-limiter.ts";
import { bytesOf, chunkedResponse, fakeDecoder, fakeFetch } from "./test-support.ts";

const BASE = "https://discovery.test";

function audiusTrack(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Track ${id}`,
    user: { name: "DJ Example", handle: "djexample" },
    duration: 300,
    genre: "House",
    bpm: 124.2,
    musical_key: "A minor",
    license: "All rights reserved",
    permalink: `/djexample/track-${id}`,
    is_streamable: true,
    is_stream_gated: false,
    stream_conditions: null,
    access: { stream: true, download: false },
    ...overrides,
  };
}

const SEARCH_RESULTS = [
  audiusTrack("a1"),
  audiusTrack("gated", { is_stream_gated: true, stream_conditions: { usdc_purchase: { price: 100 } } }),
  audiusTrack("conditions", { stream_conditions: { follow_user_id: 5 } }),
  audiusTrack("off", { is_streamable: false }),
  audiusTrack("noaccess", { access: { stream: false, download: false } }),
  { id: "broken" },
];

function audius(routes: { stream?: () => Response } = {}) {
  const clock = { nowMs: 0, sleeps: [] as number[] };
  const limiter = createRateLimiter({
    requestsPerSecond: 2,
    maxWaiting: 8,
    now: () => clock.nowMs,
    sleep: (ms) => {
      clock.sleeps.push(ms);
      clock.nowMs += ms;
      return Promise.resolve();
    },
  });
  const { fetch, calls } = fakeFetch((url) => {
    if (url.startsWith(`${BASE}/v1/tracks/search`)) return Response.json({ data: SEARCH_RESULTS });
    if (url.startsWith(`${BASE}/v1/tracks/a1/stream`)) return routes.stream?.() ?? chunkedResponse([bytesOf("ID3fake")]);
    return new Response("not found", { status: 404 });
  });
  const source = createAudiusSource({ baseUrl: BASE, fetch, decode: fakeDecoder(300).decode, limiter });
  return { source, calls, clock };
}

describe("Audius source", () => {
  it("searches the discovery node with app_name and keeps only freely streamable tracks", async () => {
    const { source, calls } = audius();

    const found = await source.search("deep house");

    expect(calls[0]?.url).toBe(`${BASE}/v1/tracks/search?query=deep+house&app_name=dj-tutorial`);
    expect(found.ok && found.value.map((track) => track.id)).toEqual(["a1"]);
  });

  it("maps a track with the artist, a link to it on Audius, and session-only retention", async () => {
    const { source } = audius();

    const found = await source.search("house");

    expect(found.ok && found.value[0]).toEqual({
      id: "a1",
      source: "audius",
      title: "Track a1",
      artist: "DJ Example",
      bpmHint: 124.2,
      keyHint: "A minor",
      genre: "House",
      licence: "All rights reserved",
      attribution: { text: '"Track a1" by DJ Example, on Audius', url: "https://audius.co/djexample/track-a1" },
      shareable: false,
      durationSec: 300,
      analysisCacheKey: null,
      retention: "session-only",
    });
  });

  it("lists what was found this session", async () => {
    const { source } = audius();

    expect(await source.list()).toEqual({ ok: true, value: [] });
    await source.search("house");
    expect((await source.list()).ok && (await source.list())).toMatchObject({ value: [{ id: "a1" }] });
  });

  it("streams the track for decoding in CORS mode, without counting a play, and keeps it in memory", async () => {
    const { source, calls } = audius();
    const found = await source.search("house");
    if (!found.ok || found.value[0] === undefined) throw new Error("search failed");

    const loaded = await source.load(found.value[0]);

    const streamCall = calls.find((call) => call.url.includes("/stream"));
    expect(streamCall?.url).toBe(`${BASE}/v1/tracks/a1/stream?app_name=dj-tutorial&skip_play_count=true`);
    expect(streamCall?.init).toMatchObject({ mode: "cors", credentials: "omit", cache: "no-store" });
    expect(loaded.ok && loaded.value.track.retention).toBe("session-only");
    expect(loaded.ok && loaded.value.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sends at most 2 requests a second", async () => {
    const { source, clock } = audius();

    await source.search("one");
    await source.search("two");
    const found = await source.search("three");
    if (!found.ok || found.value[0] === undefined) throw new Error("search failed");
    await source.load(found.value[0]);

    expect(clock.sleeps).toEqual([0, 500, 500, 500]);
  });

  it("reports a refused stream as not-streamable", async () => {
    const { source } = audius({ stream: () => new Response("", { status: 403 }) });
    const found = await source.search("house");
    if (!found.ok || found.value[0] === undefined) throw new Error("search failed");

    expect(await source.load(found.value[0])).toMatchObject({ ok: false, error: { kind: "not-streamable" } });
  });

  it("refuses a track it did not find this session", async () => {
    const { source } = audius();

    const loaded = await source.load({
      id: "gated",
      source: "audius",
      title: "Gated",
      artist: "Someone",
      attribution: { text: "", url: null },
      shareable: false,
      analysisCacheKey: null,
      retention: "session-only",
    });

    expect(loaded).toMatchObject({ ok: false, error: { kind: "not-found" } });
  });

  it("gives a notice linking Audius's privacy policy and API terms", () => {
    const { source } = audius();

    expect(source.termsNotice()).toContain(AUDIUS_PRIVACY_POLICY_URL);
    expect(source.termsNotice()).toContain(AUDIUS_API_TERMS_URL);
    expect(AUDIUS_PRIVACY_POLICY_URL).toBe("https://audius.co/legal/privacy-policy");
    expect(AUDIUS_API_TERMS_URL).toBe("https://audius.co/legal/api-terms");
  });
});
