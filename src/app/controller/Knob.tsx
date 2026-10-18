import { continuousSpec, type ContinuousControlId } from "./gestures.ts";
import { ControlFrame, type CaptionSide } from "./ControlFrame.tsx";
import { PickupMark } from "./PickupMark.tsx";
import { useContinuousControl } from "./use-continuous.ts";

/** A rotary knob swept over 270°, dragged vertically. The hit area is larger than the cap. */
export function Knob({
  id,
  label,
  size = "medium",
  captionSide,
  title,
}: {
  readonly id: ContinuousControlId;
  readonly label: string;
  readonly size?: "small" | "medium";
  readonly captionSide?: CaptionSide;
  readonly title?: string;
}) {
  const { value, target, handlers } = useContinuousControl(id, "vertical");
  const spec = continuousSpec(id);
  const fraction = (value - spec.min) / (spec.max - spec.min);
  const angle = -135 + fraction * 270;
  const centred = spec.resetValue !== spec.min;
  return (
    <ControlFrame id={id} label={label} className={`knob knob-${size}`} {...(captionSide === undefined ? {} : { captionSide })}>
      <div
        ref={target}
        className="knob-hit"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={spec.min}
        aria-valuemax={spec.max}
        aria-valuenow={Number(value.toFixed(3))}
        title={title ?? `${label}: drag up or down, scroll, or use arrow keys. Shift for fine. Double-click resets.`}
        {...handlers}
      >
        <div className={`knob-cap${centred && value === spec.resetValue ? " at-rest" : ""}`} style={{ transform: `rotate(${String(angle)}deg)` }}>
          <span className="knob-pointer" />
        </div>
        <PickupMark id={id} />
      </div>
    </ControlFrame>
  );
}
