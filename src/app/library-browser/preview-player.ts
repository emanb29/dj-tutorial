// The library browser's mini player: one track's preview at a time, in an `<audio>` element of its
// own, so nothing is decoded in full and the decks and the AudioEngine are never touched (the FLX4
// stays the source of truth). Starting a preview stops the one before; one player serves every picker.
//
// - The file is opened only when the Learner presses play: a local file through an object URL
//   (revoked when the preview stops or another starts), a URL streamed with byte ranges.
// - It starts where the track says what it is (preview-start.ts) and jumps 16 bars, or 30 s.
// - It plays in the headphones when the output mode has a headphone path (preview-route.ts).
import { controllerPhonesFallback, routeToControllerPhones } from "@audio";
import type { PreviewHints, TrackPreview } from "@tracks";
import { currentOutputPlan } from "../audio-output.ts";
import { previewRoute, type PreviewRoute } from "./preview-route.ts";
import { jumpTarget, previewStart } from "./preview-start.ts";

export type PreviewStatus = "idle" | "opening" | "playing" | "paused" | "failed";

export interface PreviewSnapshot {
  /** The picker that started it (its LibraryBrowser), so it can stop its own when it goes. */
  readonly owner: symbol | null;
  /** The row's key, or null when nothing previews. */
  readonly key: string | null;
  readonly status: PreviewStatus;
  readonly positionSec: number;
  readonly durationSec: number | null;
  /** In the headphones (the cue), not the default output. */
  readonly inHeadphones: boolean;
  /** How far a jump goes: 16 bars when the grid is known, else 30 s. */
  readonly jump: "16 bars" | "30 s";
  /** Why it is not playing, and what to do. */
  readonly problem: string | null;
}

const IDLE: PreviewSnapshot = { owner: null, key: null, status: "idle", positionSec: 0, durationSec: null, inHeadphones: false, jump: "30 s", problem: null };

export interface PreviewPlayerOptions {
  readonly createAudio?: () => HTMLAudioElement;
  readonly objectUrls?: { readonly create: (file: Blob) => string; readonly revoke: (url: string) => void };
  /** Where the preview plays; by default from the Learner's output choice (src/app/audio-output.ts). */
  readonly route?: () => Promise<PreviewRoute>;
  /** A context on a device, for the FLX4's headphone jack. */
  readonly openContext?: (sinkId: string) => AudioContext;
}

interface Playing {
  readonly audio: HTMLAudioElement;
  readonly objectUrl: string | null;
  hints: PreviewHints;
  undoRoute: (() => void) | null;
}

const NEEDS_GESTURE = "The browser plays sound only after a click, tap or key on the page: press ▶ again.";
const WOULD_NOT_PLAY = "This track would not play in the browser. Try another, or load it onto a deck.";
const COULD_NOT_OPEN = "The file could not be opened: it may have been moved or deleted. Rescan the folder.";

const finite = (value: number) => (Number.isFinite(value) && value > 0 ? value : null);

function metadataLoaded(audio: HTMLAudioElement): Promise<boolean> {
  if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok: boolean) => () => {
      audio.removeEventListener("loadedmetadata", loaded);
      audio.removeEventListener("error", failed);
      resolve(ok);
    };
    const loaded = done(true);
    const failed = done(false);
    audio.addEventListener("loadedmetadata", loaded);
    audio.addEventListener("error", failed);
  });
}

export class PreviewPlayer {
  private state: PreviewSnapshot = IDLE;
  private playing: Playing | null = null;
  /** Bumped by every play and stop, so an older play that is still opening gives up. */
  private generation = 0;
  private readonly listeners = new Set<() => void>();
  private readonly createAudio: () => HTMLAudioElement;
  private readonly objectUrls: NonNullable<PreviewPlayerOptions["objectUrls"]>;
  private readonly route: () => Promise<PreviewRoute>;
  private readonly openContext: (sinkId: string) => AudioContext;

  constructor(options: PreviewPlayerOptions = {}) {
    this.createAudio = options.createAudio ?? (() => new Audio());
    this.objectUrls = options.objectUrls ?? { create: (file) => URL.createObjectURL(file), revoke: (url) => { URL.revokeObjectURL(url); } };
    this.route = options.route ?? (async () => previewRoute(await currentOutputPlan()));
    this.openContext = options.openContext ?? ((sinkId) => new AudioContext({ latencyHint: "playback", sinkId } as AudioContextOptions));
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly snapshot = (): PreviewSnapshot => this.state;

  /** Play / pause for a row's button, BROWSE press and Space: the same row pauses or goes on; another starts. */
  toggle(owner: symbol, key: string, preview: TrackPreview): Promise<void> {
    if (this.state.key === key && this.playing !== null) {
      if (this.state.status === "playing") {
        this.pause();
        return Promise.resolve();
      }
      if (this.state.status === "paused") return this.resume();
    }
    if (this.state.key === key && this.state.status === "opening") {
      this.stop();
      return Promise.resolve();
    }
    return this.play(owner, key, preview);
  }

  async play(owner: symbol, key: string, preview: TrackPreview): Promise<void> {
    this.stop();
    const generation = this.generation;
    this.set({ ...IDLE, owner, key, status: "opening" });
    const current = () => generation === this.generation;

    let source: string;
    let objectUrl: string | null = null;
    const hints = preview.hints().catch((error: unknown): PreviewHints => {
      console.warn("[library-preview] no hints for this track; it starts a third in", error);
      return {};
    });
    if (preview.media.kind === "file") {
      let file: File;
      try {
        file = await preview.media.read();
      } catch (error) {
        console.warn("[library-preview] the file could not be opened", error);
        if (current()) this.set({ ...this.state, status: "failed", problem: COULD_NOT_OPEN });
        return;
      }
      if (!current()) return;
      objectUrl = this.objectUrls.create(file);
      source = objectUrl;
    } else {
      source = preview.media.url;
    }

    const audio = this.createAudio();
    // Only what playing needs: the browser reads the file in pieces as it plays, never all of it.
    audio.preload = "metadata";
    if (objectUrl === null) audio.crossOrigin = "anonymous";
    const playing: Playing = { audio, objectUrl, hints: {}, undoRoute: null };
    this.playing = playing;
    audio.addEventListener("timeupdate", () => {
      if (this.playing === playing) this.set({ ...this.state, positionSec: audio.currentTime });
    });
    audio.addEventListener("ended", () => {
      if (this.playing === playing) this.stop();
    });
    audio.addEventListener("error", () => {
      if (this.playing === playing) this.fail(WOULD_NOT_PLAY);
    });
    audio.src = source;

    const [known, loaded, routed] = await Promise.all([hints, metadataLoaded(audio), this.routeTo(audio)]);
    if (!current()) {
      routed.undo?.();
      return;
    }
    playing.undoRoute = routed.undo;
    if (!loaded) {
      this.fail(WOULD_NOT_PLAY);
      return;
    }
    const durationSec = finite(audio.duration) ?? known.durationSec ?? null;
    playing.hints = { ...known, ...(durationSec === null ? {} : { durationSec }) };
    const start = previewStart(playing.hints);
    audio.currentTime = start.sec;
    this.set({ ...this.state, durationSec, positionSec: start.sec, inHeadphones: routed.inHeadphones, jump: playing.hints.grid === undefined ? "30 s" : "16 bars" });
    await this.start(playing);
  }

  pause(): void {
    if (this.playing === null || this.state.status !== "playing") return;
    this.playing.audio.pause();
    this.set({ ...this.state, status: "paused" });
  }

  resume(): Promise<void> {
    return this.playing === null ? Promise.resolve() : this.start(this.playing);
  }

  /** Stops the preview and lets go of its file (the object URL is revoked) and its route. */
  stop(): void {
    this.generation += 1;
    const playing = this.playing;
    this.playing = null;
    if (playing !== null) this.release(playing);
    if (this.state !== IDLE) this.set(IDLE);
  }

  /** Stops it only if `owner` started it: a picker leaving the page stops its own preview, not another's. */
  stopIfOwner(owner: symbol): void {
    if (this.state.owner === owner) this.stop();
  }

  seek(sec: number): void {
    const playing = this.playing;
    if (playing === null) return;
    const duration = this.state.durationSec;
    const to = Math.max(0, duration === null ? sec : Math.min(sec, duration));
    playing.audio.currentTime = to;
    this.set({ ...this.state, positionSec: to });
  }

  /** `by` jumps of 16 bars (30 s without a grid), back when negative. False when nothing previews. */
  jump(by: number): boolean {
    const playing = this.playing;
    if (playing === null || this.state.status === "opening") return false;
    this.seek(jumpTarget({ positionSec: playing.audio.currentTime, by, durationSec: this.state.durationSec, ...(playing.hints.grid === undefined ? {} : { grid: playing.hints.grid }) }));
    return true;
  }

  private async start(playing: Playing): Promise<void> {
    try {
      await playing.audio.play();
      if (this.playing === playing) this.set({ ...this.state, status: "playing", problem: null });
    } catch (error) {
      if (this.playing !== playing) return;
      if (error instanceof DOMException && error.name === "NotAllowedError") this.set({ ...this.state, status: "paused", problem: NEEDS_GESTURE });
      else if (!(error instanceof DOMException && error.name === "AbortError")) this.fail(WOULD_NOT_PLAY);
    }
  }

  private fail(problem: string): void {
    const playing = this.playing;
    this.playing = null;
    this.generation += 1;
    if (playing !== null) this.release(playing);
    this.set({ ...this.state, status: "failed", problem });
  }

  private release(playing: Playing): void {
    playing.audio.pause();
    playing.audio.removeAttribute("src");
    playing.audio.load();
    playing.undoRoute?.();
    if (playing.objectUrl !== null) this.objectUrls.revoke(playing.objectUrl);
  }

  /** Points the element at the headphones where the output mode has them; the default output otherwise. */
  private async routeTo(audio: HTMLAudioElement): Promise<{ readonly inHeadphones: boolean; readonly undo: (() => void) | null }> {
    const plain = { inHeadphones: false, undo: null };
    let route: PreviewRoute;
    try {
      route = await this.route();
    } catch (error) {
      console.warn("[library-preview] could not read the sound output; the preview plays on the default output", error);
      return plain;
    }
    if (route.kind === "default") return plain;
    if (route.kind === "device") {
      try {
        await audio.setSinkId(route.sinkId);
        return { inHeadphones: true, undo: null };
      } catch (error) {
        console.warn("[library-preview] the headphone device is not available; the preview plays on the default output", error);
        return plain;
      }
    }
    // The FLX4's headphone jack is its outputs 3/4, which an element cannot reach on its own.
    const context = this.openContext(route.sinkId);
    const fallback = controllerPhonesFallback("The FLX4", context.destination.maxChannelCount);
    if (fallback !== null) {
      console.warn(`[library-preview] ${fallback}; the preview plays on the default output`);
      void context.close();
      return plain;
    }
    const source = new MediaElementAudioSourceNode(context, { mediaElement: audio });
    const unroute = routeToControllerPhones(source, context);
    void context.resume();
    return {
      inHeadphones: true,
      undo: () => {
        unroute();
        source.disconnect();
        void context.close();
      },
    };
  }

  private set(next: PreviewSnapshot): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

let shared: PreviewPlayer | null = null;

/** The app's one preview player: one preview at a time, whichever picker started it. */
export function previewPlayer(): PreviewPlayer {
  shared ??= new PreviewPlayer();
  return shared;
}
