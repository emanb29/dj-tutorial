// The one-time headphones check (headphones-check.ts): "headphones on?", then a click in one ear at a
// time, "which ear?". It catches OS mono and headphones worn the wrong way round before the first
// split-cue Lesson. Short captions, big buttons; the clicks go straight to the output, past the mixer.
import { useEffect, useReducer, useRef } from "react";
import { HEADPHONES_START, headphonesCheck, type Ear } from "./headphones-check.ts";

const CLICKS = 3;
const CLICK_SEC = 0.05;
const CLICK_GAP_SEC = 0.18;

/** Three short beeps in one ear only. */
function playEarClick(context: BaseAudioContext, ear: Ear): void {
  const merger = new ChannelMergerNode(context, { numberOfInputs: 2 });
  const level = new GainNode(context, { gain: 0 });
  const tone = new OscillatorNode(context, { frequency: 1000 });
  tone.connect(level).connect(merger, 0, ear === "left" ? 0 : 1);
  merger.connect(context.destination);
  const start = context.currentTime + 0.05;
  for (let click = 0; click < CLICKS; click++) {
    const at = start + click * CLICK_GAP_SEC;
    level.gain.setValueAtTime(0.3, at);
    level.gain.setValueAtTime(0, at + CLICK_SEC);
  }
  const end = start + CLICKS * CLICK_GAP_SEC;
  tone.start(start);
  tone.stop(end);
  tone.onended = () => {
    merger.disconnect();
  };
}

interface HeadphonesGateProps {
  readonly context: BaseAudioContext;
  readonly onPassed: () => void;
}

export function HeadphonesGate({ context, onPassed }: HeadphonesGateProps) {
  const [step, dispatch] = useReducer(headphonesCheck, HEADPHONES_START);
  const ear = step.kind === "ear" ? step.ear : null;

  // A click each time an ear test starts.
  useEffect(() => {
    if (ear !== null) playEarClick(context, ear);
  }, [context, ear]);

  // Once: the parent's callback may be a new function on every render.
  const reported = useRef(false);
  useEffect(() => {
    if (step.kind !== "passed" || reported.current) return;
    reported.current = true;
    onPassed();
  }, [step.kind, onPassed]);

  return (
    <section className="headphones-gate lesson-overlay" aria-label="Headphones check" data-step={step.kind} data-nav-start>
      {step.kind === "plug-in" ? (
        <>
          <h2>Headphones on</h2>
          <p>Cue in your left ear, the speakers' mix in your right.</p>
          <button type="button" className="btn btn-primary" onClick={() => {
            dispatch({ type: "plugged-in" });
          }}>
            They're on
          </button>
        </>
      ) : null}
      {step.kind === "ear" ? (
        <>
          <h2>Which ear was the click in?</h2>
          <div className="headphones-answers" role="group" aria-label="Which ear">
            {(["left", "both", "right"] as const).map((answer) => (
              <button key={answer} type="button" className="btn" onClick={() => {
                dispatch({ type: "heard", ear: answer });
              }}>
                {answer === "both" ? "Both" : answer === "left" ? "Left" : "Right"}
              </button>
            ))}
          </div>
          <button type="button" className="btn btn-quiet" onClick={() => {
            playEarClick(context, step.ear);
          }}>
            Play it again
          </button>
        </>
      ) : null}
      {step.kind === "mono" ? (
        <>
          <h2>Both ears: your computer plays mono</h2>
          <p>
            Mac: System Settings › Accessibility › Audio › turn off <em>Play stereo audio as mono</em>.
          </p>
          <button type="button" className="btn btn-primary" onClick={() => {
            dispatch({ type: "retry" });
          }}>
            Test again
          </button>
        </>
      ) : null}
      {step.kind === "swapped" ? (
        <>
          <h2>Other ear: swap them round</h2>
          <p>L on your left ear, R on your right.</p>
          <button type="button" className="btn btn-primary" onClick={() => {
            dispatch({ type: "retry" });
          }}>
            Test again
          </button>
        </>
      ) : null}
    </section>
  );
}
