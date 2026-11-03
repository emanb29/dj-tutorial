# rekordbox's crossfader curve on the DDJ-FLX4

Researched 2026-11-03 for ISS-196: does the curve rekordbox uses by default for the DDJ-FLX4 dip at the
centre? The answer decides whether a cut on the 1 in a Mix Plan can use the crossfader without a level
jump (see `src/app/mix-editor/execution-plan.ts` and the crossfader curve in `shared/attempt.ts`).

**Result: not settled.** Primary sources show where the curve is set and what its range is, but none
of them gives its default position or the gain at the centre for any position. The evidence below
points to a dip at the centre for the smooth end and the middle of the range, and to no dip at the
sharp end. That stays an inference until someone measures it on a real FLX4 with rekordbox (see
"How to settle it").

## What the primary sources say

- **The FLX4 has no fixed curve of its own in rekordbox.** The FLX4 manual's crossfader entry says it
  "Adjusts the sound balance between the left and right channels depending on the crossfader curve
  setting" [F1, p. 30]. rekordbox's manual says the same of its mixer: "Audio is output from the
  crossfader according to the characteristics of the curve selected on the [Preferences] window >
  [Controller] category > [Mixer] tab > [CROSSFADER Curve]" [R1, p. 146].
- **The setting is a range from gradual to sharp, not a list of named curves.** The manual's own entry
  is one line: "[CROSSFADER Curve] Set the crossfader curve" [R1, p. 242]. AlphaTheta's help article
  describes it: "Turn the curve to the left, and the curve gradually rises. Turn the curve to the
  right, and the curve sharply rises" [A1].
- **No default is published.** The FLX4 manual lists defaults for its other rekordbox settings ("The
  default Cut Lag is 1.0 mm", the level meter's "[Channel Level]", and others [F1, pp. 78–80]) but
  states none for [CROSSFADER Curve]. rekordbox's manual states none either [R1, p. 242].
- **Smart Fader can override it.** "When [Use the recommended SMART FADER curve] isn't set, the curve
  changes according to the setting of [CROSSFADER Curve] or [Channel Fader Curve]" [F1, p. 80].
- **rekordbox for iOS/Android** has two named choices instead: "[Sharp]: When the crossfader is moved,
  the volume of the destination DECK is instantly maximized" and "[Smooth]: As the crossfader is moved,
  the volume of the destination DECK gradually increases" [A1]. No default is given there either.

## Evidence for a centre dip (secondary)

- A Pioneer DJ staff answer (marked as their support account), 2019, on an XDJ-RX2 whose curve
  "lowers the volume in the middle too much": "please try using the sharp cut if you don't want the
  volume to dip in the middle" [P1]. That is another device and an older rekordbox, but it says the
  non-sharp curves dip and the sharp one does not.
- A rekordbox 7 set-up guide (2025, Japanese, written by a DJ, not AlphaTheta) sets the curve fully
  right "so that the volume doesn't drop in the middle" (「真ん中で音量が下がらないように右側に設定」),
  because the author leaves the crossfader in the middle [N1]. That implies the out-of-the-box
  position drops the volume at the centre, but the guide does not say what that position is.

Neither source gives a number for the dip, so whether rekordbox's smooth curve is constant power
(−3 dB at centre, like the app's), linear (−6 dB) or something else is unknown.

## What this means for ISS-196

- The app's curve (constant power, both decks −3 dB at the centre, `crossfaderGainDb`) is consistent
  with "the smooth curves dip", but whether it matches rekordbox's default can't be confirmed.
- Every source agrees the sharp end has no dip: the destination deck is at full level as soon as the
  crossfader leaves its edge. A crossfader cut is level-neutral on that setting and not on the
  smooth one.
- So the issue's branch can't be picked from published sources. Fader cuts (bce5913) stay correct
  for every curve setting; a crossfader cut is correct only if the Learner's rekordbox is set sharp.

## How to settle it

An owner-only check, about five minutes with the FLX4 and rekordbox on default preferences (a fresh
install, or after noting the current [CROSSFADER Curve] position):

1. Screenshot [Preferences] > [Controller] > [Mixer] to record the default curve position.
2. Load the same steady track (or a test tone) on both decks, channel faders up, trims and EQ at
   centre.
3. Record the master (rekordbox's recorder) with the crossfader fully left for a few seconds, then
   at the centre, then fully right. Repeat with deck 2's channel fader down, so the centre shows one
   deck alone.
4. The level of one deck alone at the centre against fully at its side is the dip: 0 dB means no dip,
   about −3 dB means constant power, about −6 dB means linear.

## Sources

- [F1] AlphaTheta, *DDJ-FLX4 Operating Instructions* (EN): crossfader p. 30; rekordbox for
  Mac/Windows settings pp. 78–80.
  https://assets.ctfassets.net/q602vtcuu3w3/2vz7GMLHawLZBK6gWpCP9V/26bd62eef3eca3714ddb1d3396d30f7b/DDJ-FLX4_manual_EN.pdf
- [R1] AlphaTheta, *rekordbox ver. 7.2.18 Instruction Manual* (EN): Mixer panel p. 146; Preferences
  > Controller > Mixer p. 242.
  https://cdn.rekordbox.com/files/20260807093645/rekordbox7.2.18_manual_EN.pdf
- [A1] AlphaTheta Help Center, "I don't like the cut of the crossfader. Can I adjust it?" (read
  2026-11-03). https://support.alphatheta.com/en-US/articles/37282049312281
- [P1] Pioneer DJ forums, "Rekordbox 4.02 crossfader curve", official reply of 2019-08-02.
  https://forums.pioneerdj.com/hc/en-us/community/posts/204353546/comments/360006857632
- [N1] note.com, "[For Anime Song DJ Beginners] Initial Settings to Configure After Installing
  rekordbox", 2025-03-29, section 「クロスフェーダーカーブ」.
  https://note.com/taztaz926/n/n51643de0e9c4
