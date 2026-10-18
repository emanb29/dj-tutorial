// The centre mixer: per channel TRIM, HI/MID/LOW, the CFX filter knob, headphone CUE, a level meter and
// the channel fader; in the middle MASTER level with its meter, and the headphone MIXING and LEVEL knobs;
// the crossfader across the bottom.

import type { DeckId } from "@audio";
import { deckControl } from "./control-ids.ts";
import { useController, useSessionValue } from "./context.tsx";
import { ControlButton } from "./ControlButton.tsx";
import { LevelMeter } from "./displays.tsx";
import { Fader } from "./Fader.tsx";
import { keyHintFor } from "./keymap.ts";
import { Knob } from "./Knob.tsx";

function HeadphoneIcon() {
  return (
    <svg className="headphone-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path d="M2 10V8a6 6 0 0 1 12 0v2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <rect x="1.5" y="9" width="3" height="5" rx="1" fill="currentColor" />
      <rect x="11.5" y="9" width="3" height="5" rx="1" fill="currentColor" />
    </svg>
  );
}

function ChannelStrip({ deck }: { readonly deck: DeckId }) {
  const { session } = useController();
  const cueOn = useSessionValue((snapshot) => snapshot.mixer.channels[deck].cue);
  const side = deck === "A" ? "left" : "right";
  return (
    <div className={`channel channel-${deck}`} aria-label={`Channel ${deck}`} role="group">
      <Knob id={`${deck}.trim`} label="TRIM" captionSide={side} />
      <Knob id={`${deck}.eq-high`} label="HI" captionSide={side} />
      <Knob id={`${deck}.eq-mid`} label="MID" captionSide={side} />
      <Knob id={`${deck}.eq-low`} label="LOW" captionSide={side} />
      <Knob id={`${deck}.filter`} label="CFX" captionSide={side} title="CFX filter: left low-pass, right high-pass. Double-click to centre." />
      <ControlButton
        id={deckControl(deck, "headphone-cue")}
        label={
          <>
            <HeadphoneIcon /> CUE
          </>
        }
        ariaLabel={`Channel ${deck} headphone cue`}
        shape="small"
        lit={cueOn}
        captionSide={side}
        onPress={(input) => {
          session.toggle(deck, "headphone-cue", input);
        }}
      />
      <div className="fader-and-meter">
        <LevelMeter id={deckControl(deck, "level-meter")} bus={deck} label={deck} />
        <Fader id={`${deck}.channel-fader`} label={`CH ${deck}`} axis="vertical" className="channel-fader" keyHint={keyHintFor(deckControl(deck, "channel-fader"))} captionSide={side} />
      </div>
    </div>
  );
}

export function Mixer({ outputLine = null }: { readonly outputLine?: string | null }) {
  return (
    <section className="mixer" aria-label="Mixer">
      <div className="mixer-channels">
        <ChannelStrip deck="A" />
        <div className="mixer-centre">
          <Knob id="master-level" label="MASTER" />
          <LevelMeter id="master-meter" bus="master" label="MASTER" />
          <div className="headphones-group">
            <span className="group-label">HEADPHONES</span>
            <Knob id="cue-mix" label="MIXING" size="small" title="MIXING: left is the cued channels, right is the master." />
            <Knob id="headphone-level" label="LEVEL" size="small" title="Headphone LEVEL: how loud your headphone ear is." />
            {outputLine === null ? null : (
              <span className="output-line" data-testid="output-line">
                {outputLine}
              </span>
            )}
          </div>
        </div>
        <ChannelStrip deck="B" />
      </div>
      <Fader id="crossfader" label="CROSSFADER" axis="horizontal" className="crossfader" keyHint={keyHintFor("crossfader")} captionSide="above" />
    </section>
  );
}
