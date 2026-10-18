// Soft takeover on screen: while a hardware fader or knob has not picked up the app's value, a hollow
// mark shows where the physical control is, so the Learner sees which way to move it to catch the value.

import type { CSSProperties } from "react";
import { useSessionValue } from "./context.tsx";
import { continuousSpec, type ContinuousControlId } from "./gestures.ts";

export function PickupMark({ id }: { readonly id: ContinuousControlId }) {
  const hardware = useSessionValue((snapshot) => snapshot.pickup[id] ?? null);
  if (hardware === null) return null;
  const spec = continuousSpec(id);
  const fraction = (hardware - spec.min) / (spec.max - spec.min);
  const along = spec.inverted ? 1 - fraction : fraction;
  const style = { "--along": String(along), "--angle": `${String(-135 + fraction * 270)}deg` } as CSSProperties;
  return <span className="pickup-mark" style={style} title="Where the hardware control is: move it to the value to pick it up" aria-hidden="true" data-testid={`pickup-${id}`} />;
}
