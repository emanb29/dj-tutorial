// A hardware-style button. It acts on pointerdown, not click, so the recorded time is when the finger
// landed; `onRelease` gets the matching pointerup. Keyboard activation (Enter/Space on a focused button)
// arrives as a click with detail 0 and is treated as a press and release.

import type { MouseEvent, PointerEvent, ReactNode } from "react";
import type { CommandInput } from "@audio";
import type { ControlId } from "./control-ids.ts";
import { useController } from "./context.tsx";
import { ControlFrame, type CaptionSide } from "./ControlFrame.tsx";

export interface ControlButtonProps {
  readonly id: ControlId;
  readonly label: ReactNode;
  readonly ariaLabel: string;
  readonly lit?: boolean;
  readonly shape?: "round" | "pill" | "pad" | "small";
  readonly tone?: "play" | "cue" | "plain";
  readonly keyHint?: string | null;
  readonly captionSide?: CaptionSide;
  readonly onPress: (input: CommandInput) => void;
  readonly onRelease?: (input: CommandInput) => void;
}

/**
 * Controller parts do not take focus when clicked, so the deck keys (Space for tap, and so on) keep
 * working after a click instead of activating the clicked control. Tab still focuses them.
 */
export function keepFocusWhereItIs(event: MouseEvent): void {
  event.preventDefault();
}

export function ControlButton({ id, label, ariaLabel, lit: litNow = false, shape = "pill", tone = "plain", keyHint = null, captionSide, onPress, onRelease }: ControlButtonProps) {
  const { session, concealed } = useController();
  const lit = litNow && !concealed.has(id);
  const input = (event: PointerEvent | MouseEvent, device = session.devices.fromPointer("mouse")): CommandInput => ({
    device,
    eventTimeMs: event.timeStamp,
  });
  return (
    <ControlFrame id={id} className={`button-frame button-${shape}`} keyHint={keyHint} {...(captionSide === undefined ? {} : { captionSide })}>
      <button
        type="button"
        className={`hw-button tone-${tone}${lit ? " lit" : ""}`}
        aria-label={ariaLabel}
        aria-pressed={lit}
        // Clicking does not take focus, so Space and Enter keep their deck meanings afterwards
        // (Tab still focuses the button for keyboard use).
        onMouseDown={keepFocusWhereItIs}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          onPress(input(event, session.devices.fromPointer(event.pointerType)));
        }}
        onPointerUp={(event) => {
          if (event.button === 0) onRelease?.(input(event, session.devices.fromPointer(event.pointerType)));
        }}
        onPointerCancel={(event) => onRelease?.(input(event, session.devices.fromPointer(event.pointerType)))}
        onClick={(event) => {
          if (event.detail !== 0) return;
          onPress({ device: "keyboard", eventTimeMs: event.timeStamp });
          onRelease?.({ device: "keyboard", eventTimeMs: event.timeStamp });
        }}
      >
        {label}
      </button>
    </ControlFrame>
  );
}
