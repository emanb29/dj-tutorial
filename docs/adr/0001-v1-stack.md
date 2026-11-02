# 1. v1 stack: Vite + React + TypeScript, an audio engine outside React, a Hono server, and a cross-origin-isolated page

Status: accepted (2026-10-16)

## Context

The app has two decks, a two-channel mixer and about 30 controls. Meters and playheads update every frame, and grading needs timing accurate to a few milliseconds. Track analysis runs Beat This! with onnxruntime-web on 4 WASM threads, which need `SharedArrayBuffer` (see `spike/beat-this` RESULTS.md). The Coach needs a key-holding server, and the Skill profile lives on disk, keyed by `LearnerId`. The app must also work remotely, through a reverse proxy or tunnel in front of `127.0.0.1:5179` (`PUBLIC_HOSTS`).

## Decision

- **Client:** Vite, React 19 and TypeScript (strict), in a single npm package. React renders structure: the controller layout, Lessons, result cards. **Nothing audio-rate goes through React state.** Meters, playheads and the phase strip draw from the engine on `requestAnimationFrame`.
- **Audio engine:** a plain TypeScript module, `src/audio`, that owns the only `AudioContext`. It contains two decks, the mixer (trim, 3-band isolator EQ, filter, channel faders, crossfader, master), split-cue monitor routing behind a `MonitorOutput` interface, AudioWorklet meters (LUFS and sample peak), playhead models and an attempt recorder. Tempo changes use `playbackRate` with key lock off, and signalsmith-stretch with Master Tempo on. The UI talks to the engine through a small command and event API, so a MIDI controller can drive the same API later.
- **Analysis:** a Web Worker (`src/analysis`) runs Beat This! small0 through onnxruntime-web WASM on 4 threads, then the least-squares grid fit and the phase refine. The dj-core TypeScript port is the fallback for four-on-the-floor music. Results are cached per track. Audius audio is never persisted.
- **Checks:** pure functions in `src/checks` over a recorded attempt, shared by the client and the eval scripts.
- **Server:** Hono on Node 24, at `127.0.0.1:5180`, proxied by Vite under `/api`. It serves `/api/coach` and `/api/profile`, all keyed by `learnerId`, and keeps the profile store and spend ledger on disk under `.local/`. The key comes from the environment or `.env`. A deterministic Coach module in `shared/` is used by both sides.
- **Cross-origin isolation:** the page is served with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`. This enables threads while still allowing CORS-enabled audio from archive.org and Audius, which both send `ACAO *`.
- **Tests:** Vitest for units, with Checks and DSP tested against `OfflineAudioContext` in Vitest browser mode. Playwright end-to-end runs with audio muted. ESLint uses `typescript-eslint` strict, `no-throw-literal` and `@typescript-eslint/only-throw-error`. CI is GitHub Actions running typecheck, lint, unit and end-to-end tests.

## Consequences

- Audio-rate work never blocks on React re-renders, and hardware control later is a new input adapter, not a rewrite.
- COOP/COEP means every third-party resource must be CORS or CORP-clean. Embedding the YouTube or SoundCloud players would break isolation; that's acceptable, since neither is a track source.
- Analysis takes about 30 s and about 1 GB per new track. The UI must show it as background progress and never block a Lesson on it. Curated track sets ship with precomputed grids.
