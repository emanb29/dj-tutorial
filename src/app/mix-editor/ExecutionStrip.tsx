// "How you'd play it": the Transition's Execution plan, read-only, as a hand-by-hand timeline with
// each step labelled by its FLX4 control. The moments that raise the Complexity rating are shaded;
// pressing one lights up the keyframes that cause it. It opens on demand, from the rating chip.
import { flx4LayoutControl } from "@app/controller/flx4-keys.ts";
import type { Transition } from "@shared/mix-plan.ts";
import { positionText, ratingWord, reasonText, stepLabel } from "./editor-text.ts";
import type { ExecutionPlan, Hand, SetUpItem } from "./execution-plan.ts";

const HANDS: readonly { readonly hand: Hand; readonly label: string }[] = [
  { hand: "left", label: "Left hand" },
  { hand: "right", label: "Right hand" },
];

function setUpText(item: SetUpItem): string {
  const { name } = flx4LayoutControl(item.control);
  if (typeof item.value === "boolean") return `${name} ${item.value ? "on" : "off"}`;
  if (item.control === "crossfader") return `${name} ${item.value === 0.5 ? "centre" : item.value < 0.5 ? "to A" : "to B"}`;
  if (item.control.endsWith("tempo")) return `${name} ${item.value.toFixed(1)} BPM`;
  return `${name} ${String(Math.round(item.value * 100) / 100)}`;
}

export function ExecutionStrip({
  transition,
  execution,
  onHighlight,
}: {
  readonly transition: Transition;
  readonly execution: ExecutionPlan;
  readonly onHighlight: (lanes: readonly number[]) => void;
}) {
  const length = Math.max(1, transition.lengthBeats);
  const at = (beat: number) => `${String(Math.min(100, Math.max(0, (beat / length) * 100)))}%`;
  const { complexity } = execution;
  return (
    <section className="me-strip" aria-label="How you'd play it">
      <h3>
        How you'd play it · {complexity.rating} of 5, {ratingWord(complexity.rating)}
      </h3>
      <p className="me-caption">Set up: {execution.setUp.map(setUpText).join(" · ")}</p>
      <div className="me-strip-rows">
        {HANDS.map(({ hand, label }) => (
          <div key={hand} className="me-strip-row">
            <span className="me-strip-hand">{label}</span>
            <div className="me-strip-track" role="list" aria-label={label}>
              {complexity.reasons.map((reason, index) => (
                <span key={`r${String(index)}`} className="me-strip-shade" style={{ left: at(reason.beat), width: at(1) }} aria-hidden="true" />
              ))}
              {execution.steps
                .filter((step) => step.hand === hand)
                .map((step, index) => (
                  <span
                    key={index}
                    role="listitem"
                    className="me-strip-step"
                    style={{ left: at(step.startBeat), width: step.endBeat > step.startBeat ? at(step.endBeat - step.startBeat) : undefined }}
                    title={`${stepLabel(step)} at ${positionText(transition, step.startBeat)}`}
                  >
                    {stepLabel(step)}
                  </span>
                ))}
            </div>
          </div>
        ))}
      </div>
      {complexity.reasons.length === 0 ? (
        <p className="me-caption">Nothing here makes it hard.</p>
      ) : (
        <ul className="me-reasons" aria-label="What makes it hard">
          {complexity.reasons.map((reason, index) => (
            <li key={index}>
              <button
                type="button"
                className="btn btn-quiet me-reason"
                onClick={() => {
                  onHighlight(reason.lanes);
                }}
              >
                {reasonText(reason, transition)} <span className="me-caption">+{reason.points}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The quiet chip: 1–5 dots and a word. */
export function RatingChip({ rating, onClick, expanded }: { readonly rating: ExecutionPlan["complexity"]["rating"]; readonly onClick?: () => void; readonly expanded?: boolean }) {
  const dots = "●".repeat(rating) + "○".repeat(5 - rating);
  const body = (
    <>
      <span aria-hidden="true" className="me-dots">
        {dots}
      </span>{" "}
      {ratingWord(rating)}
    </>
  );
  const label = `Complexity rating ${String(rating)} of 5, ${ratingWord(rating)}`;
  return onClick === undefined ? (
    <span className={`me-chip me-chip-${String(rating)}`} aria-label={label} role="img">
      {body}
    </span>
  ) : (
    <button type="button" className={`me-chip me-chip-${String(rating)}`} aria-label={`${label}: why`} aria-expanded={expanded} onClick={onClick}>
      {body}
    </button>
  );
}
