import { describe, expect, it } from "vitest";
import { DJ_GENRES, mapGenre } from "./genre.ts";

describe("mapGenre", () => {
  it("maps SoundCloud's free-text genre onto the DJ taxonomy, high when the genre names one", () => {
    expect(mapGenre("Tech House", [])).toMatchObject({ value: "tech house", band: "high", rule: "genre-exact" });
    expect(mapGenre("techhouse", [])).toMatchObject({ value: "tech house", band: "high" });
    expect(mapGenre("DnB", [])).toMatchObject({ value: "drum & bass", band: "high" });
    expect(mapGenre("Drum & Bass", [])).toMatchObject({ value: "drum & bass", band: "high" });
    expect(mapGenre("Hip-hop & Rap", [])).toMatchObject({ value: "hip-hop", band: "high" });
    expect(mapGenre("hard techno", [])).toMatchObject({ value: "hard techno", band: "high" });
    expect(mapGenre("UKG", [])).toMatchObject({ value: "uk garage", band: "high" });
  });

  it("is medium when a genre is only part of the text", () => {
    expect(mapGenre("TECH HOUSE 2024 🔥", [])).toMatchObject({ value: "tech house", band: "medium", rule: "genre-contains" });
  });

  it("looks in the tags when the genre is generic or missing, medium at best", () => {
    expect(mapGenre("Dance & EDM", ["mashup", "Techno", "festival"])).toMatchObject({ value: "techno", band: "medium", rule: "tags" });
    expect(mapGenre("", ["bass house"])).toMatchObject({ value: "bass house", band: "medium" });
  });

  it("proposes nothing when neither the genre nor a tag names a DJ genre", () => {
    expect(mapGenre("Dance & EDM", ["2022", "free download"])).toBeNull();
    expect(mapGenre("", [])).toBeNull();
  });

  it("prefers the most specific genre: bass house over house, hard techno over techno", () => {
    expect(mapGenre("Bass House", [])?.value).toBe("bass house");
    expect(mapGenre("", ["house", "bass house"])?.value).toBe("bass house");
    expect(mapGenre("Hard Techno", [])?.value).toBe("hard techno");
  });

  it("only ever proposes a genre in the taxonomy", () => {
    for (const raw of ["Techno", "dubstep", "trap", "Pop", "Deep House", "Afro House", "Trance"]) expect(DJ_GENRES).toContain(mapGenre(raw, [])?.value);
  });
});
