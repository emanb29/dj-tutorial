import { describe, expect, it } from "vitest";
import { classifyWheel, InputDeviceDetector } from "./input-device.ts";

const PIXELS = 0;
const LINES = 1;

describe("classifyWheel", () => {
  it("reads a two-finger sideways scroll as a trackpad", () => {
    expect(classifyWheel({ deltaX: 3, deltaY: 1, deltaMode: PIXELS })).toBe("trackpad");
  });

  it("reads small fractional pixel steps as a trackpad", () => {
    expect(classifyWheel({ deltaX: 0, deltaY: 2.5, deltaMode: PIXELS })).toBe("trackpad");
  });

  it("reads line-mode scrolling as a mouse wheel", () => {
    expect(classifyWheel({ deltaX: 0, deltaY: 3, deltaMode: LINES })).toBe("mouse");
  });

  it("reads a large whole-pixel notch with no sideways part as a mouse wheel", () => {
    expect(classifyWheel({ deltaX: 0, deltaY: -100, deltaMode: PIXELS })).toBe("mouse");
    expect(classifyWheel({ deltaX: 0, deltaY: 120, deltaMode: PIXELS })).toBe("mouse");
  });

  it("leaves small whole-pixel vertical steps undecided", () => {
    expect(classifyWheel({ deltaX: 0, deltaY: 8, deltaMode: PIXELS })).toBe("unknown");
  });
});

describe("InputDeviceDetector", () => {
  it("maps touch and pen pointers to touch", () => {
    const detector = new InputDeviceDetector({ macPlatform: false });
    expect(detector.fromPointer("touch")).toBe("touch");
    expect(detector.fromPointer("pen")).toBe("touch");
  });

  it("assumes a mouse pointer is a mouse off a laptop platform", () => {
    expect(new InputDeviceDetector({ macPlatform: false }).fromPointer("mouse")).toBe("mouse");
  });

  it("assumes a mouse pointer is a trackpad on a Mac laptop until a mouse wheel is seen", () => {
    const detector = new InputDeviceDetector({ macPlatform: true });
    expect(detector.fromPointer("mouse")).toBe("trackpad");
    detector.observeWheel({ deltaX: 0, deltaY: 100, deltaMode: PIXELS });
    expect(detector.fromPointer("mouse")).toBe("mouse");
  });

  it("switches a mouse pointer to trackpad once trackpad scrolling is seen", () => {
    const detector = new InputDeviceDetector({ macPlatform: false });
    detector.observeWheel({ deltaX: 2, deltaY: 1.5, deltaMode: PIXELS });
    expect(detector.fromPointer("mouse")).toBe("trackpad");
  });

  it("keeps the last decided evidence when a wheel event is undecided", () => {
    const detector = new InputDeviceDetector({ macPlatform: false });
    detector.observeWheel({ deltaX: 2, deltaY: 1.5, deltaMode: PIXELS });
    expect(detector.observeWheel({ deltaX: 0, deltaY: 8, deltaMode: PIXELS })).toBe("trackpad");
  });

  it("treats an unknown pointer type like a mouse", () => {
    expect(new InputDeviceDetector({ macPlatform: false }).fromPointer("")).toBe("mouse");
  });
});
