// The Render's audio to the API (server/renders.ts): a sink that starts a Render on the server and
// uploads each segment in order, retrying a dropped request a couple of times.
import type { ApiFailure, ApiSuccess } from "@shared";
import { renderPath, renderSegmentPath, RENDERS_PATH, type RenderSession } from "@shared/mix-render.ts";
import type { RenderSink } from "./render.ts";

/** A dropped upload is tried again this many times, waiting longer each time. */
const RETRY_DELAYS_MS = [500, 2000];

export class RenderApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "RenderApiError";
  }
}

async function call(path: string, init: RequestInit): Promise<RenderSession> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(path, { ...init, credentials: "same-origin" });
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) throw new RenderApiError(`The app's server is not reachable (${String(error)})`, null);
      console.warn("[mix-render] an upload was dropped; trying again", { path, attempt: attempt + 1 });
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }
    const body = (await response.json().catch(() => null)) as ApiSuccess<RenderSession> | ApiFailure | null;
    if (response.ok && body?.success === true) return body.data;
    const delay = response.status >= 500 ? RETRY_DELAYS_MS[attempt] : undefined;
    if (delay === undefined) throw new RenderApiError(body?.success === false ? body.error : `The server answered HTTP ${String(response.status)}`, response.status);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

/** Uploads a Render to the API. `session` is the server's view of it once begun. */
export class ApiRenderSink implements RenderSink {
  session: RenderSession | null = null;

  constructor(private readonly about: { readonly name: string; readonly tracks: readonly string[] }) {}

  async begin(info: { readonly frames: number; readonly sampleRate: number }): Promise<void> {
    this.session = await call(RENDERS_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: this.about.name, tracks: this.about.tracks, sampleRate: info.sampleRate, frames: info.frames }),
    });
  }

  async segment(index: number, pcm: Uint8Array<ArrayBuffer>): Promise<void> {
    const { session } = this;
    if (session === null) throw new Error("A segment came before the Render began: call begin() first.");
    this.session = await call(renderSegmentPath(session.id, index), { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: pcm });
  }

  /** Drops an unfinished (or unwanted) Render from the server. */
  async drop(): Promise<void> {
    const { session } = this;
    if (session === null) return;
    this.session = null;
    try {
      await fetch(renderPath(session.id), { method: "DELETE", credentials: "same-origin" });
    } catch (error) {
      // Recovered: the server drops an idle Render after an hour anyway.
      console.warn("[mix-render] the unfinished Render could not be dropped from the server", { error });
    }
  }
}
