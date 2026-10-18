// The centre of the DDJ-FLX4, laid out as on the hardware:
// - top: LOAD over each channel with the BROWSE knob between them (placeholders: the app loads tracks itself);
// - left column: MIC LEVEL, SMART CFX, headphone MIX and LEVEL, SMART FADER;
// - per channel: TRIM, HI, MID, LOW, CFX, the level meter on the inner side, headphone CUE and the
//   channel fader; the crossfader across the bottom;
// - right column: MASTER LEVEL (with the app's master meter, which the FLX4 does not have), master
//   CUE, and BEAT FX: CH SELECT, FX SELECT, BEAT ◀ ▶, LEVEL/DEPTH and ON/OFF.
// Parts the app does not use yet are dimmed placeholders. BEAT ▶ with SHIFT is TAP, as printed on the
// FLX4; while Beat FX is still locked, BEAT ◀ and ▶ tap the beat too (the hardware bridge does the same).

import type { DeckId } from "@audio";
import { deckControl } from "./control-ids.ts";
import { useController, useSessionValue } from "./context.tsx";
import { ControlButton, keepFocusWhereItIs } from "./ControlButton.tsx";
import { ControlFrame } from "./ControlFrame.tsx";
import { LevelMeter } from "./displays.tsx";
import { Fader } from "./Fader.tsx";
import { keyHintFor } from "./keymap.ts";
import { Knob } from "./Knob.tsx";
import { PlaceholderButton, PlaceholderKnob } from "./Placeholder.tsx";
import { useWording } from "./wording.ts";

function HeadphoneIcon() {
  return (
    <svg className="headphone-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path d="M2 10V8a6 6 0 0 1 12 0v2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <rect x="1.5" y="9" width="3" height="5" rx="1" fill="currentColor" />
      <rect x="11.5" y="9" width="3" height="5" rx="1" fill="currentColor" />
    </svg>
  );
}

const CHANNEL_NUMBER: Readonly<Record<DeckId, string>> = { A: "1", B: "2" };

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
      <div className="channel-meter">
        <LevelMeter id={deckControl(deck, "level-meter")} bus={deck} label={deck} />
      </div>
      <ControlButton
        id={deckControl(deck, "headphone-cue")}
        label={
          <>
            <HeadphoneIcon /> CUE
          </>
        }
        ariaLabel={`Channel ${deck} headphone cue`}
        shape="small"
        tone="cue"
        lit={cueOn}
        shiftLabel={CHANNEL_NUMBER[deck]}
        captionSide={side}
        onPress={(input) => {
          session.toggle(deck, "headphone-cue", input);
        }}
      />
      <Fader id={`${deck}.channel-fader`} label={`CH ${deck}`} axis="vertical" className="channel-fader" keyHint={keyHintFor(deckControl(deck, "channel-fader"))} captionSide={side} />
    </div>
  );
}

/** LOAD, BROWSE, LOAD: the app picks tracks itself, so these are placeholders. */
function LoadRow() {
  return (
    <div className="mixer-load" aria-hidden="true">
      <PlaceholderButton label="LOAD" className="load" />
      <PlaceholderKnob label="BACK" className="browse" />
      <PlaceholderButton label="LOAD" className="load" />
    </div>
  );
}

/** MIC LEVEL, SMART CFX, the headphone MIX and LEVEL knobs, SMART FADER. */
function LeftColumn({ outputLine }: { readonly outputLine: string | null }) {
  return (
    <div className="mixer-left">
      <PlaceholderKnob label="MIC LEVEL" />
      <PlaceholderButton label="SMART CFX" shape="round" shiftLabel="FX SELECT" className="smart" />
      <div className="headphones-group">
        <Knob id="cue-mix" label="Ω MIX" size="small" captionSide="right" title="MIX: left is the cued channels (CUE), right is the master (MST)." />
        <Knob id="headphone-level" label="Ω LEVEL" size="small" captionSide="right" title="Headphone LEVEL: how loud your headphone ear is." />
        {outputLine === null ? null : (
          <span className="output-line" data-testid="output-line">
            {outputLine}
          </span>
        )}
      </div>
      <PlaceholderButton label="SMART FADER" shape="round" className="smart" />
    </div>
  );
}

/** A beat count as the FLX4's display shows it: 1/8, 1/4, 1/2, 3/4, 1, 2, 4. */
export function beatsLabel(beats: number): string {
  const fractions: Readonly<Record<string, string>> = { "0.125": "1/8", "0.25": "1/4", "0.5": "1/2", "0.75": "3/4" };
  return fractions[String(beats)] ?? String(beats);
}

const CHANNEL_LABELS = { A: "CH 1", B: "CH 2", master: "MASTER" } as const;
/** The CH SELECT lever's printed positions: 1, 2 and 1&2 (the app's MASTER). */
const LEVER_POSITIONS = [
  ["A", "1"],
  ["B", "2"],
  ["master", "1&2"],
] as const;

/** BEAT FX, FLX4 style: CH SELECT, FX SELECT (ECHO), BEAT ◀ ▶ with its value, LEVEL/DEPTH and ON/OFF. */
export function BeatFx() {
  const { session } = useController();
  const fx = useSessionValue((snapshot) => snapshot.mixer.beatFx);
  const tappedBpm = useSessionValue((snapshot) => snapshot.mixer.beatFxBpm);
  const shift = useSessionValue((snapshot) => snapshot.shiftHeld.A || snapshot.shiftHeld.B);
  // On a touchscreen TAP has its own button; with keys or a mouse it is here (SHIFT + BEAT ▶).
  const tapHere = useWording() === "keys";
  const pointer = (event: { pointerType: string; timeStamp: number }) => ({ device: session.devices.fromPointer(event.pointerType), eventTimeMs: event.timeStamp });
  const beatButton = (step: -1 | 1) => (
    <span className="fx-beat-step-frame">
      <button
        type="button"
        className="hw-button fx-beat-step"
        aria-label={step < 0 ? "Beat FX beat shorter" : shift ? "Tap the beat (SHIFT + BEAT ▶)" : "Beat FX beat longer"}
        onMouseDown={keepFocusWhereItIs}
        onPointerDown={(event) => {
          if (event.button === 0) session.beatButton(step, pointer(event));
        }}
        onClick={(event) => {
          if (event.detail === 0) session.beatButton(step, { device: "keyboard", eventTimeMs: event.timeStamp });
        }}
      >
        {step < 0 ? "◀" : "▶"}
      </button>
      <span className="shift-label">{step < 0 ? "AUTO" : "TAP"}</span>
    </span>
  );
  return (
    <div className="beat-fx" role="group" aria-label="Beat FX">
      <span className="group-label beat-fx-title">BEAT FX</span>
      <ControlButton
        id="beat-fx-channel"
        className="fx-lever"
        label={
          <span className="lever" aria-hidden="true">
            {LEVER_POSITIONS.map(([channel, printed]) => (
              <span key={channel} className="lever-position" data-on={fx.channel === channel}>
                {printed}
              </span>
            ))}
          </span>
        }
        ariaLabel={`Beat FX channel ${CHANNEL_LABELS[fx.channel]}, press to change`}
        shape="small"
        captionSide="left"
        onPress={(input) => {
          session.beatFxChannelNext(input);
        }}
      />
      <ControlFrame id="beat-fx-select" className="fx-select" captionSide="left">
        <span className="top-label">FX SELECT</span>
        <span className="fx-name">ECHO</span>
        {/* The tempo the echo follows: AUTO (the deck's), or tapped with SHIFT + BEAT ▶. */}
        <span className="fx-bpm" aria-label="Beat FX BPM">
          FX BPM: {tappedBpm === null ? "AUTO" : tappedBpm.toFixed(1)}
        </span>
      </ControlFrame>
      <ControlFrame id="beat-fx-beat" also={tapHere ? ["tap"] : []} className="fx-beat" keyHint={keyHintFor("beat-fx-beat")} captionSide="left">
        <span className="top-label">
          BEAT <span className="fx-beat-value" aria-label="Beat FX beat">{beatsLabel(fx.beats)}</span>
        </span>
        <span className="fx-beat-buttons">
          {beatButton(-1)}
          {beatButton(1)}
        </span>
      </ControlFrame>
      <Knob id="beat-fx-depth" label="LEVEL/DEPTH" size="small" captionSide="left" title="LEVEL/DEPTH: how loud the echoes are." />
      <ControlButton
        id="beat-fx-on"
        label="ON/OFF"
        ariaLabel="Beat FX on/off"
        shape="round"
        tone="fx"
        shiftLabel="RELEASE FX"
        lit={fx.on}
        keyHint={keyHintFor("beat-fx-on")}
        captionSide="left"
        onPress={(input) => {
          session.beatFxToggle(input);
        }}
      />
    </div>
  );
}

/** MASTER LEVEL with the app's master meter, master CUE (placeholder), then BEAT FX. */
function RightColumn() {
  return (
    <div className="mixer-right">
      <div className="master-group">
        <Knob id="master-level" label="MASTER LEVEL" captionSide="left" />
        <LevelMeter id="master-meter" bus="master" label="MASTER" />
      </div>
      <PlaceholderButton label="CUE" className="master-cue" />
      <BeatFx />
    </div>
  );
}

export function Mixer({ outputLine = null }: { readonly outputLine?: string | null }) {
  return (
    <section className="mixer" aria-label="Mixer">
      <LeftColumn outputLine={outputLine} />
      <LoadRow />
      <ChannelStrip deck="A" />
      <ChannelStrip deck="B" />
      <Fader id="crossfader" label="CROSSFADER" axis="horizontal" className="crossfader" keyHint={keyHintFor("crossfader")} captionSide="above" />
      <RightColumn />
    </section>
  );
}
