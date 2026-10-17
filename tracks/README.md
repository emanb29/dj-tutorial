# Creative Commons starter pack

`starter-pack.json` lists 16 netlabel tracks on the Internet Archive that the app can stream at
runtime. No audio is stored in this repo. The app fetches each `url` from archive.org: the
`/download/` URL redirects (302) to a data node, and both hops send
`Access-Control-Allow-Origin: *`. Byte-range requests return `206`.

## Fields

| Field | Meaning |
|---|---|
| `id` | `<archive.org item id>/<file name>`; unique per track |
| `url` | Direct MP3 URL (`https://archive.org/download/<item>/<file>`) |
| `licence` | The item's `licenseurl` from `archive.org/metadata/<item>` |
| `artist`, `title` | Per-file tags from the item metadata |
| `durationSec` | Decoded length of the MP3, rounded |
| `genre` | The track's role in the course: `house`, `techno` or `uk-garage` (see [lesson-catalogue Q7](../docs/lesson-catalogue.md)) |
| `bpmEstimate` | Estimated tempo, to the nearest 0.5 BPM |
| `introBars`, `outroBars` | Estimated mixable intro and outro, rounded to 4 bars |
| `corsOk` | `true` if both hops sent `ACAO: *` for `Origin: https://dj.example.com` and a `Range` request returned `206` |
| `notes` | Caveats, kick density, grid steadiness, release name and the uploader's genre tags |

## How the tracks were chosen

1. Searched `archive.org/advancedsearch.php` for `collection:netlabels` items tagged house, deep
   house, techno, UK garage, 2-step and speed garage. Requests were spaced at about one per
   second.
2. Read `archive.org/metadata/<id>` for about 30 candidate releases, and dropped releases with no
   licence and releases made of short (under about 4 minute) tracks.
3. Downloaded 54 candidate MP3s to a scratch folder (not the repo) and analysed them offline
   with librosa:
   - **BPM**: onset autocorrelation for a first guess, then a beat grid re-fitted every 4 bars
     (±50 ms). A straight-line fit through those anchors gives the BPM, and the residual shows
     how steady the tempo is. Every pick has a residual of 12 ms or less.
   - **Kick share**: the share of grid beats with a strong 30–130 Hz onset within ±35 ms. It
     is near 1.0 for four-on-the-floor and lower for broken beats.
   - **Intro/outro**: the bars counted from the first kick (or back from the last kick) until
     two consecutive bars reach 80% of the track's median loudness and 60% of its median
     harmonic (200–4000 Hz) energy. This is a heuristic. Treat it as ±8 bars and confirm it
     by ear before a graded Check depends on it.
4. Kept tracks whose tempo fits the catalogue ranges, that have a steady grid and four-on-the-floor
   kick (garage excepted), and that have intros of 16 bars or more. Vocal radio edits and
   anything labelled a radio edit were dropped.

## What fell short

- **UK garage**: no CC netlabel track fits the 130–134 BPM swung 2-step target with a DJ
  intro. Two picks are 4/4 speed garage at 126–127 BPM. Seb D's "UK Garage Edit" has a broken
  kick, but it runs at 128 BPM and has no beat outro (estimate 0). Its item was uploaded by an
  individual to a community collection, so its licence rests on the uploader's claim. The
  130 BPM 2-step tracks found (Erkin White, PICPACK) are about 4 minutes long with no intro.
- **Techno**: Juno6 "Argonaut" has a beatless lead-in of about 35 s, and Hod "Reminisce" ends
  with a beatless tail of about 45 s. Both are fine for by-ear practice, not for a Check that
  needs a clean intro and outro.
- **Short outros**: DCM's two tracks have outros of about 8 bars.
- Intro and outro lengths are machine estimates. Nobody has listened to these tracks yet.

## Licence summary

Each licence covers verbatim redistribution. The app only links to archive.org, so streaming
for private practice is fine under every one of them. Two clauses matter later:

| Licence | Tracks | Implication |
|---|---|---|
| [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) / [4.0](https://creativecommons.org/licenses/by-sa/4.0/) | 6 (all Monofónicos) | Most open: commercial use and recorded mixes allowed, with credit and share-alike |
| [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/) | 1 | No commercial use |
| [CC BY-NC-SA 2.5](https://creativecommons.org/licenses/by-nc-sa/2.5/) / [3.0](https://creativecommons.org/licenses/by-nc-sa/3.0/) | 3 | No commercial use; mixes share-alike |
| [CC BY-NC-ND 2.5](https://creativecommons.org/licenses/by-nc-nd/2.5/) / [3.0](https://creativecommons.org/licenses/by-nc-nd/3.0/) | 5 | No commercial use; **no sharing of recorded mixes** |
| [CC BY-ND 3.0](https://creativecommons.org/licenses/by-nd/3.0/) | 1 | **No sharing of recorded mixes** |

- **ND** (6 tracks): a recorded mix is an adaptation. The Learner may make one, but must not
  share it ([BY-ND 4.0 §2(a)(1)(B)](https://creativecommons.org/licenses/by-nd/4.0/legalcode)).
  If the app ever exports or uploads mixes, filter these out, or warn the Learner.
- **NC** (9 tracks): if the app ever charges money or shows ads, these need review.
- **Attribution**: the app should show artist, title, licence and a link to the item page on
  the deck. The list below is the canonical credit.

## Attribution

- Kay Grove, "Brothers" and "Expressions", from *[rest033] Kay Grove - Brothers EP*,
  [archive.org/details/rest033-kay_grove_-_brothers_ep](https://archive.org/details/rest033-kay_grove_-_brothers_ep),
  CC BY-NC-ND 2.5
- DCM, "Pattern A29" and "Motor City Wave", from *MNF025 DCM - Tunnel EP* (Monofónicos),
  [archive.org/details/MNF025_DCM--Tunnel_EP](https://archive.org/details/MNF025_DCM--Tunnel_EP),
  CC BY-SA 3.0
- Dsum, "Tension", from *MNF027 Dsum - Intimate* (Monofónicos),
  [archive.org/details/MNF027_Dsum--Intimate](https://archive.org/details/MNF027_Dsum--Intimate),
  CC BY-SA 4.0
- AFM, "Sometimes", from *MNF033 AFM - Sometimes EP* (Monofónicos),
  [archive.org/details/MNF033_AFM--Sometimes_EP](https://archive.org/details/MNF033_AFM--Sometimes_EP),
  CC BY-SA 4.0
- Juno6, "Windfall" and "Argonaut", from *Ita est [1bit 017]* (1bit wonder),
  [archive.org/details/1bit_017](https://archive.org/details/1bit_017), CC BY-NC-SA 2.5
- Juan Rodriguez, "Aventuras", from *MNF052 Juan Rodriguez - Forhouse EP* (Monofónicos),
  [archive.org/details/MNF052_Juan_Rodriguez--Forhouse_EP](https://archive.org/details/MNF052_Juan_Rodriguez--Forhouse_EP),
  CC BY-SA 4.0
- easy changes, "natural poison" and "next level", from *[unfound29] pitch and gas ep*,
  [archive.org/details/unfound29](https://archive.org/details/unfound29), CC BY-NC-ND 3.0
- Hod, "Reminisce", from *MNF040 Hod - Reminisce EP* (Monofónicos),
  [archive.org/details/MNF040_Hod--Reminisce_EP](https://archive.org/details/MNF040_Hod--Reminisce_EP),
  CC BY-SA 4.0
- Diamond Cuts, "Beetlework (12" mix)", from *Beetlework* (Toucan Music),
  [archive.org/details/tou315](https://archive.org/details/tou315), CC BY-NC-ND 3.0
- Diamond Cuts, "The Elbow Shuffle" (Toucan Music),
  [archive.org/details/tou355](https://archive.org/details/tou355), CC BY-NC 4.0
- Seb D, "Nothing Is Forever (UK Garage Edit)",
  [archive.org/details/NothingIsForever](https://archive.org/details/NothingIsForever),
  CC BY-NC-SA 3.0
- Sascha Dive, "The Feeling (Close Your Eyes) (Original)", from *(SMT006)* (Stille Macht Taub!),
  [archive.org/details/smt006](https://archive.org/details/smt006), CC BY-ND 3.0
