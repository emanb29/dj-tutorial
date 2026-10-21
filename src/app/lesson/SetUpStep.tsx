// "Match your controller": the DDJ-FLX4's faders and knobs a set-up needs, each ticked off live as the
// hardware gets there (hardware-sync.ts). The Lesson, practice or Check starts once all have, or on Skip.
// A set-up step of the Lesson's own ("Set up: CUE 🎧 B on, fader B up") shows its caption above the
// items. It goes on by itself once all have ticked and everything the caption asks is done ("All set"),
// where deck A's looped phrase comes round; R goes at once, Skip goes without the rest.
import { useSyncExternalStore } from "react";
import { KeyHint } from "../controller/KeyHint.tsx";
import { matchLine } from "./hardware-sync.ts";
import type { LessonSession } from "./lesson-session.ts";

const NO_SESSION = () => () => undefined;

/** The set-up step's own caption showing now ("Set up: …", then "All set: …"), or null for none. */
export function useSetUpCaption(session: LessonSession | null): string | null {
  return useSyncExternalStore(session?.subscribeSetUp ?? NO_SESSION, () => session?.setUpPending()?.caption ?? null);
}

export function SetUpStep({ session }: { readonly session: LessonSession }) {
  const pending = useSyncExternalStore(session.subscribeSetUp, () => session.setUpPending());
  // A set-up step with nothing to match shows only its caption, in the Lesson's caption line.
  if (pending === null || pending.items.length === 0) return null;
  return (
    <section className="set-up-step lesson-overlay" aria-label="Match your controller" data-nav-start>
      <h2>Match your controller</h2>
      {pending.caption === null ? null : (
        <p className="set-up-caption">
          {pending.caption}
          <span className="lesson-hint">
            All ticked: Ready <KeyHint k="R" /> goes at once
          </span>
        </p>
      )}
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
