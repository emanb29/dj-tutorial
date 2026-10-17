import type { CSSProperties, ReactNode } from "react";
import { continuousSpec, type ContinuousControlId } from "./gestures.ts";
import { ControlFrame, type CaptionSide } from "./ControlFrame.tsx";
import { useContinuousControl, type DragAxis } from "./use-continuous.ts";

/** A channel fader, tempo fader or crossfader. The whole track is the hit area; grabbing never jumps. */
export function Fader({
  id,
  label,
  axis,
  className,
  keyHint = null,
  captionSide,
  marks,
}: {
  readonly id: ContinuousControlId;
  readonly label: string;
  readonly axis: DragAxis;
  readonly className?: string;
  readonly keyHint?: string | null;
  readonly captionSide?: CaptionSide;
  readonly marks?: ReactNode;
}) {
  const { value, target, handlers } = useContinuousControl(id, axis);
  const spec = continuousSpec(id);
  const fraction = (value - spec.min) / (spec.max - spec.min);
  // Position along the track from the bottom (vertical) or left (horizontal), 0…1.
  const along = spec.inverted ? 1 - fraction : fraction;
  const thumbStyle = { "--along": String(along) } as CSSProperties;
  return (
    <ControlFrame
      id={id}
      label={label}
      className={`fader fader-${axis}${className === undefined ? "" : ` ${className}`}`}
      keyHint={keyHint}
      {...(captionSide === undefined ? {} : { captionSide })}
    >
      <div
        ref={target}
        className="fader-hit"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-orientation={axis}
        aria-valuemin={spec.min}
        aria-valuemax={spec.max}
        aria-valuenow={Number(value.toFixed(3))}
        title={`${label}: drag, scroll, or use arrow keys. Shift for fine. Double-click resets.`}
        {...handlers}
      >
        <div className="fader-track">{marks}</div>
        <div className="fader-thumb" style={thumbStyle} />
      </div>
    </ControlFrame>
  );
}
