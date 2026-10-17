// The virtual controller: a DDJ-FLX4-style layout that drives the audio engine's command API.

export { Controller } from "./Controller.tsx";
export type { ControllerProps } from "./Controller.tsx";
export type { ControllerCaption } from "./context.tsx";
export { ALL_CONTROL_IDS, deckControl, isControlId, parseControlIds } from "./control-ids.ts";
export type { ControlId, ControllerUnlocks, DeckControlId, DeckPart, SharedControlId } from "./control-ids.ts";
export { KEY_BINDINGS } from "./keymap.ts";
export type { KeyAction, KeyBinding } from "./keymap.ts";
export type { ControllerEngine } from "./session.ts";
export { inputWording, useWording } from "./wording.ts";
export type { Wording } from "./wording.ts";
