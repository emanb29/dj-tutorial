# DDJ-FLX4 (and DDJ-FLX4-N): MIDI, USB audio and browser routing

Researched 2026-10-17 for hardware support (branch `feat/flx4`). The source of truth for every MIDI
byte is AlphaTheta's own **"DDJ-FLX4 List of MIDI messages", Ver 1.0** [M1]. Mixxx's GPL mapping
[X1, X2] was read only to cross-check facts; nothing was copied from it. Facts marked **(unverified)**
need the real device; the Controller page (`/controller`) has a live monitor and a "move every
control" checklist for that.

## The -N variant

**DDJ-FLX4-N is the limited "Gold Edition" colourway** (black body, gold accents), released in Japan on
2026-06-26 at ¥52,800. Retailers describe its functions and specifications as the same as the black
model [N1, N2, N3]. AlphaTheta publishes one MIDI list for the DDJ-FLX4, and no separate one for the -N.

- **Messages:** assumed identical (same hardware, same list).
- **USB ids and port names (unverified):** no source gives them for the -N. The app finds the device
  by a port name containing `DDJ-FLX4` (case-insensitive), which matches both `DDJ-FLX4` and a
  hypothetical `DDJ-FLX4-N`. The Controller page lists every MIDI port it sees, so a different name
  shows up at once.

## MIDI message list (from [M1])

Notation: status byte in hex, then data 1. Buttons send note-on with velocity `0x7F` for press and
`0x00` for release (not note-off). "Deck 1" is MIDI channel 1 (`0x90`/`0xB0`), "Deck 2" is channel 2
(`0x91`/`0xB1`). The app's deck A is deck 1 and deck B is deck 2.

### Deck (channel 1 = `9n/Bn` with n = 0, channel 2 with n = 1)

| Control | Message | +SHIFT | LED out |
|---|---|---|---|
| PLAY/PAUSE | `9n 0B` | `9n 0E` | same as in |
| CUE | `9n 0C` | `9n 48` | same as in |
| SHIFT | `9n 3F` | — | none |
| Jog platter turn (vinyl mode on, the default) | `Bn 22` | `Bn 29` | — |
| Jog platter turn (vinyl mode off) | `Bn 23` | `Bn 29` | — |
| Jog platter touch | `9n 36` | `9n 67` | — |
| Jog wheel side turn | `Bn 21` | `Bn 21` | — |
| LOOP IN | `9n 10` | `9n 4C` | same as in |
| LOOP OUT | `9n 11` | `9n 4E` | same as in |
| 4 BEAT/EXIT | `9n 4D` | `9n 50` | none |
| CUE/LOOP CALL ◁ | `9n 51` | `9n 3E` | none |
| CUE/LOOP CALL ▷ | `9n 53` | `9n 3D` | none |
| BEAT SYNC | `9n 58` (sent on **release**, note 3) | `9n 60` | `9n 58`, `9n 60` |
| BEAT SYNC long press | `9n 5C` | — | none |
| TEMPO fader | `Bn 00` MSB, `Bn 20` LSB | same | — |
| TRIM | `Bn 04` / `Bn 24` | | |
| EQ HI | `Bn 07` / `Bn 27` | | |
| EQ MID | `Bn 0B` / `Bn 2B` | | |
| EQ LOW | `Bn 0F` / `Bn 2F` | | |
| Channel CUE (headphones) | `9n 54` | `9n 68` | same as in |
| Channel fader | `Bn 13` / `Bn 33` | SHIFT: fader-start notes `9n 66` (leaves bottom), `9n 52` (reaches bottom) | — |
| Channel level meter | — | — | `Bn 02 vv` |

Jog turns are **relative**: "difference count value from previous operation", clockwise counts up
from `0x41`, counter-clockwise down from `0x3F`, so ticks = value − 64. **720 ticks per platter
revolution** comes from Mixxx's `scratchEnable(deck, 720, …)` [X1], not from [M1] **(unverified)**.

Fourteen-bit controls send MSB (`cc`) and LSB (`cc + 0x20`), each 7 bits: value = MSB·128 + LSB,
0…16383. Order MSB-then-LSB is the usual Pioneer behaviour and how Mixxx treats it **(unverified)**;
the app combines on the LSB. Ranges per [M1]: tempo 0 = "−" side, 16383 = "+" side; faders 0 =
bottom; crossfader 0 = left; knobs 0 = fully counter-clockwise.

Level meter LED (`Bn 02 vv`): lights from the bottom: green 1 `0x26–0x40`, green 2 `0x41–0x56`,
orange 1 `0x57–0x64`, orange 2 `0x65–0x76`, red `0x77–0x7F`.

### Mixer and browse (channel 7 = `96`/`B6`)

| Control | Message | +SHIFT | LED out |
|---|---|---|---|
| MASTER LEVEL | `B6 08` / `B6 28` | | — |
| MASTER CUE | `96 63` | `96 78` | none listed |
| CFX deck 1 / deck 2 | `B6 17` / `B6 37`, `B6 18` / `B6 38` | | — |
| Crossfader | `B6 1F` / `B6 3F` | SHIFT: crossfader-start notes on `90`/`91` `66`/`52` | — |
| MIC LEVEL | `B6 05` / `B6 25` | | — |
| SMART CFX | `96 00` | `96 08` | `96 00` |
| HEADPHONE MIX | `B6 0C` / `B6 2C` | | — |
| HEADPHONE LEVEL | `B6 0D` / `B6 2D` | | — |
| SMART FADER | `96 01` | `96 09` | `96 01` |
| Android MONO/STEREO switch | `96 6D` (0 stereo, `7F` mono) | | — |
| BROWSE turn | `B6 40` | `B6 64` | — |
| BROWSE press | `96 41` | `96 42` | — |
| LOAD deck 1 | `96 46` | `96 68` | — |
| LOAD deck 2 | `96 47` | `96 7A` | — |

BROWSE turn is relative too, but two's-complement style: clockwise counts up from `0x01`,
counter-clockwise down from `0x7F`.

### Beat FX (channels 5 and 6 = `94`/`95`, `B4`)

| Control | Message | +SHIFT |
|---|---|---|
| FX SELECT | `94 63` | `94 64` |
| BEAT ◁ | `94 4A` | `94 66` |
| BEAT ▷ | `94 4B` | `94 6B` |
| LEVEL/DEPTH | `B4 02` / `B4 22` | |
| FX ON/OFF (CH1, or CH1&CH2) | `94 47` | `94 43` |
| FX ON/OFF (CH2) | `95 47` | `95 43` |
| FX CH SELECT lever | four notes per move: `94 10`, `94 11`, `95 10`, `95 11` | |

The CH SELECT lever reports its position as a set of note values: CH1 = `94 10 7F` (others `00`);
CH2 = `95 11 7F`; CH1&CH2 = both `94 10 7F` and `95 11 7F`. [M1]'s channel column says "6" for
LEVEL/DEPTH while its status column says `B4` (channel 5); Mixxx also uses `B4` [X2], so the app
does. FX ON/OFF LED: note 4 of [M1] says the button **blinks on a NOTE ON and lights on a NOTE OFF**;
no MIDI-OUT row is given, so the app sends to the same address **(unverified)**.

### Performance pads

Pad-mode buttons are on the deck channels: HOT CUE `9n 1B` (SHIFT: KEYBOARD `9n 69`), PAD FX1
`9n 1E` (SHIFT: PAD FX2 `9n 6B`), BEAT JUMP `9n 20` (SHIFT: BEAT LOOP `9n 6D`), SAMPLER `9n 22`
(SHIFT: KEY SHIFT `9n 6F`). Each has an LED at the same address.

Pads 1–8 are notes `base + (pad − 1)` on their own channels: deck 1 `97` (SHIFT `98`), deck 2 `99`
(SHIFT `9A`). The base is the pad mode: HOT CUE `00`, PAD FX1 `10`, BEAT JUMP `20`, SAMPLER `30`,
KEYBOARD `40`, PAD FX2 `50`, BEAT LOOP `60`, KEY SHIFT `70`. Each pad LED is at the same address. The
controller keeps its own pad mode and sends the mode's notes.

### Settings messages (MIDI-OUT only)

- Track-load illumination: `9F 00 7F` (deck 1), `9F 01 7F` (deck 2).
- Vinyl mode: `90 17 vv` / `91 17 vv` (on `7F` by default). "Vinyl mode can't be changed from the
  unit" (note 2).

### Not in the official list

- **Master Tempo.** The FLX4 has **no MASTER TEMPO button and no message for it**. SHIFT + BEAT
  SYNC changes the tempo range (Mixxx maps `9n 60` to "change tempo range" [X2]). The app maps
  BEAT SYNC **long press** (`9n 5C`) to MASTER TEMPO, and shows Master Tempo on BEAT SYNC's SHIFT-layer
  LED (`9n 60`), which the unit shows while SHIFT is held **(unverified)**. The virtual controller
  has no MASTER TEMPO button either: holding the on-screen BEAT SYNC for 800 ms toggles Master Tempo
  (a small lamp on the button shows it), SHIFT + BEAT SYNC cycles the range.
- **TAP.** No TAP button, but the panel prints **TAP** under BEAT ▷ as its SHIFT function (and AUTO
  under BEAT ◁); rekordbox's hardware diagram lists SHIFT + BEAT ▷ as "BPM tap mode on" and SHIFT +
  channel CUE as "Tap BPM" [cdn.rekordbox.com DDJ-FLX4_Hardware_Diagram_en.pdf]. The app's TAP is
  SHIFT + BEAT ▷ (`94 6B`), always; plus any performance pad while the pads are
  locked and plain BEAT ◁ / ▷ while Beat FX is locked (src/app/controller/hardware.ts). BROWSE and
  LOAD move around the app and press its keys instead (src/app/controller/flx4-keys.ts).
- **Positions on connect.** AlphaTheta's list (Ver 1.0, all five pages) has **no status request, no
  "send all controls" message and no SysEx at all**; its only notes (*1–*4) are about MIDI assign
  notation, vinyl mode, BEAT SYNC sending on release and the FX ON/OFF LED. Nothing says the unit
  reports positions on USB connect or port open. So officially, the FLX4 cannot tell the app where its
  faders and knobs are until each one moves.
  Cross-check only: Mixxx sends a reverse-engineered SysEx (`F0 00 40 05 00 00 04 05 00 50 02 F7`,
  "reverse engineered with Wireshark") on start, commented "query the controller for current control
  positions on startup", and every 200 ms as a keep-alive [X1]. Unofficial and **unverified here**.
  What the app does:
  - Every fader and knob message is remembered for the tab (`src/midi/positions.ts`); when a
    controller appears on screen (a Lesson, the playground), each known control shows its dashed
    pickup mark at once, and a locked control that moves shows its mark too. Soft takeover stays.
  - The Controller page's **Sync from controller** lists the mapped faders and knobs and ticks each as
    it reports ("wiggle each knob"), and says in one line that the FLX4 cannot report positions until
    they move.
  - The Mixxx SysEx request was tried on the owner's FLX4-N on 2026-10-17 and got no answer, so it was removed.

## USB audio

- **Class compliant, no driver** on macOS, Windows and Linux (Mixxx manual [X3]; AlphaTheta's own
  driver page lists drivers only for Windows ASIO).
- **Outputs:** master on channels **1/2**, headphones on **3/4** [X3].
- **Hardware-processed knobs:** Mixxx's manual says MASTER LEVEL "is hardware implemented and is not
  mapped to the software gain", and MASTER CUE "is hardware implemented" [X3]. HEADPHONE LEVEL and
  MIX may be too **(unverified)**. The app still records them (Lessons grade master level), so when
  playing through the FLX4 the master knob may act twice: once in the app, once in the unit.
- **Headphone knobs, what is documented (read 2026-10-18):** the Mixxx manual lists HEADPHONES
  MIXING ("adjusts between headphone CUE and MASTER levels sent to headphones") and HEADPHONES LEVEL
  ("adjusts output level from PHONES jack") with no "hardware implemented" note, unlike MASTER and
  MASTER CUE [X3]. Mixxx's mapping sends HEADPHONES MIXING (`B6 0C`/`2C`) to its software `headMix`
  and maps no HEADPHONES LEVEL at all [X2], which suggests MIX is mixed in software and LEVEL in the
  unit. MASTER CUE "sends master output to headphones" in the unit [X3]. None of it is confirmed on
  the owner's unit **(unverified)**. The app maps HEADPHONES MIX to its own cue mix either way.
- **What the app does with them (2026-10-19, owner: "make the headphone level dial actually be
  respected"):** HEADPHONES LEVEL and MIXING drive the app's values at once, with no soft takeover
  (`HARDWARE_FIRST` in `src/app/controller/hardware.ts`). Before, the app started at LEVEL 12 o'clock
  and MIXING fully to CUE, and the knobs did nothing until turned past those points. Going by Mixxx's
  mapping, the app takes LEVEL to be applied in the unit, so where the cue leaves through the FLX4's
  own outputs 3/4 (Through the FLX4, and this computer's speakers with the FLX4's headphones) the app
  leaves its headphone gain at 1 rather than apply LEVEL a second time. On this computer's output
  (split cue) and on a second headphone device, the app applies LEVEL itself. In a Lesson without
  headphone cueing, this computer plays only the master (as the speakers), which LEVEL does not touch,
  as on the unit. LEVEL is unlocked in every Lesson (`ALWAYS_UNLOCKED`, `src/lessons/catalogue.ts`):
  it is a listening volume, not a skill. If LEVEL does nothing through the FLX4, the unit does not
  apply it after all, and `ControllerCueMonitor` and `controllerPhonesSink` must apply it again.
- **Speakers on the computer, headphones on the FLX4** (`computer-and-controller-phones`): the FLX4's
  outputs 1/2 carry silence and 3/4 the app's headphone mix. If the unit does mix HEADPHONES MIX
  itself, its MASTER side is that silence and would fade the cue out, so `/controller` says to turn
  it to CUE; MASTER CUE would add only silence.
- **PC MASTER OUT** (`dual-master`, read 2026-10-19): rekordbox's name for playing the master on the
  computer's speakers as well as the controller; with it on, rekordbox's Master Output preference
  names the computer's device alongside "DDJ-FLX4 : MASTER", and with it off only the latter [R1].
  The app's version: master on the computer's device and on the FLX4's 1/2, the app's headphone mix
  on 3/4. MASTER LEVEL may act in the unit **(unverified, see above)**, so the FLX4's MASTER OUT can
  sit at a different level from the computer's speakers.
- The mic input cannot be used as a computer input device [X3].

## Browser APIs (Chrome, Edge, Arc on macOS)

- **Web MIDI:** `navigator.requestMIDIAccess()` needs a secure context (dj.example.com is HTTPS)
  and, in current Chrome, a permission prompt. `MIDIMessageEvent.timeStamp` is a
  `DOMHighResTimeStamp` on the `performance.now()` clock, the same domain as keyboard
  `event.timeStamp`, so `audioContextClock().heardTime(timeStamp)` maps it to heard time unchanged,
  **except** that Chrome returns 0 for a null packet time or one before the page's time origin
  (`Performance::MonotonicTimeToDOMHighResTimeStamp`), and on macOS the packet time is CoreMIDI's
  `MIDIPacket.timeStamp` via `TimeTicks::FromMachAbsoluteTime` (media/midi/midi_manager_mac.cc), which a
  driver may leave 0 ("now"). `src/midi/event-time.ts` replaces such a stamp with the handler's time.
  MIDI input is not a user activation: an `AudioContext` still needs a click or key press to start.
- **Output device:** `AudioContext.setSinkId(id)` and `new AudioContext({ sinkId })`, Chrome 110+;
  feature-detect with `"setSinkId" in AudioContext.prototype` [C1].
- **Finding the FLX4's output:** `navigator.mediaDevices.enumerateDevices()` lists every device only
  once the **microphone** permission is granted; otherwise only defaults [C1]. So "Play through the
  FLX4" asks for the microphone once (the stream is stopped at once and nothing is recorded), then
  finds an `audiooutput` whose label contains `DDJ-FLX4`.
- **Four channels:** after the sink is set, `destination.maxChannelCount` reports the device's
  channels; with 4 or more, set `destination.channelCount = 4`,
  `channelInterpretation = "discrete"`, and feed a 4-input `ChannelMergerNode` (master L/R to 0/1, cue
  L/R to 2/3). Fewer than 4: fall back to split cue on the default output **(unverified on the
  FLX4)**.

## Sources

- [M1] AlphaTheta, "DDJ-FLX4 List of MIDI messages", Ver 1.0 —
  https://downloads.support.alphatheta.com/software_info/dj-controllers/DDJ-FLX4/DDJ-FLX4_MIDI_message_List_E1.pdf
  (linked from the "DDJ-FLX4 – MIDI-compatible software" help article,
  https://support.alphatheta.com/en-US/articles/12294087060377)
- [N1] Shimamura Music, DDJ-FLX4-N (GOLD Edition), 2026-06-26 — https://www.shimamura.co.jp/update/?p=13243
- [N2] Shimamura Music Chiba, limited gold DDJ-FLX4-N and XDJ-AZ-N — https://www.shimamura.co.jp/update/shops/chiba/digital-dj/14766/
- [N3] DJ City Australia, DDJ-FLX4-N Limited Edition Gold — https://djcity.com.au/product/pioneer-dj-ddj-flx4-n-2-channel-dj-controller-limited-edition-gold/
- [R1] Crossfader, "Getting Started With The Pioneer DJ DDJ-FLX4" (third-party; the rekordbox manual was not reached) — https://wearecrossfader.co.uk/blog/getting-started-with-the-pioneer-dj-ddj-flx4/
- [X1] Mixxx, `Pioneer-DDJ-FLX4-script.js` (GPL; cross-check only) — https://github.com/mixxxdj/mixxx/blob/main/res/controllers/Pioneer-DDJ-FLX4-script.js
- [X2] Mixxx, `Pioneer-DDJ-FLX4.midi.xml` (GPL; cross-check only) — https://github.com/mixxxdj/mixxx/blob/main/res/controllers/Pioneer-DDJ-FLX4.midi.xml
- [X3] Mixxx manual, Pioneer DDJ-FLX4 — https://manual.mixxx.org/2.4/en/hardware/controllers/pioneer_ddj_flx4
- [C1] Chrome for Developers, "Change the destination output device in Web Audio" — https://developer.chrome.com/blog/audiocontext-setsinkid
