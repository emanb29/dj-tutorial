// What every control on the virtual controller reads: the input session, the frame loop, the latest
// meter frames, and the teaching layer (locks, pulse, captions, key hints).

import { createContext, use, useSyncExternalStore } from "react";
import type { MeterBus } from "@audio";
import type { ControlId } from "./control-ids.ts";
import type { FrameLoop } from "./frame-loop.ts";
import type { ControllerEngine, ControllerSession, ControllerSnapshot } from "./session.ts";

/** One line of text shown next to a control. Captions, not prose: keep it to a few words. */
export interface ControllerCaption {
  readonly control: ControlId;
  readonly text: string;
}

/** Latest sample peak per bus, written by meter events and read by meter drawers. Never React state. */
export type MeterLevels = Map<MeterBus, number>;

export interface ControllerContextValue {
  readonly session: ControllerSession;
  readonly engine: ControllerEngine;
  readonly frames: FrameLoop;
  readonly meters: MeterLevels;
  readonly pulse: ControlId | null;
  readonly captions: ReadonlyMap<ControlId, string>;
  readonly unlocks: ReadonlySet<ControlId>;
  readonly legendOpen: boolean;
}

export const ControllerContext = createContext<ControllerContextValue | null>(null);

export function useController(): ControllerContextValue {
  const value = use(ControllerContext);
  if (value === null) throw new Error("A controller part was rendered outside <Controller>; render it inside one.");
  return value;
}

/** Subscribes to one value derived from the session snapshot; re-renders only when it changes. */
export function useSessionValue<T>(select: (snapshot: ControllerSnapshot) => T): T {
  const { session } = useController();
  return useSyncExternalStore(session.subscribe, () => select(session.snapshot()));
}
