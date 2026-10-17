// The teaching layer around every control: locked controls are dimmed and inert (no padlock), the next
// control to touch pulses gently, a newly unlocked control plays a small reward, and a one-line caption
// can sit beside it. Nothing here forces an order: any unlocked control works at any time.

import { useEffect, useRef, type ReactNode } from "react";
import type { ControlId } from "./control-ids.ts";
import { useController } from "./context.tsx";

export type CaptionSide = "above" | "below" | "left" | "right";

interface ControlFrameProps {
  readonly id: ControlId;
  readonly label?: string;
  readonly className?: string;
  /** Key cap shown while the key legend is open. */
  readonly keyHint?: string | null;
  readonly captionSide?: CaptionSide;
  readonly children: ReactNode;
}

const UNLOCK_CLASS = "just-unlocked";

export function ControlFrame({ id, label, className, keyHint = null, captionSide = "below", children }: ControlFrameProps) {
  const { unlocks, pulse, captions, legendOpen } = useController();
  const locked = !unlocks.has(id);
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
  const pulsing = pulse === id && !locked;
  useEffect(() => {
    if (!pulsing) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.current?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
  }, [pulsing]);

  const caption = captions.get(id);
  const classes = ["control", className, locked ? "locked" : null, pulsing ? "pulse" : null].filter(Boolean).join(" ");
  return (
    <div ref={element} className={classes} data-control={id} data-locked={locked} inert={locked} aria-disabled={locked || undefined}>
      {children}
      {label === undefined ? null : <span className="control-label">{label}</span>}
      {legendOpen && keyHint !== null && !locked ? (
        <kbd className="key-hint" aria-hidden="true">
          {keyHint}
        </kbd>
      ) : null}
      {caption === undefined ? null : (
        <span className={`caption caption-${captionSide}`} role="note">
          {caption}
        </span>
      )}
    </div>
  );
}
