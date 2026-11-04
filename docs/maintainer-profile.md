# Maintainer profile

The maintainer is the first Learner, and this is their taste, goal and setup. The design docs use it as
the default where the course has to pick one (a genre, a final-project target, a device to test on),
and the code never reads it: every Learner gives their own Mission in Placement.

**Forking?** Replace this file with your own. The defaults below each say what to change if yours differ.

## Mission

Post their own DJ mixes and edits (DJ remixes, not produced remixes) to SoundCloud. This is why the
course ends in a recorded final project with a WAV/MP3 download (`docs/lesson-catalogue.md`, "Final
project"), and why the Coach's eval cases use it (`docs/coach-design.md`, C1–C8).

## Taste

- **Source of truth:** Spotify listening, about 2,190 h over 2014–2023: indie/alt 41%, pop 18%,
  rock/metal 9%, house 3.2%, bass music 1.6%. SoundCloud flips they shared (about 45, mostly bass
  music) are practice material, not a taste signal.
- **What that sets:** remix targets lean to house, indie-dance and nu-disco remixes of indie, pop and
  rock songs. Bass music is the optional second genre. The graded course centres on house for
  teaching reasons (`docs/lesson-catalogue.md`, "Genre focus"), which this taste happens to fit.
- **To change:** remix targets and the second genre follow taste; the house core of the graded
  Lessons does not need to.

## Setup

- **Controller:** Pioneer DDJ-FLX4-N (the Gold Edition; same MIDI as the DDJ-FLX4).
- **Controller set-up (the default):** rekordbox's [Preferences] > [Controller] > [Mixer] set to:
  CROSSFADER Curve a little right of centre (between gradual and sharp); Channel Fader Curve Linear;
  EQ mode (not ISOLATOR), EQ Type DJM-900NXS2; Auto Gain on. What each one does, and how far the
  app's model differs, is in `docs/research/rekordbox-mixer-settings.md`.
- **Devices:** a MacBook (trackpad) and an Android phone, both on Chromium browsers, often reaching
  the dev server remotely through a `PUBLIC_HOSTS` tunnel. The UI must work on a phone.
- **Music:** a large local library (filter on metadata first; decode only a few tracks), plus the
  generator's Originals, which stay instrumental.

## Working style

Controller-first and hands-on within seconds; one-line captions, not paragraphs; tight feedback
loops; attempts under a minute. These are also the course's design limits for every Learner
(`docs/placement-design.md`).
