import { describe, expect, it } from "vitest";
import { inputWording, startingWording } from "./wording.ts";

describe("inputWording on a touchscreen", () => {
  const touch = (text: string) => inputWording(text, "touch");

  it("names the control instead of the key", () => {
    expect(touch("Press X")).toBe("Tap PLAY");
    expect(touch("Tap Space on every kick")).toBe("Tap TAP on every kick");
    expect(touch("Press ,")).toBe("Tap PLAY on deck B");
    expect(touch("Press Z")).toBe("Hold CUE");
    expect(touch("Press 3")).toBe("Tap pad 3");
  });

  it("names the loop buttons and Beat FX for their keys", () => {
    expect(touch("Press G: a 4-beat loop")).toBe("Tap 4 BEAT/EXIT: a 4-beat loop");
    expect(touch("LOOP IN on a 1 (D)")).toBe("LOOP IN on a 1");
    expect(touch("Count 4 bars: LOOP OUT on the 1 (F)")).toBe("Count 4 bars: LOOP OUT on the 1");
    expect(touch("Next loop's 1: EXIT (G)")).toBe("Next loop's 1: EXIT");
    expect(touch("Press J")).toBe("Tap 4 BEAT/EXIT on deck B");
    expect(touch("Press V: BEAT FX on")).toBe("Tap BEAT FX ON: BEAT FX on");
    expect(touch("ECHO on (V), cut A on a 1 (S), then FX off (V)")).toBe("ECHO on, cut A on a 1, then FX off");
    expect(touch("Press ] for longer echoes")).toBe("Tap BEAT ▶ for longer echoes");
    expect(touch("Pad 1: jog to the 1 (hold Z to check), Press 1, then R")).toBe("Pad 1: jog to the 1 (hold CUE to check), Tap pad 1, then Ready");
  });

  it("drops a key that only repeats what the caption already says", () => {
    expect(touch("Push the fader up (W)")).toBe("Push the fader up");
    expect(touch("Now pull it down (S)")).toBe("Now pull it down");
    expect(touch("Again: fade in (W), fade out (S)")).toBe("Again: fade in, fade out");
    expect(touch("Finish with the fader all the way down (S).")).toBe("Finish with the fader all the way down.");
  });

  it("names the control in an aside", () => {
    expect(touch("Keep tapping every beat (Space)")).toBe("Keep tapping every beat (TAP)");
    expect(touch("Tap each new phrase (Space)")).toBe("Tap each new phrase (TAP)");
  });

  it("rewrites a bare letter key in a sentence", () => {
    expect(touch("This one counts: X, fade in within 4 bars, fade out")).toBe("This one counts: PLAY, fade in within 4 bars, fade out");
    expect(touch("Press X, then W right away.")).toBe("Tap PLAY, then push the fader up right away.");
  });

  it("leaves numbers, deck letters and plain words alone", () => {
    expect(touch("Count in: 1, 2, 3, 4")).toBe("Count in: 1, 2, 3, 4");
    expect(touch("Which phrase was the breakdown?")).toBe("Which phrase was the breakdown?");
    expect(touch("Deck A is silent")).toBe("Deck A is silent");
    expect(touch("Turn MASTER down a touch: the meter hit red.")).toBe("Turn MASTER down a touch: the meter hit red.");
  });
});

describe("inputWording with a keyboard", () => {
  it("keeps the authored key wording", () => {
    expect(inputWording("Press X", "keys")).toBe("Press X");
    expect(inputWording("Push the fader up (W)", "keys")).toBe("Push the fader up (W)");
  });
});

describe("startingWording", () => {
  it("starts in touch wording on a coarse pointer and key wording on a fine one", () => {
    expect(startingWording({ coarsePointer: true })).toBe("touch");
    expect(startingWording({ coarsePointer: false })).toBe("keys");
  });
});

describe("captions with a controller connected", () => {
  it("name the hardware's TAP before Space", () => {
    expect(inputWording("Tap Space on every kick", "keys", "SHIFT + BEAT ▶ (TAP), any pad")).toBe("Tap SHIFT + BEAT ▶ (TAP), any pad or Space on every kick");
    expect(inputWording("Tap every beat (Space)", "keys", "SHIFT + BEAT ▶ (TAP), any pad")).toBe("Tap every beat (SHIFT + BEAT ▶, any pad or Space)");
    expect(inputWording("Tap every beat (Space)", "keys", "SHIFT + BEAT ▶ (TAP)")).toBe("Tap every beat (SHIFT + BEAT ▶ or Space)");
    expect(inputWording("Press X to play", "keys", "any pad")).toBe("Press X to play");
  });
});
