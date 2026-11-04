# rekordbox's mixer settings for the DDJ-FLX4

Researched 2026-11-03 for ISS-197: what gain law does each setting under rekordbox's [Preferences] >
[Controller] > [Mixer] apply, and how does it compare with the app's model? The crossfader curve has
its own note, `docs/research/crossfader-curve.md` (ISS-196).

**Result: mostly not published.** AlphaTheta's manuals name each setting and its choices, but give
no gain law, dB range or target for any of them in rekordbox. The one hard number found is the
DJM-900NXS's EQ range (the older mixer, not the NXS2). Everything marked "not confirmed" below needs
a measurement on a real FLX4 with rekordbox (see "How to settle it").

## What the primary sources say

- **The settings exist, and that's all.** rekordbox's manual lists them in one table: "[Auto Gain]
  Select [Enable] to automatically adjust the audio volume of the track loaded to a deck. You can
  also adjust it manually using the [Auto Gain] knob on the [GRID EDIT]." "[EQ] Select [EQ] or
  [ISOLATOR]. When [EQ] is selected, you can set [EQ Type]." "[Channel Fader Curve] Set the Channel
  fader curve." [R1, p. 242]
- **Channel Fader Curve.** The choices (Exponential, Linear, Logarithmic, as rekordbox shows them)
  are not described anywhere in R1 or F1: no curve, no dB values, no default.
- **EQ versus ISOLATOR.** "[EQ]: Use as the equalizer mode. [ISOLATOR]: Use as the isolator mode.
  When [EQ] is selected, set [EQ Type]. [DJM-900NXS]: Set to the same EQ characteristics of
  DJM-900NXS. [DJM-900NXS2]: Set to the same EQ characteristics of DJM-900NXS2." [R1, p. 173]. No
  band frequencies or ranges are given for either mode, and no default.
- **The FLX4's own manual** says only that the EQ knobs "Boost or reduce the relevant frequency for
  the selected channel" [F1, p. 26]. No range.
- **Auto Gain.** "[AUTO GAIN] loads the attenuation amount set when analyzing the track, and can be
  adjusted manually" [R1, p. 122]; the GRID EDIT panel shows "the Auto Gain value detected by track
  analysis" when the setting is on [R1, p. 140]. So it is a per-track gain fixed at analysis and
  saved with the track, not a live limiter. Its target (a peak, an RMS or a loudness level, and what
  value) is not published.

## The DJM-900NXS2's EQ (what rekordbox's [EQ Type] copies)

- **Not confirmed from a primary source.** Pioneer's online NXS2 manual (`docs.pioneerdj.com`)
  redirects to an AlphaTheta URL that returned 404 on 2026-11-03, and Pioneer's archived spec page
  for the NXS2 gives no EQ figures [P2]. No other AlphaTheta copy was found.
- **The predecessor, DJM-900NXS,** specifies "HI –26 dB to +6 dB (13 kHz), MID –26 dB to +6 dB
  (1 kHz), LOW –26 dB to +6 dB (70 Hz)" for its equalizer, with a hardware EQ CURVE (ISOLATOR, EQ)
  switch [D1, pp. 14, 26]. That is an archived copy of Pioneer's manual, not an AlphaTheta permalink.
- **Retailers' NXS2 listings** (secondary) give "EQ −26 dB to +6 dB" and "isolator −∞ to +6 dB"; one
  gives −8 dB for the isolator, likely an error.
- **Reading:** in EQ mode fully left is most likely a finite cut of about −26 dB, and in ISOLATOR mode
  a kill (−∞). The NXS2's band centres are not confirmed; the NXS's are 13 kHz, 1 kHz and 70 Hz.

## Compared with the app

| Setting | rekordbox (published) | Maintainer's setting | App today | Gap |
| --- | --- | --- | --- | --- |
| Channel Fader Curve | Exponential / Linear / Logarithmic; laws not published | Linear | amplitude = position², 0.5 ≈ −12 dB (`channelFaderGainDb`, `shared/attempt.ts`) | Unknown whether "Linear" is linear in amplitude (0.5 ≈ −6 dB) or in dB; either way the app's square law is quieter mid-travel |
| EQ / ISOLATOR | two modes; EQ copies DJM-900NXS or NXS2; ranges not published | EQ, DJM-900NXS2 | "Isolator EQ band": kill fully left, −26 dB just before, +6 dB fully right (`eqKnobToDecibels`, `src/audio/curves.ts`) | App's −26…+6 dB matches the likely EQ range except the kill at the end; EQ mode probably stops at about −26 dB, no kill. Band frequencies unconfirmed |
| Auto Gain | per-track gain set at analysis; target not published | on | Lessons trim to a −9 dBFS peak; new Mix Plans the same (ISS-190) | Target unknown, so a track's level after Auto Gain can't be predicted yet |
| CROSSFADER Curve | gradual … sharp range; no default or numbers (see `crossfader-curve.md`) | a little right of centre | constant power, −3 dB at centre (`crossfaderGainDb`) | Centre dip at that position unknown, probably under 3 dB |

## What can't be confirmed

- What Exponential, Linear and Logarithmic map to, and whether Linear is linear in amplitude or dB.
- The DJM-900NXS2's EQ band frequencies and ranges, and the ISOLATOR mode's ranges, from an
  AlphaTheta source.
- Whether rekordbox's EQ mode at fully left is a kill or a finite cut.
- What Auto Gain targets.
- The defaults for each setting.

## How to settle it

An owner-only check with the FLX4, rekordbox and a steady test tone or pink-noise track, recording the
master with rekordbox's recorder:

1. **Channel fader:** with the crossfader off or centred on one deck, record the fader at the top,
   three-quarters, half and a quarter, once per curve. At half, about −6 dB means linear in
   amplitude; a value in the middle of the dB range means linear in dB.
2. **EQ:** with [EQ] and DJM-900NXS2, sweep a test tone at 70 Hz, 1 kHz and 13 kHz with each band
   fully left and fully right. Repeat in [ISOLATOR]. Silence fully left is a kill.
3. **Auto Gain:** analyse a few tracks of known peak and loudness (LUFS) and read the GRID EDIT Auto
   Gain values; the value that brings them all to one level names the target.

## Sources

- [R1] AlphaTheta, *rekordbox ver. 7.2.18 Instruction Manual* (EN): Auto Gain p. 122, GRID EDIT
  p. 140, EQ/ISOLATOR p. 173, Preferences > Controller > Mixer p. 242.
  https://cdn.rekordbox.com/files/20260807093645/rekordbox7.2.18_manual_EN.pdf
- [F1] AlphaTheta, *DDJ-FLX4 Operating Instructions* (EN): EQ knobs p. 26.
  https://assets.ctfassets.net/q602vtcuu3w3/2vz7GMLHawLZBK6gWpCP9V/26bd62eef3eca3714ddb1d3396d30f7b/DDJ-FLX4_manual_EN.pdf
- [D1] Pioneer, *DJM-900NXS Operating Instructions* (EN), archived copy: EQ CURVE p. 14,
  specifications p. 26.
  https://archive.org/download/manualsonline-id-6897df39-30bc-4e77-9412-a30919471541/6897df39-30bc-4e77-9412-a30919471541.pdf
- [P2] Pioneer DJ, DJM-900NXS2 specifications page (archive, no EQ figures).
  https://www.pioneerdj.com/en/product/mixer/archive/djm-900nxs2/black/specifications/
- Not reached: Pioneer's NXS2 manual, https://docs.pioneerdj.com/Manuals/DJM_900NXS2_DRI1300A_manual/
  (redirects to a 404 on 2026-11-03).
