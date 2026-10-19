// The compact live-feedback strip: a 4-dot beat pulse drawn on animation frames (never React state),
// the last taps as dots (early left, late right, green when within ±40 ms), and practice progress.
// During the Check the beat pulse is hidden: per-beat help there would grade the eyes, not the ears.
import { useEffect, useRef } from "react";
import type { LessonPhase } from "@lessons";
import type { LessonSession } from "./lesson-session.ts";

export interface TapMark {
  readonly offsetMs: number;
  readonly good: boolean;
}

/** Tap dots are placed on a ±100 ms scale. */
const SCALE_MS = 100;

interface FeedbackStripProps {
  readonly session: LessonSession;
  readonly taps: readonly TapMark[];
  readonly showBeat: boolean;
  readonly practice: Extract<LessonPhase, { kind: "practice" }> | null;
  /** A by-ear drill's line ("Two kicks? Nudge B"), during the hook and practice. */
  readonly line?: string | null;
  /** One more line after a miss, on how to fix it (Lesson 6: "Late? Scrub slower …"). */
  readonly hint?: string | null;
}

export function FeedbackStrip({ session, taps, showBeat, practice, line = null, hint = null }: FeedbackStripProps) {
  const pulse = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showBeat) return;
    let frame = requestAnimationFrame(function draw() {
      const clock = session.beatClock();
      const node = pulse.current;
      if (node !== null) {
        // The beat that just sounded: the next one minus one, lit for the first third of the beat.
        const sinceBeat = clock === null ? Infinity : clock.beatMs - (clock.nextBeatAtMs - performance.now());
        const current = clock === null ? 0 : ((clock.beatInBar + 2) % 4) + 1;
        node.dataset["beat"] = String(clock === null || sinceBeat > clock.beatMs / 3 ? 0 : current);
      }
      frame = requestAnimationFrame(draw);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [session, showBeat]);

  return (
    <section className="feedback-strip" aria-label="Live feedback">
      {showBeat ? (
        <div ref={pulse} className="beat-pulse" data-beat="0" aria-hidden="true">
          {[1, 2, 3, 4].map((beat) => (
            <span key={beat} className={beat === 1 ? "one" : undefined} />
          ))}
        </div>
      ) : null}
      {taps.length === 0 ? null : (
        <ol className="tap-dots" aria-label="Your last taps">
          {taps.map((tap, index) => (
            <li
              key={index}
              className={tap.good ? "good" : "off"}
              style={{ left: `${String(50 + (Math.max(-SCALE_MS, Math.min(SCALE_MS, tap.offsetMs)) / SCALE_MS) * 50)}%` }}
              title={`${tap.offsetMs > 0 ? "+" : ""}${String(Math.round(tap.offsetMs))} ms`}
            />
          ))}
        </ol>
      )}
      {line === null ? null : (
        <span className="drill-line" role="status" aria-label="Practice feedback">
          {line}
        </span>
      )}
      {hint === null ? null : (
        <span className="drill-line drill-hint" aria-label="Practice hint">
          {hint}
        </span>
      )}
      {practice === null ? null : (
        <span className="practice-reps" aria-label="Practice" data-ready={practice.ready}>
          {practice.reps.map((good, index) => (
            <span key={index} className={good ? "good" : "off"} />
          ))}
        </span>
      )}
    </section>
  );
}
