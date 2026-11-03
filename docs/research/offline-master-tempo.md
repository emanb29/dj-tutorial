# Master Tempo in an offline render

Researched 2026-11-02 for the Mix Editor's Render (ISS-188, ahead of ISS-190). The question: can
`AudioEngine` on an `OfflineAudioContext` render a deck with Master Tempo (key lock) through the
signalsmith-stretch worklet [S1], and does that still hold when the Render is split into segments of
about 2 minutes, each started from a snapshot of the engine state?

The evidence is `src/audio/master-tempo-offline.browser.test.ts` (Chromium, Vitest browser mode,
48 kHz, nothing reaches the speakers).

## Answer

**Works with one caveat.** One offline render plays Master Tempo correctly: the pitch holds at every
tempo, the length follows the tempo, mid-render tempo changes land, and the output is deterministic.
**But a segment started from a snapshot does not continue the previous segment while the stretcher
plays**: the seam is not sample-continuous, and no amount of preroll fixes it. Without Master Tempo,
segments from a snapshot are continuous.

So the Render should not run the stretcher inside segmented mix renders. It should stretch each Master
Tempo track in one pass of its own, then mix that stretched audio in segments with Master Tempo off
(see the recommendation below).

## How the engine does Master Tempo

- `src/audio/voices.ts`: each deck has two voices behind one seam. `RateVoice` is an
  `AudioBufferSourceNode` whose `playbackRate` moves pitch with tempo. `StretchVoice` drives a
  signalsmith-stretch `AudioWorkletNode` per deck, which holds the whole track (`addBuffers`) and plays
  it from a time map (`schedule({ output, input, rate })`).
- `src/audio/engine.ts` loads two stretch nodes, schedules a Master Tempo deck at least the stretcher's
  latency (0.12 s) ahead (`stretchLeadSec`), and lets callers await worklet messages
  (`engine.settled()`). If the worklet fails to load, `masterTempoAvailability` says why and
  `master-tempo` is refused. That is the degraded path the `tempo-fader` Lesson shows
  (`LessonPlayer.tsx`).
- The worklet seeks its input on every render quantum (it reads the time map, copies the input window
  and calls the WASM `_seek` then `_process`), but its synthesis phases carry on from block to block.
  That is why one render is coherent and two renders are not.

## Measurements

One render, deck A alone on the master, Master Tempo on, 8 bars at 120 BPM (16 s) of a 440 Hz tone:

| Tempo | Pitch (zero crossings, 1–14 s) | Audio end vs the model's end |
| --- | --- | --- |
| +4% | 440.4 Hz | +4.9 ms |
| +6% | 440.4 Hz | +9.4 ms |
| −6% | 440.4 Hz | +9.5 ms |
| +4%, Master Tempo off (comparison) | 457.6 Hz (×1.04) | — |

440.4 Hz is the zero-crossing count's resolution over 13 s: the pitch is unchanged well within the
issue's 1%. The end trails by the stretcher's STFT smear on the tone's last frames; the existing click
test (`deck.browser.test.ts`) puts transients within 2 ms of the model.

- **Tempo ride mid-render** (suspend at 1 s, tempo 0 → +6%, resume): the track ends 3.6 ms from the
  model's end. Had the change not landed, it would end 170 ms later. It landed with or without awaiting
  `engine.settled()` inside the suspend; the test awaits it, since without that it is a race against
  the render.
- **PLAY sent mid-render** with Master Tempo on: onset 0.02 ms from the model's start. (The comment in
  `deck.browser.test.ts` says stretch messages sent while an offline context is suspended do not take
  effect; with the current engine they do.)
- **Determinism:** the same Master Tempo render twice: identical samples (max difference 0).
- **Speed:** a 16 s render with both stretch nodes loaded takes about 1.15 s, about 14× real time on
  the development machine.

Seams: a reference render, then a second render started from the reference's playhead at the seam
(4 s), compared over the second after the seam. The signal is three inharmonic partials (311, 440,
677 Hz, peak 0.6), so only a zero time shift lines the two up. The "natural step" is the largest
sample-to-sample change in the reference just before the seam (0.037).

| Case | Preroll | Max difference after the seam | Step at the seam |
| --- | --- | --- | --- |
| Master Tempo on | 0 s | 0.54 | 0.29 |
| Master Tempo on | 0.25 s | 0.35 | 0.08 |
| Master Tempo on | 1 s | 0.49 | 0.13 |
| Master Tempo off | 0 s | 0.16 (a fresh mixer's first ms) | 0.14 |
| Master Tempo off | 0.25 s | 0.00026 | 0.014 |
| Master Tempo off | 1 s | 0.00021 | 0.014 |
| Stretched once, then played with Master Tempo off at 0% | 0.25 s | under 0.001 | under the natural step |

With Master Tempo on, no lag within ±20 ms lines the two renders up either (best residual 0.06–0.17),
so this is phase, not timing. A 20 ms linear crossfade across the seam dips by about 6 dB at its
worst 2 ms, which is a short, audible notch on tonal music, not a seamless join.

## The Learner's own files: formats, sample rates, long tracks

The Render runs on the Learner's local library, so the same path was checked on decoded files rather
than on buffers built in the test. These were 10-minute stereo 440 Hz files made with ffmpeg: MP3 and
AAC (`.m4a`) at 44.1 kHz and 192 kbit/s, and WAV at 44.1 and 48 kHz. Each was decoded the way the app
does it (`decoderAt(rate)` in `src/tracks/load-audio.ts`), loaded with Master Tempo on, sought to 9:50,
and rendered for 5 s at +4%. The check was a one-off and is not in the suite, since the files run to
100 MB.

| File | Render at 48 kHz | Render at 44.1 kHz |
| --- | --- | --- |
| MP3, 44.1 kHz | 440.5 Hz, decode 1.7 s | 440.5 Hz, decode 0.9 s |
| AAC, 44.1 kHz | 440.3 Hz, decode 1.7 s | 440.5 Hz, decode 1.1 s |
| WAV, 44.1 kHz | 440.5 Hz, decode 1.1 s | 440.5 Hz, decode 0.6 s |
| WAV, 48 kHz | 440.5 Hz, decode 0.6 s | 440.5 Hz, decode 1.2 s |

- **Pitch:** every case kept the key. The 457.6 Hz (+4%) bin was 60 to 100 dB below the 440 Hz one,
  and the playhead read 594.97 s at the end, as the model says.
- **Load:** 35 to 55 ms, including the transfer of the 10-minute track into the stretch worklet.
- **Sample rate:** one render runs at one rate, and `engine.load` refuses a buffer at any other rate
  (with a message that says to decode it with the engine's context). `decodeAudioData` resamples a file
  to the decoding context's rate, so files at 44.1 and 48 kHz mix freely, as long as the Render decodes
  every track at the render's rate. 44.1 kHz suits most libraries, since most files are 44.1 kHz and
  that rate needs no resampling for them. 48 kHz also works.
- **Codecs:** Playwright's Chromium decoded AAC as well as MP3 and WAV. A format the browser cannot
  decode fails in `decodeAudioData`, before the engine, so the Render must report it per track.
- **Length and memory:** 10 minutes worked at both rates. With Master Tempo, a loaded track is held
  twice: the deck's `AudioBuffer`, plus a copy per channel in the worklet. At 48 kHz stereo float that
  is about 23 MB a minute per copy, so about 460 MB for a 10-minute track. The recommended stretch
  pass adds its output (about 220 MB for that track at +4%). Only the two overlapping tracks should be
  loaded at once, and the earlier ones' buffers released.
- **Stretch pass speed:** the stretcher alone over a 10-minute track at +4% (577 s of output) rendered
  in 18 s, about 32× real time, and kept 440.4 Hz to the end.

## Options for the segmented Render

1. **Stretch each track in one pass, then mix in segments without Master Tempo (recommended).** For each
   Master Tempo track, render the stretcher alone over the track's whole span in the set, in one
   `OfflineAudioContext`. The tempo lane becomes the stretcher's time map, scheduled before the render
   starts (`schedule` takes output times, so a ride needs no suspend). The mix segments then play that
   stretched buffer at 0% with Master Tempo off, where seams are continuous (measured above). The sound
   is the same, since the stretcher sits before the mixer in the chain. Cost: one extra float buffer per
   track span (48 kHz stereo is about 23 MB a minute, so about 140 MB for a 6-minute span), only for the
   two tracks that overlap at once. It adds a time map from track position to stretched-buffer time,
   which the scheduler already needs.
2. **Overlap and crossfade the segments.** Simple, but the seam is not continuous (about a 6 dB dip on
   tonal material). It would fail the design's seam test.
3. **Cut segments only where no Master Tempo deck plays.** In a set, the incoming track usually plays
   its whole life at the outgoing track's tempo, so such places are rare. Not viable.
4. **A streaming stretcher outside the audio graph.** Build the Signalsmith Stretch library [S2] to WASM
   for a worker and keep its state across segments. That gives continuous seams with no extra buffer,
   but it is a new build step and a second copy of the stretcher to keep in step with the worklet.
5. **Degraded path: rate change, no key lock.** Always works and segments cleanly. Within ±6% the key
   moves by up to about one semitone. The Render says so ("Rendered without Master Tempo: the key
   shifts with tempo"), as the design already plans.

## Recommendation for ISS-190

- Use option 1: a per-track stretch pass, then segmented mix renders with Master Tempo off. Keep
  option 5 as the fallback when `masterTempoAvailability` is false or the stretch pass fails, and say
  so in the result.
- In the stretch pass, build the time map from the tempo lane up front; ramps become rate steps (one
  per beat is finer than a hand on the fader).
- Decode every track at the render's rate (44.1 kHz suggested) and report an undecodable file per
  track. Run the stretch passes one at a time. At 44.1 kHz, one pass over a 10-minute
  track holds about 630 MB (the input, the worklet's copy and the output). The mix pass then holds only
  the two overlapping stretched tracks, about 420 MB, since it plays them without the worklet.
- Await `engine.settled()` inside every `suspend()` that sends stretch messages, as the test does.
- Keep the stretched buffer's offset against the model under test (transients within 2 ms, as
  `deck.browser.test.ts` checks for the deck).
- `master-tempo-offline.browser.test.ts` stays as the regression check. Its `it.fails` case goes red if
  the stretcher ever continues from a snapshot, at which point the extra pass can go.

## Sources

- [S1] signalsmith-stretch 1.3.2 on npm (the JS/WASM release the engine uses):
  https://www.npmjs.com/package/signalsmith-stretch/v/1.3.2
- [S2] Signalsmith Stretch, the C++ library: https://signalsmith-audio.co.uk/code/stretch/
