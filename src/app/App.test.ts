import { describe, expect, it } from "vitest";
import { playgroundEnabled } from "./App.tsx";

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
