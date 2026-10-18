import { describe, expect, it } from "vitest";
import { containerOf, fileExtensionOf, pickRecordingFormat } from "./master-recording.ts";

describe("the master recording's format", () => {
  it("prefers AAC in MP4, then Opus in Ogg, then Opus in WebM", () => {
    expect(pickRecordingFormat(() => true)).toBe("audio/mp4;codecs=mp4a.40.2");
    expect(pickRecordingFormat((type) => type.startsWith("audio/webm"))).toBe("audio/webm;codecs=opus");
    expect(pickRecordingFormat((type) => type === "audio/ogg;codecs=opus")).toBe("audio/ogg;codecs=opus");
    expect(pickRecordingFormat(() => false)).toBeNull();
  });

  it("names the container and the file extension", () => {
    expect(containerOf("audio/webm;codecs=opus")).toBe("audio/webm");
    expect(containerOf("video/webm")).toBeNull();
    expect(fileExtensionOf("audio/mp4")).toBe("m4a");
    expect(fileExtensionOf("audio/ogg;codecs=opus")).toBe("ogg");
    expect(fileExtensionOf("audio/webm")).toBe("webm");
  });
});
