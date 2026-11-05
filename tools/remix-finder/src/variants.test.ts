import { describe, expect, it } from "vitest";
import { classifyTitle, coreTitle, isDjKind, matchVariant, namesSong, variantKey } from "./variants.ts";

const loser = { title: "Loser", artists: ["Tame Impala"] };

describe("coreTitle", () => {
  it.each([
    ["Loser", "loser"],
    ["Lose Yourself - Remastered 2011", "lose yourself"],
    ["Starboy (feat. Daft Punk)", "starboy"],
    ["Señorita", "senorita"],
    ["Tom & Jerry (Radio Edit)", "tom and jerry"],
  ])("%s → %s", (title, core) => {
    expect(coreTitle(title)).toBe(core);
  });
});

describe("classifyTitle", () => {
  it.each([
    ["Loser (Fcukers Remix)", "remix", "Fcukers"],
    ["Tame Impala - Loser (That's It 85 Remix)", "remix", "That's It 85"],
    ["Loser [Someone Bootleg]", "bootleg", "Someone"],
    ["Loser (Extended Mix)", "extended", null],
    ["loser - TAME IMPALA (REVERB + SLOWED REMIX)", "slowed", null],
    ["Loser (sped up)", "sped-up", null],
    ["Loser x Other Song (Mashup)", "mashup", null],
    ["Loser (DJ Name VIP)", "vip", "DJ Name"],
    ["Loser (DJ Name Flip)", "flip", "DJ Name"],
    ["Loser (Live at Coachella)", "live", null],
    ["Tame Impala - Loser - Adam Haans Edit", "edit", "Adam Haans"],
    ["Tame Impala - Loser - REMIX", "remix", null],
  ])("%s → %s by %s", (title, kind, remixer) => {
    expect(classifyTitle(title)).toEqual({ kind, remixer });
  });

  it.each(["Tame Impala - Loser (Official Video)", "Loser (Lyrics) remix", "Loser 8D Audio remix", "Loser (Radio Edit)", "Loser type beat remix"])(
    "%s is not a variant",
    (title) => {
      expect(classifyTitle(title)).toBeNull();
    },
  );

  it("marks listening versions apart from mixable ones", () => {
    expect(isDjKind("remix")).toBe(true);
    expect(isDjKind("slowed")).toBe(false);
  });
});

describe("namesSong", () => {
  it("needs the artist for a short title", () => {
    expect(namesSong(loser, "Loser (Fcukers Remix)", "Tame Impala")).toBe(true);
    expect(namesSong(loser, "Loser (Someone Remix)", "Someone")).toBe(false);
    expect(namesSong(loser, "Tame Impala - Loser (Someone Remix)", "Someone")).toBe(true);
  });

  it("takes a distinctive title on its own", () => {
    expect(namesSong({ title: "The Less I Know The Better", artists: ["Tame Impala"] }, "The Less I Know The Better (X Edit)", "x")).toBe(true);
  });

  it("matches whole words only", () => {
    expect(namesSong(loser, "Losers (Tame Impala Remix)", "x")).toBe(false);
    expect(namesSong(loser, "Dracula - Tame Impala (JENNIE Remix)", "ANNA")).toBe(false);
  });
});

describe("matchVariant", () => {
  it("is null for the song itself", () => {
    expect(matchVariant(loser, "Tame Impala - Loser", "Tame Impala")).toBeNull();
  });

  it("ignores a variant word the song's own title has", () => {
    const live = { title: "Live Forever", artists: ["Oasis"] };
    expect(matchVariant(live, "Oasis - Live Forever", "Oasis")).toBeNull();
    expect(matchVariant(live, "Oasis - Live Forever (Someone Remix)", "x")).toEqual({ kind: "remix", remixer: "Someone" });
  });

  it("gives the same key to one remix on two platforms", () => {
    const a = matchVariant(loser, "Loser (Fcukers Remix)", "Tame Impala");
    const b = matchVariant(loser, "Tame Impala, Fcukers - Loser (Fcukers Remix - Official Audio)", "Tame Impala");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    if (a === null || b === null) return;
    expect(variantKey(loser, a)).toBe(variantKey(loser, b));
  });
});
