// The teaching layer around every control: locked controls are dimmed and inert (no padlock), the next
// control to touch pulses gently, a newly unlocked control plays a small reward, and a one-line caption
// can sit beside it. Nothing here forces an order: any unlocked control works at any time.

import { useEffect, useRef, type ReactNode } from "react";
import type { ControlId } from "./control-ids.ts";
import { useController, useSessionValue } from "./context.tsx";

export type CaptionSide = "above" | "below" | "left" | "right";

interface ControlFrameProps {
  readonly id: ControlId;
  /**
   * Other control ids this part stands for (the FLX4 puts several on one button: BEAT SYNC is also
   * MASTER TEMPO when held and TEMPO RANGE with SHIFT). The part is unlocked when any of them is, and
   * shows their pulse and caption.
   */
  readonly also?: readonly ControlId[];
  readonly label?: string;
  readonly className?: string;
  /** Key cap shown while the key legend is open. */
  readonly keyHint?: string | null;
  readonly captionSide?: CaptionSide;
  readonly children: ReactNode;
}

const UNLOCK_CLASS = "just-unlocked";
const NONE: readonly ControlId[] = [];

export function ControlFrame({ id, also = NONE, label, className, keyHint = null, captionSide = "below", children }: ControlFrameProps) {
  const { unlocks, concealed, pulse, captions, legendOpen } = useController();
  const ids = also.length === 0 ? [id] : [id, ...also];
  const locked = ids.every((each) => !unlocks.has(each));
  // Concealed for now: drawn and held as locked, but coming back is no unlock to reward.
  const held = ids.every((each) => !unlocks.has(each) || concealed.has(each));
  // A part standing for several controls (BEAT SYNC: also Master Tempo) can be open while its own is not.
  const ownHeld = !unlocks.has(id) || concealed.has(id);
  const element = useRef<HTMLDivElement>(null);
  const wasLocked = useRef(locked);

  useEffect(() => {
    const node = element.current;
    const unlockedNow = wasLocked.current && !locked;
    wasLocked.current = locked;
    if (node === null || !unlockedNow) return;
    node.classList.add(UNLOCK_CLASS);
    const done = () => {
      node.classList.remove(UNLOCK_CLASS);
    };
    node.addEventListener("animationend", done, { once: true });
    return () => {
      node.removeEventListener("animationend", done);
      done();
    };
  }, [locked]);

  // On a phone the controller is taller than the screen: bring the control to touch next into view.
  // "nearest" leaves a control that is already on screen where it is, so a desktop never scrolls.
  const pulsing = pulse !== null && ids.includes(pulse) && !held;
  useEffect(() => {
    if (!pulsing) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.current?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
  }, [pulsing]);

  // A locked control touched on the hardware controller: a brief "not yet" on its screen twin.
  const notYet = useSessionValue((snapshot) => snapshot.notYet !== null && ids.includes(snapshot.notYet));
  const caption = ids.map((each) => captions.get(each)).find((text) => text !== undefined);
  const classes = ["control", className, held ? "locked" : null, pulsing ? "pulse" : null].filter(Boolean).join(" ");
  return (
    <div ref={element} className={classes} data-control={id} data-locked={held} {...(also.length === 0 ? {} : { "data-own-locked": ownHeld })} inert={held} aria-disabled={held || undefined}>
      {children}
      {label === undefined ? null : <span className="control-label">{label}</span>}
      {legendOpen && keyHint !== null && !held ? (
        <kbd className="key-hint" aria-hidden="true">
          {keyHint}
        </kbd>
      ) : null}
      {notYet ? (
        <span className="not-yet" role="status">
          Not yet
        </span>
      ) : null}
      {caption === undefined ? null : (
        <span className={`caption caption-${captionSide}`} role="note">
          {caption}
        </span>
      )}
    </div>
  );
}
