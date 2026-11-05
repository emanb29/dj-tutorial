# Remix finder

Personal tooling, not part of the app. Give it a Spotify playlist. It finds remixes, edits,
bootlegs, flips, VIPs and other versions of each song on SoundCloud, YouTube and Spotify, measures
each one's BPM and key, has an agent shortlist the ones worth a listen, and writes a page for
building playlists of variants and sets from them.

Nothing in `src/`, `server/` or `shared/` imports it; the app's build, typecheck, lint and tests
leave `tools/` out.

## Commands

From this folder (`npm install` here once: it adds the Claude Agent SDK; the rest comes from the
repo's packages):

```sh
npm test            # its own Vitest suite
npm run typecheck
npm run lint

npm run find -- https://open.spotify.com/playlist/ID                 # find, measure, shortlist
npm run find -- LINK --songs 5 --no-agent                            # every variant, no shortlist
npm run find -- LINK --taste ~/taste.md --brief "house edits for a sunset set" --model claude-opus-5-5
npm run find -- --help                                               # every option
```

It needs `yt-dlp` and `ffmpeg` on `PATH`. The page and a JSON of everything go to
`.local/remix-finder/PLAYLIST_ID.{html,json}` at the repo root (gitignored); the cache goes to
`.local/remix-finder/data`. Both name tracks, so keep them out of the repo.

## How it works

1. **The playlist** (`src/spotify.ts`): through the Spotify Web API when `SPOTIFY_CLIENT_ID` and
   `SPOTIFY_CLIENT_SECRET` are set (an app at developer.spotify.com, client credentials), else
   through the public embed page, which needs no account and lists the first 100 songs.
2. **Search** (`src/search.ts`): `ARTIST TITLE remix` and `ARTIST TITLE edit bootleg` on each
   platform. SoundCloud and YouTube go through yt-dlp's flat search (metadata only, no keys);
   Spotify needs the two variables above, and is skipped with a note without them.
3. **Which results are variants** (`src/variants.ts`): the title must name the song as whole words
   (and the artist, for a title under three words) and carry a variant word. Lyric videos, karaoke,
   8D, type beats and "Radio Edit" are not variants. Each has a kind and, where the title credits
   one, a remixer. `dj: false` marks listening versions (slowed, sped up, nightcore, acoustic, live,
   cover). The same version on two platforms shares a key, so the page and the agent treat them as
   one.
4. **BPM and key** (`src/audio.ts`, `src/key.ts`): a 60 s clip from 60 s in (a Spotify preview:
   its 30 s) streams through ffmpeg into memory; only the numbers are kept. BPM comes from the
   app's own pipeline: Beat This! when `public/models/` has the model (`npm run fetch-models --
   --export` at the repo root), else the dj-core fallback, which handles four-on-the-floor only
   and can double or halve other tempos. The key is a chromagram against the Krumhansl-Kessler
   profiles, shown on the Camelot wheel; `?` marks a guess. DRM-protected tracks (most label
   uploads on SoundCloud) are never worked around: they borrow the numbers of the same version
   measured on another platform.
5. **The shortlist** (`src/agent.ts`): a Claude Agent SDK agent with four tools of its own
   (`list_songs`, `get_candidates`, `search_more`, `pick`). It judges taste (credible remixers,
   real productions over re-uploads, the best copy of each version, fit with `--taste`) and may run
   up to three more searches per song. It never measures or edits a number. It picks up to
   `--picks` (3) per song with a one-line reason each.
6. **The page** (`src/report.ts`): each song with its shortlist first and every other version under
   it. Filters: BPM range, DJ versions only, key fits the original, platform. Tick boxes, and Copy
   links, CSV and M3U for the ticked ones.

Searches are cached for a week and measurements for good, so a rerun is fast and the agent's extra
searches cost little.

## The agent's cost

- **Model:** `--model` defaults to Claude Haiku 5.5. Use `claude-opus-5-5` for a playlist you care
  about: it knows more remixers and doubts a suspicious BPM.
- **Rough cost:** about $0.15 for 50 songs on Haiku, and a few dollars on Opus. These are
  estimates from one-song runs, not measured on a whole playlist.
- **`--budget`** (default $1) stops the run. The SDK checks it between turns, so one long turn can
  pass it.
- **Billing:** with `ANTHROPIC_API_KEY` set, runs bill that key. Without it, the agent uses this
  machine's Claude Code login. The log prints the tokens and estimated cost of every run.
- **Isolation:** the agent runs with no built-in tools (no shell, no files), no user or project
  settings, no other MCP servers and no claude.ai connectors. Without that, every connector's tool
  list rode along on every turn: about 160k tokens a turn, $5 for one song on Opus.
- **More servers:** `--mcp-config FILE` (`{"mcpServers": {...}}`, as in `.mcp.json`) gives it
  servers of your choice, such as one that saves the picks to a Spotify playlist.
