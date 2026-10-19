// Soft takeover (pickup) for absolute hardware controls. A physical fader or knob that sits somewhere
// else than the app's value must never make the value jump: its moves are ignored until it reaches the
// value (within PICKUP_TOLERANCE, or by passing through it between two messages), and from then on it
// drives the value. When something else moves the value (the screen, a Lesson setting up a deck), the
// hardware lets go and has to pick it up again. Values here are 0…1 along the control's travel.

/** How close (fraction of travel) the hardware must come to the value to pick it up: about 1 mm of a fader. */
export const PICKUP_TOLERANCE = 0.02;

export type TakeoverMove = { readonly kind: "send"; readonly value: number } | { readonly kind: "waiting"; readonly hardware: number };

export interface TakeoverStatus {
  readonly caught: boolean;
  /** Where the hardware was last seen, null until it has moved. */
  readonly hardware: number | null;
}

interface ControlState {
  hardware: number;
  /** The value last sent while caught; null while waiting. */
  sent: number | null;
}

export class SoftTakeover {
  private readonly controls = new Map<string, ControlState>();

  /** A hardware move to `hardware`, with the app's value now `appValue`. */
  move(control: string, hardware: number, appValue: number): TakeoverMove {
    const state = this.controls.get(control);
    const previous = state?.hardware ?? null;
    const caught =
      (state !== undefined && this.stillCaught(state, appValue)) ||
      Math.abs(hardware - appValue) <= PICKUP_TOLERANCE ||
      // The hardware was already at the value (a set-up adopted where it is): a quick move keeps it.
      (previous !== null && Math.abs(previous - appValue) <= PICKUP_TOLERANCE) ||
      (previous !== null && Math.sign(previous - appValue) !== Math.sign(hardware - appValue));
    this.controls.set(control, { hardware, sent: caught ? hardware : null });
    return caught ? { kind: "send", value: hardware } : { kind: "waiting", hardware };
  }

  /** Whether the hardware drives the value now that it is `appValue`, and where the hardware is. */
  status(control: string, appValue: number): TakeoverStatus {
    const state = this.controls.get(control);
    if (state === undefined) return { caught: false, hardware: null };
    return { caught: this.stillCaught(state, appValue) || Math.abs(state.hardware - appValue) <= PICKUP_TOLERANCE, hardware: state.hardware };
  }

  /**
   * Where the hardware is, without driving the value: a locked control moved, or a position known from
   * before this takeover started. The hardware has to pick the value up as usual.
   */
  observe(control: string, hardware: number): void {
    this.controls.set(control, { hardware, sent: null });
  }

  reset(): void {
    this.controls.clear();
  }

  private stillCaught(state: ControlState, appValue: number): boolean {
    return state.sent !== null && Math.abs(state.sent - appValue) <= PICKUP_TOLERANCE;
  }
}
