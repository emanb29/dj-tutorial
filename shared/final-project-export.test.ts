import { describe, expect, it } from "vitest";
import { exportFileName, exportTags, finalProjectExportPath } from "./final-project-export.ts";

const project = {
  recordedAt: "2026-10-17T20:15:00.000Z",
  tracks: [
    { title: "Set Groove C", artist: "DJ Tutorial", bpm: 124, credit: "", shareable: true },
    { title: "Night\u0007 Drive", artist: "", bpm: 124, credit: "", shareable: true },
  ],
};

describe("the export's tags", () => {
  it("titles the set by its day, leaves the artist blank without a name, and lists the tracks", () => {
    expect(exportTags(project)).toEqual({
      title: "My first set — 2026-10-17",
      artist: "",
      comment: "DJ Tutorial – Set Groove C\nUnknown artist – Night Drive",
      date: "2026-10-17",
    });
  });

  it("uses the Learner's name as the artist", () => {
    expect(exportTags(project, " Sam \u0000").artist).toBe("Sam");
  });

  it("names the file and the route by format", () => {
    expect(exportFileName(project, "mp3")).toBe("dj-tutorial-set-2026-10-17.mp3");
    expect(finalProjectExportPath("default", "wav")).toBe("/api/learners/default/final-project/export.wav");
  });
});
