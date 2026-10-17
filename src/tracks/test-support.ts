// Test helpers for track sources: a recorded fake fetch and a fake decoder. Nothing is played.
import type { AudioDecoder } from "./load-audio.ts";

export interface RecordedFetch {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

export type FakeRoute = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

/** A fetch that answers with `route` and records every call. Honours an already-aborted signal. */
export function fakeFetch(route: FakeRoute) {
  const calls: RecordedFetch[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    if (init?.signal?.aborted === true) throw new DOMException("The operation was aborted.", "AbortError");
    return route(url, init);
  };
  return { fetch, calls };
}

/** A Response whose body arrives in `chunks`, with a Content-Length. */
export function chunkedResponse(chunks: readonly Uint8Array[], init: ResponseInit = {}): Response {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const headers = new Headers(init.headers);
  headers.set("content-length", String(total));
  return new Response(body, { ...init, headers });
}

/** A decoder that returns a stand-in AudioBuffer of `durationSec`, or fails when the bytes start with "BAD". */
export function fakeDecoder(durationSec = 2) {
  const decoded: Uint8Array[] = [];
  const decode: AudioDecoder = (bytes) => {
    const view = new Uint8Array(bytes);
    decoded.push(view.slice());
    if (new TextDecoder().decode(view.subarray(0, 3)) === "BAD") return Promise.reject(new Error("Unable to decode audio data"));
    const buffer = { duration: durationSec, sampleRate: 44_100, numberOfChannels: 2, length: durationSec * 44_100 };
    return Promise.resolve(buffer as AudioBuffer);
  };
  return { decode, decoded };
}

export const bytesOf = (text: string) => new TextEncoder().encode(text);
