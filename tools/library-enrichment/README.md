# Library enrichment

Personal tooling, not part of the app. It proposes the artist, genre and year a music library is
missing, and writes an **enriched copy** of a rekordbox collection XML. The app only reads metadata,
so the copy is the bridge: point `REKORDBOX_XML` at it, or import it into rekordbox.

It never writes to the original XML, the audio files or their tags. Everything it writes goes under
`--data` (the sidecar store, the SoundCloud cache, the undo journal, the decision log) and `--out`.
Nothing in `src/`, `server/` or `shared/` imports it; the app's build, typecheck, lint and tests
leave `tools/` out.

## Commands

From this folder (it uses the repo's installed packages):

```sh
npm test            # its own Vitest suite
npm run typecheck
npm run lint

npm run enrich -- run --xml COLLECTION.xml --data DATA [--path-map E:/=/mnt/e/]
npm run enrich -- run --xml COLLECTION.xml --data DATA --soundcloud [--sample 50 | --limit N] [--seconds-per-track 20]
npm run enrich -- report --data DATA --out REPORT_DIR
npm run enrich -- apply --data DATA [--fields artist,originalArtist,remixer,mix,genre,genreRaw,year]
npm run enrich -- rollback --data DATA (--run RUN_ID | --last)
npm run enrich -- export-xml --xml COLLECTION.xml --data DATA --out ENRICHED.xml [--path-map E:/=/mnt/e/]
```

`--path-map FROM=TO` turns the collection's paths into local ones (a Windows export read from WSL:
`E:/=/mnt/e/`).

## How it works

- **The store** (`DATA/store.json`) keys each track by content hash (SHA-256 of the first 4 MB and
  the size, `src/content-hash.ts`), never by path. Each step's proposals carry their value, step,
  step version, rule, confidence band and evidence.
- **Steps are versioned and incremental.** A step re-runs on a track only when its input or its
  version changed. `run` without `apply` is a dry run.
  1. **Names** (`src/name-parse.ts`), offline: artist, original artist, clean title, remixer, mix,
     featuring, flags and the SoundCloud ID, from the track's name and file name.
  2. **SoundCloud** (`src/soundcloud.ts`), only with `--soundcloud`: genre, tags, uploader and dates,
     by ID, through `yt-dlp` in metadata-only mode. One track per `--seconds-per-track` (default 20),
     its requests at least a third of that apart. Every answer is cached (misses too) with a TTL, so a
     stopped pass resumes where it was. Rate limited, it backs off 5, 10, then 20 minutes (capped at
     an hour), then stops. A lock file (`DATA/run.lock`) keeps a second pass out.
- **The artist rule.** A remix, edit, bootleg, flip, VIP, re-work or mashup by X is X's track:
  artist = X, and the name's first artist is the original artist. The clean title keeps "(X Remix)".
  A hand-set artist always wins. The uploader counts only when it is the remixer or the title's
  "Artist - "; a label, promo or repost channel is never credited.
- **Genres** map onto a small DJ taxonomy (`src/genre.ts`); the raw genre is kept as `genreRaw`.
- **Apply** fills only fields the collection has empty. The high band applies by itself; the medium
  band only once accepted. Each run writes `DATA/journal/RUN_ID.jsonl`, which `rollback` undoes.
- **Review.** `report` writes `review.html`: a card per undecided medium proposal, with its
  evidence. Its buttons build decision lines to append to `DATA/decisions.jsonl` (or `--decisions`).
  Every run reads that live log, and a rejected value is never proposed again.
- **The enriched XML** fills `Artist`, `Remixer`, `Mix`, `Genre` and `Year` where they are empty.
  rekordbox has no field for a remix's original artist, so it goes in `Comments` ("Original artist:
  X") when that is empty. Titles change only when `apply --fields` includes `title`.

The report and the store name your tracks: keep `--data` and `--out` outside the repo.
