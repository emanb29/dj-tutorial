# learn-to-dj

An interactive wizard that teaches DJing, controller-first and tuned for ADHD. It introduces one or two concepts at a time on a simulated two-deck controller that grows toward a real one (DDJ-FLX4 layout). Music comes from Audius, local files and a Creative Commons starter pack; Spotify is used for metadata only. The DDJ-FLX4 works as a hardware controller over Web MIDI (see below). The map is "Map: Learn to DJ v1" in Linear (ISS-46).

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
- `npm run test:e2e`: builds, then runs Playwright against `vite preview` on 4179 and the API on 4180, so it never clashes with a dev server. The Originals player (`/originals`) is tested on its own pair, 4181 and 4182, over a tiny fixture folder the spec writes. `E2E_APP_PORT`, `E2E_API_PORT`, `E2E_ORIGINALS_APP_PORT` and `E2E_ORIGINALS_API_PORT` move those four ports, so parallel runs (other agents) don't collide: `E2E_APP_PORT=4279 E2E_API_PORT=4280 E2E_ORIGINALS_APP_PORT=4281 E2E_ORIGINALS_API_PORT=4282 npm run test:e2e`.

The API reads `API_HOST` and `API_PORT` (defaults `127.0.0.1`, `5180`). It also reads, from the environment or a `.env` file at the repo root (the owner's mounted 1Password Environment; gitignored, never commit it): `ANTHROPIC_API_KEY` (optional; unset = no-key mode, the deterministic Coach answers everything), `COACH_MONTHLY_CAP_USD` (default `5`), `COACH_LOG_PAYLOADS` (`1` logs Coach payloads; default off), `DATA_DIR` (profile store and spend ledger; default `.local/data`), `ORIGINALS_DIR` (the generator's Originals served under `/api/originals`; default `.local/tracks/originals`) `ALLOWED_ORIGINS` (comma-separated; default the dev app, the tunnel and the e2e preview) and `MAX_LEARNERS` (profile store size; default `16`, the e2e API sets `1000`). Tests never call the Anthropic API: they inject a client with faked HTTP (`server/test-support.ts`). Tests never play sound: Chromium runs with `--mute-audio` and audio tests render through `OfflineAudioContext`. `prototypes/` and `spikes/` are outside the build, the lint and the tests.

## Hardware controller (DDJ-FLX4) and sound output

- `src/midi/` owns Web MIDI: `connection.ts` (the one `requestMIDIAccess`, finds the port named `DDJ-FLX4`), `decoder.ts` (MIDI to what was touched, per AlphaTheta's list in `docs/research/flx4-midi.md`), `encoder.ts` (LEDs), `soft-takeover.ts`, `jog.ts`. All pure except `connection.ts`.
- `src/app/controller/hardware.ts` feeds decoded input into the same `ControllerSession` as the screen and keyboard: one lock check, device `"midi"`, the MIDI message's `timeStamp` as the event time (same clock as a key press; a 0 or implausible stamp falls back to the handler's time, `src/midi/event-time.ts`). Locked controls say "Not yet" on screen. Mapping choices the list does not make (TAP, MASTER TEMPO) are at the top of that file, with a TODO for loops, Beat FX and pad modes.
- The whole app works from the FLX4, no keyboard or mouse. BROWSE and LOAD are never the decks': `src/app/ControllerNavigation.tsx` (mounted once, every page) moves a large focus ring and presses the keys pages already listen for. The table is `src/app/controller/flx4-keys.ts`, the one source: captions (`inputWording`, "then R / LOAD B"), hints (`KeyHint.tsx`) and the `/controller` legend all read it. The DOM side is `focus-navigation.ts`; pages mark `data-nav-skip` (the on-screen controller), `data-nav-start` (an overlay where the ring starts), `data-nav-default` (LOAD A with no ring: the next Lesson's Start) and `data-nav-back`, and a page that handles a key calls `preventDefault()` so the fallback (Enter presses the ring's button, Esc the back button) does not run too.

  | FLX4 | Does | Key |
  | --- | --- | --- |
  | BROWSE turn | moves the ring between buttons (Freestyle: between tracks); on a list or slider being changed, its value | Tab |
  | BROWSE press | presses the button with the ring; on a list or slider, starts or ends changing it | Space |
  | SHIFT + BROWSE press | back: leaves, closes, skips | Esc |
  | LOAD A | go: into the Check, again, next, start; Freestyle: loads the track with the ring onto A | Enter |
  | LOAD B | Ready; Freestyle: loads it onto B (a playing deck refuses) | R |
  | SHIFT + LOAD A | practice | P |
  | SHIFT + LOAD B | Not yet (Placement) | N |

  TAP is SHIFT + BEAT ▶, plus the borrowed pads and BEAT ◀ / ▶; the BROWSE press is no longer TAP (one meaning per control). Typing and picking a file need the keyboard, mouse or screen, and the page says so when the ring is on one. Starting the sound needs one click, tap or key per page load: browsers do not count MIDI as a gesture.
- The FLX4 cannot report its fader and knob positions (no such message in AlphaTheta's list). `src/midi/positions.ts` remembers each control once it has moved, so a controller on screen shows pickup marks at once. The unofficial Mixxx SysEx position request got no answer from the owner's FLX4-N, so the app does not send it.
- While the FLX4 is connected, the hardware is the source of truth (`src/app/lesson/hardware-sync.ts`). A set-up never turns a fader or knob in software to anywhere the hardware is known not to be. Neutral values, and every known control the set-up doesn't name, are taken from the hardware. Deliberate ones show the "Match your controller" step (`SetUpStep.tsx`), which ticks items off live and goes on once all match, or on Skip. A set-up step of the Lesson's own (`CheckPlan.setUp`, `practiceSetUp`: "Set up: CUE 🎧 B on, fader B up") is the same step with its caption, made from its asks (`src/lessons/set-up-asks.ts`), so every thing the caption names is read off the decks and the mixer, with or without the FLX4. Its items leave out the controls the asks set. Deck A loops its first phrase and the Learner's moves still count. Once every item has ticked and every ask is done, the caption says "All set" and the step goes on by itself where the phrase comes round, so the Check's clock starts on a phrase start. R goes at once once the items tick; Skip goes without them. The table of which set-up field is which is at the top of that file. A new `DeckSetup` field must be classified there; the type check and `hardware-sync.test.ts` enforce it. Listening clips and phrase previews still play in software, and the hardware is adopted again when they stop.
- Timing check (Controller page): the Learner's tap latency per browser and output mode (`src/app/timing-offset.ts`), taken off every input's time in `AudioEngine.command` (`src/audio/input-latency.ts`, ±150 ms). It is not the two-device headphone offset.
- Sound output is engine-owned: `src/audio/output.ts` (the five modes: split cue, through the FLX4, two devices, this computer's speakers with the FLX4's headphones, and PC MASTER OUT: the master on the FLX4 and this computer at once, as in rekordbox, graded on this computer's clock), `device-monitors.ts`, `output-routing.ts`. The Learner picks on `/controller`; the choice is in `localStorage` (`src/app/audio-output.ts`). Nothing switches output by itself.
- Tests never need hardware or real devices: unit tests feed the list's bytes, `hardware.browser.test.ts` drives a real offline engine, and `e2e/hardware.spec.ts` replaces `navigator.requestMIDIAccess` and `enumerateDevices` in an init script.

## Dev server and remote access

The owner often develops remotely. Every dev server for this project (the app, or the prototype under `prototypes/`) binds `127.0.0.1:5179` with `strictPort`, and lists `dj.example.com` in Vite's `server.allowedHosts`. A reverse proxy forwards `https://dj.example.com` to it, behind the owner's passkey or password. Only one dev server can hold port 5179 at a time.

## CI and the live site

CI (`.github/workflows/ci.yml`) reports one status to wait on or require: `ci-ok`. On a pull request it runs `check` (typecheck, lint, every unit and browser test) and only the end-to-end specs the diff can affect, chosen by `scripts/e2e-affected.ts` from the rules in `scripts/e2e-spec-map.ts`. A shared path (`src/audio`, `src/app/lesson`, `shared`, `server`, `e2e` helpers, config, …) or any path no rule names runs the whole suite; docs and tests alone run none. A new spec must be named in the map (a unit test fails otherwise). `node scripts/e2e-affected.ts origin/main` shows what a branch would run. Pushes to main and manual runs play the whole suite, sharded.

The owner's live dev server (`dj.example.com`) runs from the main checkout at the project root, and Vite and tsx hot-reload whatever it holds. `scripts/follow-green-main.sh` fast-forwards that checkout to the newest main commit whose CI push run passed, never past it; it refuses when the tree is dirty or off main, and does nothing when already there.

### When to wait for CI (owner policy, 2026-10-17)

- **Gated:** a change touching grading, timing or the audio engine (`src/audio`, `src/checks`, `src/app/lesson/lesson-session.ts`, `shared/attempt.ts`), or how a profile is stored (`shared/learner.ts`, `server/`). It merges only on a green `ci-ok`, and the live checkout follows green main.
- **Expedited:** anything else (screens, layout, captions, content, track selection, new optional features). Before pushing, run `npm run typecheck`, `npm run lint` and the tests for the files you touched. The PR then merges without waiting for CI, and the live checkout fast-forwards to the merge at once (`git merge --ff-only`), ahead of green main.
- If main's full run then fails, fix it or revert it before merging anything else, and tell the owner.
- Never tell the owner a change is live until the live checkout holds it.
