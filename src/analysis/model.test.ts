import { describe, expect, it } from "vitest";
import { checkModelBytes, chooseThreadCount, MODEL_MISSING_FIX } from "./model.ts";

describe("WASM thread count", () => {
  it("uses 4 threads on an 8-thread machine when cross-origin isolated", () => {
    expect(chooseThreadCount({ crossOriginIsolated: true, hardwareConcurrency: 8 })).toEqual({ threads: 4, warning: null });
  });

  it("uses half the hardware threads on smaller machines, and at least one", () => {
    expect(chooseThreadCount({ crossOriginIsolated: true, hardwareConcurrency: 4 }).threads).toBe(2);
    expect(chooseThreadCount({ crossOriginIsolated: true, hardwareConcurrency: 1 }).threads).toBe(1);
  });

  it("falls back to 1 thread with a warning when the page is not cross-origin isolated", () => {
    const choice = chooseThreadCount({ crossOriginIsolated: false, hardwareConcurrency: 8 });
    expect(choice.threads).toBe(1);
    expect(choice.warning?.kind).toBe("single-thread");
  });
});

describe("model file check", () => {
  const bytesOf = (text: string) => new TextEncoder().encode(text).buffer;

  it("treats an HTML page (a dev server's fallback for a missing file) as a missing model, with the fix", async () => {
    expect(await checkModelBytes(bytesOf("<!doctype html><html></html>"), "/models/m.onnx")).toEqual({
      kind: "model-missing",
      modelUrl: "/models/m.onnx",
      fix: MODEL_MISSING_FIX,
    });
  });

  it("rejects a different model file, naming the expected hash", async () => {
    const problem = await checkModelBytes(bytesOf("\u0008\u0007not the model"), "/models/m.onnx");
    expect(problem?.kind).toBe("model-failed");
    expect(problem?.kind === "model-failed" && problem.message).toContain("87231a9f");
  });
});
