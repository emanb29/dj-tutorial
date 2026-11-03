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
- Await `engine.settled()` inside every `suspend()` that sends stretch messages, as the test does.
- Keep the stretched buffer's offset against the model under test (transients within 2 ms, as
  `deck.browser.test.ts` checks for the deck).
- `master-tempo-offline.browser.test.ts` stays as the regression check. Its `it.fails` case goes red if
  the stretcher ever continues from a snapshot, at which point the extra pass can go.

## Sources

- [S1] signalsmith-stretch 1.3.2 on npm (the JS/WASM release the engine uses):
  https://www.npmjs.com/package/signalsmith-stretch/v/1.3.2
- [S2] Signalsmith Stretch, the C++ library: https://signalsmith-audio.co.uk/code/stretch/
