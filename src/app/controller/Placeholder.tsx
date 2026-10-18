// A part of the DDJ-FLX4 the app does not use yet (MIC LEVEL, SMART CFX, the other pad modes, CUE/LOOP
// CALL, …), drawn in its place so the screen reads like the hardware. Always dimmed and inert, and
// hidden from assistive technology: there is nothing to do with it. No control id: no Lesson unlocks it.

import type { ReactNode } from "react";

const NOT_YET = "On the FLX4, not used in the app yet";

export function PlaceholderButton({
  label,
  topLabel,
  shiftLabel,
  shape = "small",
  className,
}: {
  readonly label: ReactNode;
  readonly topLabel?: ReactNode;
  readonly shiftLabel?: ReactNode;
  readonly shape?: "small" | "round" | "pad-mode";
  readonly className?: string;
}) {
  return (
    <div className={`placeholder button-${shape}${className === undefined ? "" : ` ${className}`}`} aria-hidden="true" title={NOT_YET}>
      {topLabel === undefined ? null : <span className="top-label">{topLabel}</span>}
      <span className="hw-button">{label}</span>
      {shiftLabel === undefined ? null : <span className="shift-label">{shiftLabel}</span>}
    </div>
  );
}

export function PlaceholderKnob({ label, className }: { readonly label: string; readonly className?: string }) {
  return (
    <div className={`placeholder knob${className === undefined ? "" : ` ${className}`}`} aria-hidden="true" title={NOT_YET}>
      <span className="knob-hit">
        <span className="knob-cap" style={{ transform: "rotate(-135deg)" }}>
          <span className="knob-pointer" />
        </span>
      </span>
      <span className="control-label">{label}</span>
    </div>
  );
}
