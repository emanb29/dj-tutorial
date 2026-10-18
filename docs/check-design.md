# Check design (v1)

Status: **draft**. Terms follow `GLOSSARY.md`; Lesson ids, thresholds and the standing criteria
follow `docs/lesson-catalogue.md` (v1, adopted). Measurability follows
`docs/research/browser-audio-analysis.md` (branch `research/browser-audio-analysis`). LCME
descriptors and the 15 beginner mistakes come from `docs/research/dj-terminology-and-curriculum.md`
(branch `research/dj-terminology-and-curriculum`).

A Check is a **pure function** `runCheck(spec, input, profile) → CheckResult`. It reads a recorded
attempt and returns pass/fail plus measured values. It does no I/O and reads no clock, so every
criterion can be unit-tested on synthetic timelines.

## 1. Inputs (`CheckInput`)

All times inside an attempt are **AudioContext time in seconds** (`ctx`). Wall-clock time (ISO
strings) is used only for scheduling in the Skill profile. The two are never mixed.

| Input | Shape | Source | Notes |
|---|---|---|---|
| Control-event timeline | `{ctx, control, deck?, value, appliedCtx?, byEngine?}[]`, ordered; ids and units in `shared/attempt.ts` `ControlId` (mixer, tempo, jog bend, SYNC, Master Tempo, CFX, Play, CUE, Lesson buttons) | virtual controller / MIDI | Input timestamps are mapped to *heard* time: `ctx = ts.contextTime + (event.timeStamp − ts.performanceTime)/1000`, with `ts = getOutputTimestamp()`, never past `currentTime`. `appliedCtx` is when the change reached the audio and the playhead model; deck controls are lined up with the playhead on it |
| Deck playhead models | per deck: `{startCtx, startPos, rateSegments[]}` → `pos_d(t)` (track seconds) | deck engine | Integrated from playbackRate automation we schedule; jog bends are rate segments |
| Beat grids | per track: `{bpm, firstBeat, downbeatIndex}` or a per-beat array, plus `rmsResidualMs` | analysis worker | `φ_d(t) = grid.beatAt(pos_d(t))` in beats; bar = 4 beats |
| Phrase markers | per track: track-time list | Lesson track set (hand-checked) | `final-mix` only: 8-bar candidates from bar 1, confirmed by the Learner in track prep (§5.4) |
| Level meters | 50 Hz frames per channel (post-trim/EQ, pre-fader), FX return and master: `{samplePeakDb, momentaryLufs, shortTermLufs}` | AudioWorklet meter | Momentary = 400 ms, short-term = 3 s, K-weighted (EBU R128) |
| Mixer and deck state | the attempt's initial snapshots (`initialMixer`, `initialDecks`) plus the event timeline: fader, crossfader, trim, EQ (dB), CFX, CUE, FX, tempo, SYNC, Master Tempo | — | Effective master gain `g_d(t)` = fader × crossfader curve, in dB |
| Task spec | Lesson id, mode, variant, track ids, aids, task window | Lesson content | Aids = sync, quantize, BPM display, phase meter, Lesson text |

## 2. Shared measures

Notation: `B_d` = beat length of deck `d` at its current tempo; `M` = the master (outgoing) deck.

| Id | Measure | Formula |
|---|---|---|
| `beatOff(t,d)` | signed offset to nearest beat, ms | `(φ_d(t) − round(φ_d(t))) · B_d` |
| `downbeatOff(t,d)` | signed offset to nearest downbeat, ms | as above on `φ_d/4`, times `4·B_d` |
| `phraseOff(t,d)` | signed offset to nearest phrase marker, beats | `φ_d(t) − φ_d(nearest marker)` |
| `phaseErr(t)` | inter-deck phase error, ms | `wrap(φ_A(t) − φ_B(t), ±0.5) · B_M` (output latency cancels: one AudioContext) |
| `audible(d,t)` | deck reaches master | playing ∧ `g_d(t) > −24 dB` ∧ channel momentary `> −40 LUFS` |
| `overlap` | blend span | maximal interval where both decks are audible |
| `t_in`, `t_out` | entry / exit | first audible frame of the incoming deck; first frame the outgoing deck is not audible |
| `matchTaps(taps, targets, tol)` | one-to-one matching | greedy nearest pairing within `±tol`; returns `matched`, `extras`, signed offsets |
| `barLoud(t)` | master loudness per bar | energy mean of master momentary LUFS over the bar |
| `loudJump(t)` | level change across a cut, dB | `|mean barLoud over 4 bars before t − 4 bars after t|` |
| `clash` | bass clash time, s | `∫ [audible(A) ∧ audible(B) ∧ LOW_A > −6 dB ∧ LOW_B > −6 dB] dt` |
| `holdFrac(span, lim)` | fraction of frames within limit | `#{|phaseErr| < lim} / #frames` over `span` |
| `worstRun(span, lim)` | longest run over limit | longest contiguous run with `|phaseErr| > lim` |

Every criterion result also carries a **margin**: `(threshold − measured)/threshold`, sign-adjusted so
that positive means met. The Coach uses margins to find weak criteria (§8).

## 3. Standing criteria

A standing criterion applies to every Check taken after its teaching Lesson is passed, and only
when the Check's task contains the situation (e.g. off-phrase needs a transition). **fail** blocks
the pass; **warn** is reported only; **report** is a metric for the Coach (catalogue Q10).

| Id | Mistake # | From (passed) | Formula and threshold | Severity before `final-mix` | In `final-mix` |
|---|---|---|---|---|---|
| `no-clip` | 1 | `gain-staging` | any judged frame with master, or an audible channel, sample peak `> −0.1 dBFS` (judged: see below) | fail | fail |
| `no-dead-air` | 13 | `cut-on-phrase` | master momentary `< −45 LUFS` for `≥ 1.0 s` between first audio and task end | fail | fail |
| `on-phrase` | 9 | `cut-on-phrase` | every `t_in`: `|phraseOff(t_in, M)| ≤ 1 beat` and `|phraseOff(t_in, in)| ≤ 1 beat` | fail | fail |
| `level-match` | 2 | `cut-on-phrase` | at each handover, `|shortTerm_A − shortTerm_B|` (pre-fader) `≤ 2 dB` | warn | fail |
| `cued-first` | 10 | `cut-on-phrase` | incoming CUE on for `≥ 2 s` before `t_in` | warn | warn |
| `trim-still` | 3 | `sync-blend` | no trim event during any `overlap` | warn | warn |
| `no-boost` | 5 | `eq-basics` | no EQ band `> +3 dB` for `> 1 bar` | warn | warn |
| `controls-reset` | 12 | `eq-basics` (EQ), `filter-transition` (CFX), `echo-out` (FX) | within 1 bar of a deck going silent: its EQs within ±1 dB, CFX within ±5% of centre, FX off | warn | warn |
| `sync-kept` | 11 | `sync-blend` | no jog bend on a synced deck | warn (sync Checks only) | n/a (sync off) |
| `no-recue` | 7 | `nudge-phase` | ≤ 1 CUE press on the incoming deck during `overlap` or a phase task | warn | warn |
| `one-bass` | 4 | `blend-by-ear` | `clash ≤ 1 beat` per blend | warn | warn (feeds Balance band) |
| `drift` | 6 | `blend-by-ear` | blend phase rules of `blend-by-ear` | — (own criterion there) | fail |
| `overcorrect` | 8 | `tempo-by-ear` | tempo-fader reversals (sign changes of Δtempo with step > 0.02 BPM), max bend | report | report |
| `key-clash` | 14 | `final-mix` | Camelot distance ∉ {0, ±1, A↔B} during a blend `> 8 bars` | — | warn |
| `technique-mix` | 15 | `final-mix` | counts of cuts, blends, echo outs, loops | — | report |

**no-clip judges only what the Learner is responsible for.** Each meter (the master, each channel)
is judged from the Learner's first move on it (that channel's trim, EQ, CFX or fader; any of those,
or the crossfader, for the master) or 1 bar after the Check's audio starts, whichever is earlier, and
strictly from then on: the set-up's own level is never the Learner's clip. In `gain-staging`, whose
set-up starts deck A in the red on purpose, a meter is judged only from its first frame out of the
red after the Learner's first move (the Lesson's own `trim-A` grades the clip it hands them). Set-ups
themselves never start in the red: every one turns both trims down so the louder of its tracks peaks
at −9 dBFS on file (Originals peak near −0.5 dBFS, and the isolator's phase shift adds up to ~5.5 dB),
which keeps two decks summed at the crossfader's centre out of the red; `src/app/lesson/set-up-levels.browser.test.ts`
renders every Lesson's and Placement task's set-up to check it.

**Pass rule (all Checks):** passed ⇔ every own criterion is met ∧ every applicable **fail** standing
criterion is met. Warnings never block.

## 4. Per-Lesson criteria

Thresholds are catalogue §1 values (starting values, Q9). Tolerances in ms are on heard time.
"Short form" is the warm-up variant (§7); it uses the same criteria and thresholds with fewer reps.

| Lesson | Criterion id | Measured | Threshold → met when | Short form |
|---|---|---|---|---|
| `deck-basics` | `fade-in` | `t_in(A) − t_play(A)` (here the run start: the latency only shortens the span) | `≤ 4 bars` | same (it is short) |
| | `fade-out` | fader A at task end | `= 0` | |
| | `no-clip-local` | master peak | never `> −0.1 dBFS` | |
| `beats-and-bars` | `beat-taps` | `matchTaps(taps, 32 beats, 40 ms)` | `matched/32 ≥ 0.90` ∧ `extras ≤ 3` | 4 + 4 bars, same ratios |
| | `downbeat-taps` | `matchTaps(taps, 8 downbeats, 40 ms)`; taps nearest a non-downbeat | `matched ≥ 7` ∧ wrong-beat taps `= 0` | (`matched ≥ 4` of 4) |
| | report | median signed tap offset (rushing/dragging) | — | |
| `phrases` | `phrase-taps` | `matchTaps(taps, 8 phrase starts, 1 beat)` | `matched ≥ 6` ∧ `extras ≤ 1` | 32 bars, 3 starts, `matched ≥ 3`, `extras = 0` |
| | `name-sections` | Learner's picked phrase index for breakdown and drop | both equal the marked index | drop only |
| `gain-staging` | `trim-A`, `trim-B` | max channel sample peak over an 8-bar window after "Ready" | `∈ [−6, −0.1) dBFS` | one deck, 4 bars |
| | `loud-match` | `|integrated_A − integrated_B|` over those windows | `≤ 1.5 dB` | dropped |
| `headphone-cue` | `cued-taps` | `matchTaps(taps, B's 32 beats, 50 ms)` | `matched/32 ≥ 0.85` ∧ `extras ≤ 5` | 4 bars |
| | `b-off-master` | `max g_B` over task; CUE B on fraction | `≤ −60 dB` ∧ `≥ 95%` | |
| `cue-point` | `cue-on-downbeat` ×3 | `|cue − nearest beat|`; that beat is beat 1 | `≤ 20 ms` ∧ is downbeat, on all 3 | 1 track |
| `cut-on-phrase` | `cut-start` | `|t_play(B) − nearest A phrase start|` | `≤ 40 ms` | same (one cut) |
| | `cut-tight` | `|t_out(A) − t_play(B)|` | `≤ 1 beat` | |
| | `cued-before` | CUE B on before `t_in(B)` | `≥ 2 s` | |
| | `loud-jump` | `loudJump` at B's audio start | `≤ 2 dB` | |
| `tempo-fader` | `set-bpm` ×3 | `|bpm_B − target|` at "Done" | `≤ 0.05 BPM` on all 3 | 1 target |
| | `master-tempo-ear` | correct answers | `2 of 2` | 1 of 1 |
| `sync-blend` | `blend-start` | `|phraseOff(t_in(B), A)|` | `≤ 1 beat` | 8-bar blend |
| | `blend-length` | `t_out(A) − t_in(B)` | `∈ [8 bars − 1 beat, 16 bars + 1 beat]` | `∈ [8, 9]` bars |
| | `loud-steady` | max `|barLoud − mean of 4 bars before t_in|` over `[t_in, t_out + 4 bars]` | `≤ 3 dB` | |
| | `trim-untouched` | trim events in overlap | `= 0` | |
| `crossfader` | `xf-blend`, `xf-cut` | as `sync-blend` and `cut-on-phrase` | same thresholds | blend only |
| | `faders-up` | min channel fader A, B during both tasks | `≥ 0.95` | |
| `eq-basics` | `low-kill` | longest span with LOW_A `≤ −20 dB` | `≥ 7 bars` | same |
| | `low-return` | `|phraseOff(t_return, A)|`, `t_return` = LOW_A back `≥ −1 dB` | `≤ 1 beat` | |
| | `eq-centred` | max `|band dB|` at task end | `≤ 1 dB` | |
| `bass-swap` | `enter-low-cut` | LOW_B at `t_in(B)` | `≤ −20 dB` | same |
| | `swap-time` | `|phraseOff(t_swap, A)|`, `t_swap` = mean of LOW_B up-crossing and LOW_A down-crossing of −6 dB | `≤ 1 beat` | |
| | `clash-short` | `clash` | `≤ 1 beat` | |
| `filter-transition` | `hpf-depth` | max HPF amount on CFX A before `t_out(A)` | `≥ 0.70` | |
| | `filter-length` | `t_out(A) −` first CFX A `> 0.05` | `∈ [8, 16] bars ± 1 beat` | `∈ [8, 9]` bars |
| | `cfx-back` | time from `t_out(A)` to CFX A within ±5% of centre | `≤ 1 bar` | |
| `nudge-phase` | `converge` | first `t_c` with `|phaseErr| < 15 ms`, measured from task start | `≤ 4 bars` | same, hold 4 bars |
| | `hold` | `holdFrac([t_c, t_c + 8 bars], 15 ms)`; `worstRun(…, 30 ms)` | `≥ 0.95` ∧ `≤ 1 beat` | |
| | `cue-presses` | CUE presses on B | `≤ 1` | |
| `tempo-by-ear` | `tempo-match` | exists `t_c ≤ start + 32 bars`; over `[t_c, t_c + 8 bars]`: max `|bpm_A − bpm_B|`, `holdFrac(·, 20 ms)` | `≤ 0.1 BPM` ∧ `≥ 0.95` | `t_c ≤ 24 bars`, hold 4 bars |
| | report | reversals, max bend (`overcorrect`) | — | |
| `blend-by-ear` | `blend-length` | `t_out(A) − t_in(B)` | `≥ 16 bars − 1 beat` | 8 bars |
| | `phase-hold` | `holdFrac(overlap, 25 ms)`; `worstRun(overlap, 60 ms)` | `≥ 0.85` ∧ `≤ 1 bar` | |
| | `swap-time`, `clash-short`, `loud-steady` | as in `bass-swap` / `sync-blend` | same | |
| `hot-cues` | `hc-place` ×3 | `|hot cue − nearest phrase marker|` | `≤ 20 ms` on all 3 | 1 hot cue |
| | `hc-trigger` ×3 | `|t_trigger − nearest A phrase start|` | `≤ 40 ms` on all 3 | |
| `loop-transition` | `loop-length` | `min(|len − 16·B|, |len − 32·B|)` | `≤ 20 ms` | same |
| | `loop-in`, `loop-exit` | `|downbeatOff|` at loop in / exit, in beats | `≤ 1 beat` | |
| | `loop-entry` | B's `t_in` on an A downbeat and on a B phrase marker | each `≤ 1 beat` | |
| | `no-double` | LOOP IN / 4 BEAT presses within 2 beats of each other while audible | `= 0` | |
| `echo-out` | `echo-cut` | ECHO on A at `t_out(A)`; `|downbeatOff(t_out, A)|` | on ∧ `≤ 1 beat` | same |
| | `echo-entry` | `|t_in(B) − A's next phrase start had it kept playing|` | `≤ 1 beat` | |
| | `fx-off` | FX OFF time − tail end (FX return momentary `< −50 LUFS`) | `≤ 2 bars` | |
| `final-mix` | see §5 | | | full mix (no short form) |

## 5. `final-mix`

### 5.1 Task and admission

| Rule | Measured | Threshold |
|---|---|---|
| `track-count` | distinct tracks audible `≥ 16 bars` each | `≥ 3` |
| `one-genre` | genre tag set in track prep | one value |
| `tempo-range` | each track's grid BPM vs the first track's | within ±2% |
| `grid-trust` (admission) | each track's `rmsResidualMs` | `≤ 15 ms`, else the track is refused in prep with "this track's beat grid is too uneven to grade; pick another" |
| Aids | sync, quantize off; BPM display and phase meter hidden; Lesson text none | enforced by the deck engine, recorded in `aids` |

Transitions are classified by overlap length: **cut** `< 2 beats`, **blend** `≥ 4 bars`, otherwise
**unclassified** (graded by standing criteria, counts as neither). Required: `≥ 1` blend and `≥ 1` cut.

### 5.2 Criteria (all must be met for Pass)

| Id | Formula | Threshold |
|---|---|---|
| `on-phrase` | every `t_in` | `|phraseOff| ≤ 1 beat` on both decks |
| `drift` | per blend: `holdFrac(overlap, 25 ms)`, `worstRun(overlap, 60 ms)` | `≥ 0.85` ∧ `≤ 1 bar` |
| `no-clip`, `no-dead-air` | §3 | §3 |
| `level-match` | §3, at each handover | `≤ 2 dB` |
| `technique` | blend count, cut count | `≥ 1` each |

### 5.3 Bands (LCME Debut descriptors, measurable domains only)

Each domain gets the highest band whose every row is met; **overall band = lowest domain band**.
Below Pass = the Check failed. LCME's musicality, knowledge and communication domains are not
measured; the Coach may comment on them, never grade them.

| Domain | Pass | Merit | Distinction |
|---|---|---|---|
| **Beat-syncing** | "Beat-syncing inaccuracies mostly rectified": `drift` met | "Minor inaccuracies … with controlled corrections": every blend `holdFrac(25 ms) ≥ 0.92`, and every excursion `> 25 ms` back under 25 ms within 2 bars | "Secure beat-syncing and rhythmic control": every blend `holdFrac(15 ms) ≥ 0.90`, `worstRun(40 ms) = 0` |
| **Balance** | "acceptable standard": no clip, `level-match ≤ 2 dB` | "Mainly good clarity and balance": `level-match ≤ 1.5 dB`, `clash ≤ 2 beats` per blend, no `no-boost` warning | "Clarity and balance in all frequency ranges": `level-match ≤ 1 dB`, `clash ≤ 1 beat` per blend, no `no-boost` or `controls-reset` warning |
| **Phrasing** | "Adequate attention to phrasing": `on-phrase` met | "Evident attention to phrasing": every `t_in` within `±¼ beat`, every bass swap within ±1 beat of a phrase start | "Highly evident attention to phrasing and/or track structure": Merit, and every outgoing track leaves before its last phrase marker (no running out) |

### 5.4 Track prep (own files)

Phrase markers on the Learner's own files are only hints (research, step 5). Before the mix, track prep
shows the grid, bar 1 and 8-bar phrase candidates; the Learner may shift bar 1 / the phrase anchor
by whole bars. The Check uses the confirmed markers. Prep itself is not graded.

### 5.5 Grading a set (implementation, `src/checks/lessons/final-mix.ts`, `src/checks/set.ts`)

**Recording.** A set is one attempt recorded with track changes allowed: each deck's recording is its
last track plus `earlier`, the tracks it held before (each with its own playhead model and
`loadedCtx`; `shared/attempt.ts` `DeckRecording`). A track's playhead is stopped before its load and
after the next one, so `audible(d, t)` asks whichever of the deck's tracks is playing.

**Window.** From the set's own cue (the decks cued to their cue points after the recorder starts) to
the end of the last master audio (frame ≥ −45 LUFS), not the "End set" press: silence after the last
track is the set's end, not dead air.

**Plays and transitions.** A *play* is one track's stay on a deck. Plays heard on the master are
ordered by their first audible frame; each one that follows a play on the *other* deck is a
transition (one that follows a play on the same deck has silence in between, which `no-dead-air`
reports). A transition's **view** is the attempt with the outgoing deck relabelled A and the incoming
B (events, meters, mixer and deck snapshots swapped; the crossfader mirrored), one track per deck,
from when both tracks were loaded until the incoming track leaves its deck (the outgoing deck is
often reloaded right after the handover; the incoming level 3 s in still belongs to it). Every two-deck measure of §2–§4 runs on a view unchanged.

**Criteria.** Own: `final-mix.track-count` (tracks audible `≥ 16 bars − 1 beat`, `≥ 3`),
`final-mix.one-genre` (distinct genre tags, case-insensitive, `= 1`), `final-mix.tempo-range` (largest
`|bpm/bpm_first − 1|` of the set's grids `≤ 0.02`), `final-mix.technique` (blends `≥ 1` ∧ cuts `≥ 1`).
Standing criteria marked per-transition (`on-phrase`, `level-match`, `cued-first`, `trim-still`,
`controls-reset`, `no-recue`, `one-bass`, `drift`) are measured on every view and reported once, as the
worst transition (an unmet one first, then the lowest margin), with every transition's evidence
labelled "transition n: …"; the rest (`no-clip`, `no-dead-air`, `no-boost`, `overcorrect`) on the whole
set. Point actions keep their press times (an entry is timed from its Play press or fader move, §2
"Input leeway"); phase and loudness come from audible frames. `key-clash` is not graded: the set
builder warns about clashing keys (Camelot not 0, ±1 or the A/B swap) and lets the set go ahead
(mistake 14). `technique-mix` is the `metrics` counts (`transitions`, `blends`, `cuts`, `unclassified`).

**Bands** (§5.3) are computed for a passed set from the views: Beat-syncing Merit = every blend
`holdFrac(25 ms) ≥ 0.92` ∧ `worstRun(25 ms) ≤ 2 bars`; Distinction = `holdFrac(15 ms) ≥ 0.90` ∧ no sample
over 40 ms. Balance uses the worst `level-match`, the worst blend's `clash`, and the `no-boost` /
`controls-reset` results. Phrasing uses the worst `on-phrase` (`≤ ¼ beat`), every blend's `swap-time`
(when there is a swap), and, for Distinction, every outgoing track's position at `t_out` before its last
phrase marker.

**Per-transition report** (`finalMixTransitions`): for each transition its tracks, kind, `t_in`, the
on-phrase and level-match values, the drift hold for a blend, and whether its fail-severity rules
were met. The result screen and the final project's notes show it.

## 6. What the Learner sees

| When | Lesson Check | Cold re-pass, warm-up | `final-mix` |
|---|---|---|---|
| Before | task text, the Lesson's aids | one-line task only (§7.1) | task line and track prep |
| Live | Lesson aids (meters always; phase meter / BPM where the Lesson allows); step progress ("cue B", "blend"); a toast when a **fail** standing criterion trips (the attempt continues) | aids as the Lesson's Check; no toasts | meters only; no toasts (exam conditions) |
| Not live | per-tap or per-frame grading, margins, warnings | same | same |
| After | per criterion: met/not met, measured vs threshold in plain words ("3 of 32 beats missed; you need 29"); a timeline with marks (clips, dead air, `t_in`/`t_out`, phase-error trace where relevant); warnings; Coach feedback | same, plus retention change ("next check-in in 7 days") | criteria, band per domain and overall, timeline per transition |
| Ending | "Done", or timeout = task length + 16 bars (timeout = criteria not met) | same | same |

An attempt is **void** (not pass, not fail, not counted) if the AudioContext suspends or the tab is
hidden during the task window, a grid fails `grid-trust`, the Learner abandons it, or the deck never
played all of a section the task grades (`sectionNotHeard`: grading it would count every target missed).
A recorded playhead model holds the track's whole history since it was loaded (hook, practice, earlier
attempts, which play the same positions), so Lesson content looks for a section's heard times only
after the Check's own cue inside the task window. That cue is scheduled at `currentTime` + lookahead just
before the recorder starts, so heard time must never pass `currentTime` (nothing is heard before it is
rendered): `audioContextClock` caps it there, or a timestamp running ahead would put the cue before the
window and void every attempt. A void carries `diagnostics` (the section, its heard span, the window,
the clock) for debugging; the Learner sees only the short reason.

## 7. Variants

### 7.1 Cold re-pass (retention)

| Aspect | Lesson Check | Cold re-pass |
|---|---|---|
| Lesson text, hints, step prompts | yes | none: one line ("Blend into deck B with sync on, starting on a phrase") |
| Tracks | the Lesson track set's primary tracks | a different track from the same Lesson track set (each set has ≥ 2 alternates; never the track of the last attempt) |
| Aids, thresholds, standing criteria | as §3–4 | identical |
| Eligibility | — | `≥ 20 h` since that criterion's last pass |
| Form | full | short form (§4) as a warm-up; `final-mix` is always full |

### 7.2 Warm-ups

- Due list: Lessons with any criterion `nextDueAt ≤ now`, most overdue first.
- Per session: at most 3 Lessons, about 10 minutes (§11 question 1); the rest roll over to the next session.
- A warm-up is a cold re-pass in short form (`mode: "warmup"`, `variant: "short"`).
- Skip-group members passed through Placement are retained by the group task's short form.

### 7.3 Bonus exercises

They reuse the same criterion functions with `mode: "bonus"`. They **never** change pass, retention or
`consecutiveFails`; they write only `practice` counters.

| Kind | Built from | Varies |
|---|---|---|
| Interleaved set (after each skip group) | 3–5 short forms from the group, shuffled, cold | order only |
| Weak-criterion drill | the criterion with the smallest best margin, or the latest not met | reps; one criterion only |
| Stretch | a passed Lesson's Check | one LCME lever: BPM gap ±2% → ±4%, display hidden, more tracks |

## 8. Skill profile writes

### 8.1 Retention transitions (per criterion)

Ladder `L = [1, 3, 7, 21, 60]` days. `nextDueAt = passAt + L[step]·24 h − 4 h` (slack so a same-time
session the next day qualifies). A met cold result advances only if the criterion is due; an early
met result updates `last`/`best` only. Any not-met cold result lapses the criterion.

| From | Event | To | step | nextDueAt |
|---|---|---|---|---|
| `notPassed` | met in Lesson Check or Placement | `passed` | 0 | +1 d |
| `passed` / `lapsed` | met cold, due, `≥ 20 h` | `retained` | 1 | +3 d |
| `retained` | met cold, due | `retained` | min(step+1, 4) | +L[step] |
| `passed` / `retained` | not met cold | `lapsed` | 0 | +1 d |
| `lapsed` | met in a Review (Lesson Check) | `lapsed` | 0 | +1 d |

- A Lesson's retention is **derived** (the worst state of its criteria), never stored.
- Unlocks are never revoked: a lapse does not re-lock dependent Lessons.
- Standing criteria get records (last, best, counts) but no retention schedule: they are re-measured in every Check.
- **Review trigger:** `consecutiveFails ≥ 3` on one criterion (Lesson Check or cold modes) → the
  Coach suggests a Review of the Lesson that introduced it (catalogue Q6). Reset on the next met result.
- **Course complete** (latched): `final-mix` passed and every criterion of every Lesson on the
  `final-mix` route, including `final-mix`, is `retained`.

### 8.2 Coach payload

The Coach gets the `CheckResult` (below) and the updated `SkillProfile`, read-only. It never sees
audio, never changes `outcome`, and never computes a criterion. Its job is wording, Curriculum
order, Review and bonus-exercise suggestions, using `measured`, `margin`, `warnings` and `metrics`.

## 9. Type sketch

```ts
type LessonId =
  | "deck-basics" | "beats-and-bars" | "phrases" | "gain-staging" | "headphone-cue"
  | "cue-point" | "cut-on-phrase" | "tempo-fader" | "sync-blend" | "crossfader"
  | "eq-basics" | "bass-swap" | "filter-transition" | "nudge-phase" | "tempo-by-ear"
  | "blend-by-ear" | "hot-cues" | "loop-transition" | "echo-out" | "final-mix";
type StandingId =
  | "no-clip" | "no-dead-air" | "on-phrase" | "level-match" | "cued-first" | "trim-still"
  | "no-boost" | "controls-reset" | "sync-kept" | "no-recue" | "one-bass" | "drift"
  | "overcorrect" | "key-clash" | "technique-mix";
type CriterionId = `${LessonId}.${string}` | `standing.${StandingId}`;

type CheckMode = "lesson" | "placement" | "cold" | "warmup" | "bonus";
type Severity = "fail" | "warn" | "report";
type Band = "pass" | "merit" | "distinction";
type Unit = "ms" | "beats" | "bars" | "dB" | "dBFS" | "LUFS" | "BPM" | "ratio" | "count" | "s";
type IsoTime = string;   // wall clock, scheduling only
type CtxTime = number;   // AudioContext seconds, inside one attempt only

interface Threshold { op: "<=" | ">=" | "==" | "in"; value: number | readonly [number, number]; unit: Unit }

interface CriterionResult {
  id: CriterionId;
  severity: Severity;
  status: "met" | "notMet" | "notApplicable";
  measured: number | null;            // null only when notApplicable
  unit: Unit;
  threshold: Threshold | null;        // null for "report"
  margin: number | null;              // > 0 means met; (threshold − measured)/threshold, sign-adjusted
  evidence: ReadonlyArray<{ from: CtxTime; to: CtxTime; label: string }>;
  detail?: Readonly<Record<string, number>>;   // e.g. { matched: 29, extras: 1, medianOffsetMs: -12 }
}

type VoidReason = "contextSuspended" | "tabHidden" | "gridUntrusted" | "abandoned" | "sectionNotHeard";

interface CheckResult {
  schemaVersion: 1;
  attemptId: string;
  learnerId: string;
  lessonId: LessonId;
  mode: CheckMode;
  variant: "full" | "short";
  startedAt: IsoTime;
  endedAt: IsoTime;
  endReason: "done" | "timeout";
  outcome:
    | { kind: "passed"; bands?: FinalMixBands }
    | { kind: "failed"; failedCriteria: readonly CriterionId[] }
    | { kind: "void"; reason: VoidReason };
  criteria: readonly CriterionResult[];   // own + applicable standing
  tracks: ReadonlyArray<{ trackId: string; trackSetId: string | null; deck: "A" | "B" }>;
  aids: Readonly<{ sync: boolean; quantize: boolean; bpmDisplay: boolean; phaseMeter: boolean; lessonText: boolean }>;
  metrics: Readonly<Record<string, number>>;   // report-only: reversals, cueCount, techniqueCounts…
}

interface FinalMixBands {
  beatSyncing: Band; balance: Band; phrasing: Band;
  overall: Band;   // derived: lowest of the three
}

type RetentionState = "notPassed" | "passed" | "retained" | "lapsed";

interface CriterionRecord {
  criterionId: CriterionId;
  lessonId: LessonId;                 // the Lesson that introduced it
  last: { attemptId: string; at: IsoTime; mode: CheckMode; status: "met" | "notMet"; measured: number } | null;
  best: { attemptId: string; at: IsoTime; measured: number; margin: number } | null;
  firstPassedAt: IsoTime | null;
  passDates: readonly IsoTime[];      // gating modes only (not bonus); newest 20
  consecutiveFails: number;           // gating modes only
  retention: {                        // absent for standing criteria
    state: RetentionState;
    step: 0 | 1 | 2 | 3 | 4;          // index into [1, 3, 7, 21, 60] days
    nextDueAt: IsoTime | null;
    lastColdPassAt: IsoTime | null;
  } | null;
  practice: { attempts: number; met: number; lastAt: IsoTime | null };   // bonus only
}

interface LessonRecord {
  lessonId: LessonId;
  passedAt: IsoTime | null;
  passedVia: "lesson" | "placement" | null;
  attempts: number;                   // non-void, gating modes
  reviewSuggestedAt: IsoTime | null;
  reviewDeclinedAt: IsoTime | null;
  // retention is derived from the Lesson's CriterionRecords; not stored here
}

interface SkillProfile {
  schemaVersion: 1;
  learnerId: string;
  lessons: Readonly<Partial<Record<LessonId, LessonRecord>>>;
  criteria: Readonly<Partial<Record<CriterionId, CriterionRecord>>>;
  courseCompletedAt: IsoTime | null;
}
```

## 10. Decided by default

| Decision | Rationale |
|---|---|
| Checks are pure functions over a recorded attempt | Deterministic and unit-testable on synthetic timelines; the Coach cannot influence grading |
| Grade on heard time, mapped with `getOutputTimestamp()`; phase from playhead models | Research: one AudioContext cancels output latency, so the error budget is the grid alone |
| Taps scored by one-to-one matching with an extras cap | Stops tap-spamming from scoring well and penalises missed beats as well as wrong ones |
| No per-Learner tap calibration | It would hide rushing or dragging; the ±40 ms tolerance already absorbs input latency |
| Loudness from K-weighted momentary/short-term LUFS; clipping from sample peak `> −0.1 dBFS` | Standard meters (EBU R128), cheap in an AudioWorklet, track-independent |
| `audible` = gain `> −24 dB` and channel `> −40 LUFS` | Silent breakdowns and fader-down decks do not count as "in the mix" |
| Standing criteria apply only to situations the task contains | Avoids failing a tap Check for "off-phrase" |
| Merit/Distinction only for `final-mix`; overall band = lowest domain | LCME bands are for the prepared mix; the weakest domain is the honest summary |
| Only the beat-syncing, balance and phrasing domains are banded | They are the only LCME domains software can measure; the rest is Coach commentary |
| `final-mix` refuses tracks with grid RMS residual `> 15 ms` | Phase grading to 25 ms is meaningless on an unreliable grid |
| `final-mix` phrase markers confirmed by the Learner in track prep | Research: phrase markers are only reliable on hand-checked sets; prepping tracks is real DJ practice |
| Toasts for fail-severity mistakes live in Lesson Checks only; none in cold re-passes or `final-mix` | Immediate feedback while learning, exam conditions when proving it |
| Cold re-pass = no Lesson text, an alternate track from the same Lesson track set, same thresholds | Tests recall rather than recognition of a familiar track, at the same difficulty |
| Retention is per criterion; a Lesson's state is derived | One source of truth; warm-ups target what is actually fading |
| Ladder 1/3/7/21/60 days, `≥ 20 h` gap, 4 h slack | Catalogue intervals, plus a cap so retained skills still recur; slack lets a next-day session count |
| Early met results do not advance retention; any cold miss lapses | Spacing only works if recall is tested when due; a miss is real evidence of forgetting |
| Lapses never re-lock Lessons | Catalogue: progress is never time-gated |
| Warm-ups use short forms with the same thresholds; `final-mix` is always full | Short enough for a session start without being easier |
| Bonus exercises never touch pass, retention or the Review counter | Glossary: they never gate progress |
| Void attempts (suspended context, hidden tab, abandoned) are not recorded as fails | Failures should reflect skill, not browser hiccups |
| Review trigger = 3 consecutive gating fails on one criterion | Catalogue Q6 |

## 11. Questions for the owner

1. **Warm-up time per session.** Is about 10 minutes of warm-ups (at most 3 skills) at the start of
   each session OK, or would you rather cap it at 5 minutes, which spreads them over more sessions?
2. **Re-playing the whole final mix.** To count `final-mix` as retained, you would play the full
   3-track mix again (about 10–15 minutes) at least a day after passing it. Is that worth your time,
   or should a single blend plus a cut be enough?
3. **Showing Merit and Distinction.** After `final-mix`, do you want to see a Pass/Merit/Distinction
   band, or only pass/fail plus the measured numbers?

## Decisions (owner, 2026-10-16)

- **C1:** warm-ups are capped at **5 minutes** per session (at most 2 skills), framed as a quick "remember this?" challenge. This replaces the 10-minute default in §7.2.
- **C2:** the cold `final-mix` re-play, at least a day after the first pass, **is the recorded final project**. The app records the master bus to a downloadable file. The first pass is a rehearsal.
- **C3:** the Pass / Merit / Distinction band is shown after `final-mix`.
- **Lesson format (ISS-55):** controller-first and tuned for ADHD. Attempts last under a minute, practice runs straight into the Check with no screen in between, live feedback is instant, and the Coach says at most one line after a Check.

### Input leeway (owner, 2026-10-16)

The owner noted that on a MacBook trackpad, and on a simulated deck generally, leeway is needed. This amends the thresholds above until hardware controllers arrive:

- **Keyboard for timing-critical actions.** Play, cue, tap, hot cues and "cut" (snap a channel fader fully open or closed) get key bindings, and Lessons teach them first. A key press is the most precise input a laptop has.
- **Faders are judged on intent, not completion.** A channel-fader or crossfader move is timed from the moment it starts (first movement, or crossing 10% of travel), not when it finishes. A drag that starts on time passes even if it lands late.
- **Wider timing in Lesson Checks, tightening toward `final-mix`.** Point-in-time actions (cut, hot-cue trigger, phrase-start Play) get ±120 ms in the Lesson that introduces them, ±80 ms in later Lessons, and ±60 ms in `final-mix`. Tap Checks keep ±40 ms, since they are keyboard taps. Continuous measures (phase error, levels, bass clash) are unchanged, because they don't depend on gesture speed.
- **Point actions are timed from the action, not from the sound.** A Play (or a deck CUE press that starts a preview) is timed at its press, mapped to heard time like every input, so it sits on the same clock as the beats the Learner heard when pressing. The deck's audio starts later, by the output latency (Bluetooth headphones can add a few hundred ms) and the engine's lookahead; that gap never counts against the Learner. So `t_play(d)` is the heard time (`ctx`) of the `play` or `deckCue` event whose `appliedCtx` is the start of the deck's play run; an attempt without one falls back to the run start. Loudness measures (`loudJump`) stay on the audio start, and an incoming deck's own phrase position is read where its audio starts. `deck-basics.fade-in` (`t_in − t_play`, a 4-bar span, not a point action) keeps the audio start: the latency only makes that span shorter, never longer.
- **The input device is recorded with every attempt** (keyboard, trackpad, mouse, touch, and later MIDI), so these tolerances can be tuned per device once real attempts exist. There is still no per-Learner latency calibration.
