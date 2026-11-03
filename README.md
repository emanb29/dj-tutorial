# dj-tutorial

An interactive wizard that teaches DJing on a two-deck controller: hands on the decks within seconds,
one or two concepts per Lesson, one-line captions instead of paragraphs, attempts under a minute, and
instant feedback.

Each Lesson ends in a Check that grades what you did against the beat, to within a few milliseconds.
The on-screen controller follows the Pioneer DDJ-FLX4 layout and unlocks controls as you go. A real
DDJ-FLX4 works over Web MIDI, and the whole app can be driven from it.

Music comes from a Creative Commons starter pack (streamed from the Internet Archive), Audius, your
own files or folders (with rekordbox's analysis when you have it), and practice grooves generated in
the browser. Nothing copyrighted is stored in this repository.

## Run it

Needs Node 24 (`.nvmrc`) and a Chromium-based browser (Web Audio, Web MIDI, the File System Access API).

```sh
npm ci
cp .env.example .env   # optional; every variable has a default
npm run dev            # app on http://127.0.0.1:5179, API on 127.0.0.1:5180
```

- **Coach:** without `ANTHROPIC_API_KEY`, a built-in deterministic Coach answers everything. With a
  key, the API calls Claude, up to `COACH_MONTHLY_CAP_USD` (default 5) a month.
- **Beat analysis** of your own tracks uses Beat This! in the browser. `npm run fetch-models` explains
  how to export the model into `public/models/`; without it, a lighter built-in analyser is used.
- **Recording export** to WAV or MP3, and a Mix Plan's Render as MP3, need `ffmpeg` on the API's `PATH` (a Render's WAV does not).
- **Remote access** (a phone, another laptop): put an HTTPS reverse proxy or tunnel with its own login
  in front of `127.0.0.1:5179`, and add its host name to `PUBLIC_HOSTS` in `.env`.

## Develop

```sh
npm run typecheck && npm run lint
npm test            # Vitest: Node tests and Chromium browser tests
npm run test:e2e    # Playwright, on its own ports
```

`AGENTS.md` is the guide to the codebase (it is written for coding agents but reads fine for people),
`GLOSSARY.md` defines the domain words, and `docs/` holds the designs, research and ADRs.

## Accessibility

The short attempts, one-line captions and instant feedback are deliberate. The course is built with
accessibility in mind, for Learners who lose focus in long text, long waits or long attempts.

## Licence

MIT, see `LICENSE`. Starter-pack tracks keep their own Creative Commons licences (`tracks/starter-pack.json`).
