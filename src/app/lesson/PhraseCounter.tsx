// The phrases hook and practice's live 8-bar count in the caption line: "bar 3 of 8" with 8 dots
// filling, lit with "new phrase!" on each phrase's first bar. It steps aside ("now by ear") once the
// Learner taps phrases right without it, and comes back after misses (phrase-count.ts). Drawn on
// animation frames, never React state; hidden from screen readers, as it changes every bar.
import { useEffect, useRef } from "react";
import type { LessonSession } from "./lesson-session.ts";

const BARS_PER_PHRASE = 8;
const BARS = Array.from({ length: BARS_PER_PHRASE }, (_, index) => index + 1);

/** The count's words: the bar, a phrase start, or none while the Learner counts by ear. */
export function phraseCountText(count: { readonly bar: number; readonly shown: boolean } | null): string {
  if (count === null) return "";
  if (!count.shown) return "now by ear";
  return count.bar === 1 ? "bar 1 of 8 · new phrase!" : `bar ${String(count.bar)} of ${String(BARS_PER_PHRASE)}`;
}

export function PhraseCounter({ session }: { readonly session: LessonSession }) {
  const root = useRef<HTMLSpanElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const dots = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let frame = requestAnimationFrame(function draw() {
      const node = root.current;
      const words = text.current;
      if (node !== null && words !== null) {
        const count = session.phraseCount();
        const next = phraseCountText(count);
        if (words.textContent !== next) words.textContent = next;
        const set = (key: string, value: string) => {
          if (node.dataset[key] !== value) node.dataset[key] = value;
        };
        set("bar", String(count?.bar ?? 0));
        set("shown", String(count?.shown ?? false));
        set("playing", String(count !== null));
        // Bars so far in this phrase: the dots fill up to the bar heard now.
        for (const dot of dots.current?.children ?? []) {
          if (!(dot instanceof HTMLElement)) continue;
          const on = String(count !== null && Number(dot.dataset["dot"]) <= count.bar);
          if (dot.dataset["on"] !== on) dot.dataset["on"] = on;
        }
      }
      frame = requestAnimationFrame(draw);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [session]);

  return (
    <span ref={root} className="phrase-count" data-testid="phrase-count" data-bar="0" data-shown="true" data-playing="false" aria-hidden="true">
      <span ref={text} className="phrase-count-text" />
      <span ref={dots} className="phrase-count-dots">
        {BARS.map((bar) => (
          <span key={bar} data-dot={bar} data-on="false" />
        ))}
      </span>
    </span>
  );
}
