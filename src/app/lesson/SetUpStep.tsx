// "Match your controller": the DDJ-FLX4's faders and knobs a set-up needs, each ticked off live as the
// hardware gets there (hardware-sync.ts). The Lesson, practice or Check starts once all have, or on Skip.
// A set-up step of the Lesson's own ("Set up: … — then R") shows its caption above the items, and goes
// on with R once all have ticked, or on Skip.
import { useSyncExternalStore } from "react";
import { matchLine } from "./hardware-sync.ts";
import type { LessonSession } from "./lesson-session.ts";

export function SetUpStep({ session }: { readonly session: LessonSession }) {
  const pending = useSyncExternalStore(session.subscribeSetUp, () => session.setUpPending());
  // A set-up step with nothing to match shows only its caption, in the Lesson's caption line.
  if (pending === null || pending.items.length === 0) return null;
  return (
    <section className="set-up-step lesson-overlay" aria-label="Match your controller">
      <h2>Match your controller</h2>
      {pending.caption === null ? null : <p className="set-up-caption">{pending.caption}</p>}
      <ul>
        {pending.items.map((item) => (
          <li key={item.key} data-state={item.state}>
            <span className="set-up-tick" aria-hidden="true">
              {item.state === "matched" ? "✓" : "○"}
            </span>
            <span>{matchLine(item)}</span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="btn btn-quiet set-up-skip"
        onClick={() => {
          session.skipSetUp();
        }}
      >
        Skip
      </button>
    </section>
  );
}
