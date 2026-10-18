// The centre mixer: per channel TRIM, HI/MID/LOW, the CFX filter knob, headphone CUE, a level meter and
// the channel fader; in the middle MASTER level with its meter, and the headphone MIXING and LEVEL knobs;
// the crossfader across the bottom. BEAT FX (ECHO) is here too, though the controller draws it in the
// display row above the mixer (the FLX4 has it at the mixer's top).

import type { DeckId } from "@audio";
import { deckControl } from "./control-ids.ts";
import { useController, useSessionValue } from "./context.tsx";
import { ControlButton, keepFocusWhereItIs } from "./ControlButton.tsx";
import { ControlFrame } from "./ControlFrame.tsx";
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

/** A beat count as the FLX4's display shows it: 1/8, 1/4, 1/2, 3/4, 1, 2, 4. */
export function beatsLabel(beats: number): string {
  const fractions: Readonly<Record<string, string>> = { "0.125": "1/8", "0.25": "1/4", "0.5": "1/2", "0.75": "3/4" };
  return fractions[String(beats)] ?? String(beats);
}

const CHANNEL_LABELS = { A: "CH 1", B: "CH 2", master: "MASTER" } as const;

/** BEAT FX, FLX4 style: the effect (ECHO), CH SELECT, BEAT ◀/▶ with its value, LEVEL/DEPTH and ON/OFF. */
export function BeatFx() {
  const { session } = useController();
  const fx = useSessionValue((snapshot) => snapshot.mixer.beatFx);
  const tappedBpm = useSessionValue((snapshot) => snapshot.mixer.beatFxBpm);
  const pointer = (event: { pointerType: string; timeStamp: number }) => ({ device: session.devices.fromPointer(event.pointerType), eventTimeMs: event.timeStamp });
  const beatButton = (step: -1 | 1) => (
    <button
      type="button"
      className="hw-button fx-beat-step"
      aria-label={step < 0 ? "Beat FX beat shorter" : "Beat FX beat longer"}
      onMouseDown={keepFocusWhereItIs}
      onPointerDown={(event) => {
        if (event.button === 0) session.beatFxBeat(step, pointer(event));
      }}
      onClick={(event) => {
        if (event.detail === 0) session.beatFxBeat(step, { device: "keyboard", eventTimeMs: event.timeStamp });
      }}
    >
      {step < 0 ? "◀" : "▶"}
    </button>
  );
  return (
    <div className="beat-fx" role="group" aria-label="Beat FX">
      <ControlFrame id="beat-fx-select" className="fx-select" captionSide="above">
        <span className="group-label">BEAT FX</span>
        <span className="fx-name">ECHO</span>
        <span className="fx-bpm" aria-label="Beat FX BPM">
          FX BPM: {tappedBpm === null ? "AUTO" : tappedBpm.toFixed(1)}
        </span>
      </ControlFrame>
      <ControlButton
        id="beat-fx-channel"
        label={CHANNEL_LABELS[fx.channel]}
        ariaLabel={`Beat FX channel ${CHANNEL_LABELS[fx.channel]}, press to change`}
        shape="small"
        captionSide="above"
        onPress={(input) => {
          session.beatFxChannelNext(input);
        }}
      />
      <ControlFrame id="beat-fx-beat" className="fx-beat" keyHint={keyHintFor("beat-fx-beat")} captionSide="above">
        {beatButton(-1)}
        <span className="fx-beat-value" aria-label="Beat FX beat">
          {beatsLabel(fx.beats)}
        </span>
        {beatButton(1)}
      </ControlFrame>
      <Knob id="beat-fx-depth" label="DEPTH" size="small" captionSide="below" title="LEVEL/DEPTH: how loud the echoes are." />
      <ControlButton
        id="beat-fx-on"
        label="ON/OFF"
        ariaLabel="Beat FX on/off"
        shape="small"
        tone="cue"
        lit={fx.on}
        keyHint={keyHintFor("beat-fx-on")}
        captionSide="above"
        onPress={(input) => {
          session.beatFxToggle(input);
        }}
      />
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
