# learn-to-dj

An interactive wizard that teaches DJing, controller-first and tuned for ADHD. It introduces one or two concepts at a time on a simulated two-deck controller that grows toward a real one (DDJ-FLX4 layout). Music comes from Audius, local files and a Creative Commons starter pack; Spotify is used for metadata only. Hardware controller support is a later effort. The map is "Map: Learn to DJ v1" in Linear (ISS-46).

## Agent skills

### Issue tracker

Issues are tracked in Linear, in the Learn to DJ project (team Emanb29, key `ISS`), through the `linear-server` MCP tools. See `docs/agents/issue-tracker.md`.

### Triage labels

The default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Commands

The stack is in `docs/adr/0001-v1-stack.md`. Node 24 (`.nvmrc`).

- `npm run dev`: the app on `127.0.0.1:5179` (Vite) and the API on `127.0.0.1:5180` (Hono, `server/`), together. Vite proxies `/api` to the API. Vite fails rather than moving if 5179 is taken.
- `npm run build`: builds the app into `dist/`.
- `npm run typecheck`, `npm run lint`: TypeScript (strict) and ESLint.
- `npm test`: Vitest. `*.test.ts` runs in Node; `*.browser.test.ts` runs in Chromium (Vitest browser mode), for Web Audio and `OfflineAudioContext`.
- `npm run test:e2e`: builds, then runs Playwright against `vite preview` on 4179 and the API on 4180, so it never clashes with a dev server.

The API reads `API_HOST` and `API_PORT` (defaults `127.0.0.1`, `5180`). Tests never play sound: Chromium runs with `--mute-audio` and audio tests render through `OfflineAudioContext`. `prototypes/` and `spikes/` are outside the build, the lint and the tests.

## Dev server and remote access

The owner often develops remotely. Every dev server for this project (the app, or the prototype under `prototypes/`) binds `127.0.0.1:5179` with `strictPort`, and lists `dj.example.com` in Vite's `server.allowedHosts`. A reverse proxy forwards `https://dj.example.com` to it, behind the owner's passkey or password. Only one dev server can hold port 5179 at a time.
