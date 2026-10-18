// Phrase previews (Lesson 3, Count phrases), on the questions and on the result card: a ▶ that plays a
// phrase of the Check again from just before it, and the bar that shows which phrase is heard now.
import { useEffect, useRef } from "react";

/** What the previews need of the Lesson session (`LessonSession` has it). */
export interface PhrasePreviewSession {
  previewPhrase(phrase: number): boolean;
  previewHeard(): { readonly phrase: number; readonly bar: number } | { readonly phrase: null } | null;
  stopPreview(): void;
}

/** ▶ for phrase `phrase`: plays from 2 bars before it, across the change into it. */
export function PhrasePlayButton({ session, phrase, label = `Play phrase ${String(phrase)}` }: { readonly session: PhrasePreviewSession; readonly phrase: number; readonly label?: string }) {
  return (
    <button
      type="button"
      className="btn phrase-chip-play"
      data-phrase={phrase}
      aria-label={label}
      onClick={() => {
        session.previewPhrase(phrase);
      }}
    >
      ▶
    </button>
  );
}

/**
 * Under the phrase chips: the one-line hint, and while a preview plays, what is heard now ("Phrase 4 ·
 * bar 3 of 8", pulsing as each phrase starts) and ■ Stop. Heard time, not applied, so the marker matches
 * the ears through output latency. Grading of the taps is over, so a position aid is fine here. Drawn
 * on animation frames, never React state. Every `.phrase-chip[data-chip]` on the page lights while its
 * phrase is heard.
 */
export function PhrasePreviewBar({ session }: { readonly session: PhrasePreviewSession }) {
  const root = useRef<HTMLDivElement>(null);
  const now = useRef<HTMLSpanElement>(null);
  const stop = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let frame = requestAnimationFrame(function draw() {
      const node = root.current;
      const words = now.current;
      if (node !== null && words !== null && stop.current !== null) {
        const heard = session.previewHeard();
        const phrase = heard?.phrase ?? null;
        const playing = String(heard !== null);
        if (node.dataset["playing"] !== playing) node.dataset["playing"] = playing;
        stop.current.hidden = heard === null;
        const text = heard === null ? "" : heard.phrase === null ? "▶ …" : `Phrase ${String(heard.phrase)} · bar ${String(heard.bar)} of 8`;
        if (words.textContent !== text) words.textContent = text;
        const heardPhrase = String(phrase ?? 0);
        if (words.dataset["phrase"] !== heardPhrase) {
          words.dataset["phrase"] = heardPhrase;
          // A brief pulse as each phrase starts.
          if (phrase !== null) words.animate([{ transform: "scale(1.25)", opacity: 0.6 }, { transform: "scale(1)", opacity: 1 }], { duration: 400, easing: "ease-out" });
        }
        // Every chip group (the breakdown's and the drop's, or the result's lines) lights the phrase heard now.
        for (const chip of document.querySelectorAll<HTMLElement>(".phrase-chip[data-chip]")) {
          const lit = String(phrase !== null && chip.dataset["chip"] === String(phrase));
          if (chip.dataset["heard"] !== lit) chip.dataset["heard"] = lit;
        }
      }
      frame = requestAnimationFrame(draw);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [session]);

  return (
    <div ref={root} className="phrase-preview-bar" data-testid="phrase-preview" data-playing="false">
      <span className="lesson-hint">▶ plays from just before that phrase — listen for the change.</span>
      <span ref={now} className="phrase-preview-now" data-testid="phrase-preview-now" data-phrase="0" aria-hidden="true" />
      <button
        ref={stop}
        type="button"
        className="btn btn-quiet phrase-preview-stop"
        hidden
        onClick={() => {
          session.stopPreview();
        }}
      >
        ■ Stop
      </button>
    </div>
  );
}
