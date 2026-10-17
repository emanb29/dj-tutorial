import { describe, expect, it } from "vitest";
import { isOriginalsPage, playgroundEnabled } from "./App.tsx";

describe("playgroundEnabled (M6)", () => {
  it("is always on at /playground on the dev server", () => {
    expect(playgroundEnabled({ pathname: "/playground", search: "" }, true)).toBe(true);
    expect(playgroundEnabled({ pathname: "/playground/", search: "" }, true)).toBe(true);
  });

  it("needs ?playground in a production build", () => {
    expect(playgroundEnabled({ pathname: "/playground", search: "" }, false)).toBe(false);
    expect(playgroundEnabled({ pathname: "/playground", search: "?playground&unlocks=A.play" }, false)).toBe(true);
  });

  it("is off on any other path", () => {
    expect(playgroundEnabled({ pathname: "/", search: "?playground" }, true)).toBe(false);
  });
});

describe("isOriginalsPage", () => {
  it("matches /originals, with or without a trailing slash, and nothing else", () => {
    expect(isOriginalsPage("/originals")).toBe(true);
    expect(isOriginalsPage("/originals/")).toBe(true);
    expect(isOriginalsPage("/originals/001")).toBe(false);
    expect(isOriginalsPage("/")).toBe(false);
  });
});
