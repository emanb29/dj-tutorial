# learn-to-dj

An interactive wizard that teaches DJing. It introduces one or two concepts at a time on a simulated deck, using real music from a connected Spotify account. Hardware controller support is a later feature.

## Agent skills

### Issue tracker

Issues are tracked in Linear, in the Learn to DJ project (team Emanb29, key `ISS`), through the `linear-server` MCP tools. See `docs/agents/issue-tracker.md`.

### Triage labels

The default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Dev server and remote access

The owner often develops remotely. Every dev server for this project (the app, or the prototype under `prototypes/`) binds `127.0.0.1:5179` with `strictPort`, and lists `dj.example.com` in Vite's `server.allowedHosts`. A reverse proxy forwards `https://dj.example.com` to it, behind the owner's passkey or password. Only one dev server can hold port 5179 at a time.
