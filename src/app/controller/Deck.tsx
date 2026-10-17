// One deck column, DDJ-FLX4 style: 8 pads in HOT CUE mode above the jog wheel; SHIFT, CUE and
// PLAY/PAUSE below it; and on the outer edge SYNC, MASTER TEMPO (SHIFT: tempo range) and the tempo fader.

import type { DeckId } from "@audio";
import { deckControl } from "./control-ids.ts";
import { useController, useSessionValue } from "./context.tsx";
import { ControlButton, keepFocusWhereItIs } from "./ControlButton.tsx";
import { ControlFrame } from "./ControlFrame.tsx";
import { Fader } from "./Fader.tsx";
import { JogWheel } from "./JogWheel.tsx";
import { hotCueKeyHint, keyHintFor } from "./keymap.ts";
import { HOT_CUE_SLOTS } from "./session.ts";

function HotCuePads({ deck }: { readonly deck: DeckId }) {
  const { session } = useController();
  const slots = useSessionValue((snapshot) => snapshot.hotCues[deck]);
  const shift = useSessionValue((snapshot) => snapshot.shiftHeld[deck]);
  const { legendOpen } = useController();
  return (
    <ControlFrame id={deckControl(deck, "hot-cue")} className="pads" captionSide="above">
      <div className="pad-mode">HOT CUE</div>
      <div className="pad-grid">
        {Array.from({ length: HOT_CUE_SLOTS }, (_, slot) => {
          const set = (slots[slot] ?? null) !== null;
          const hint = legendOpen ? hotCueKeyHint(deck, slot) : null;
          return (
            <button
              key={slot}
              type="button"
              className={`pad${set ? " set" : ""}${shift && set ? " erasing" : ""}`}
              aria-label={`Deck ${deck} hot cue ${String(slot + 1)}${set ? " (set)" : " (empty)"}`}
              onMouseDown={keepFocusWhereItIs}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                session.hotCue(deck, slot, shift, { device: session.devices.fromPointer(event.pointerType), eventTimeMs: event.timeStamp });
              }}
              onClick={(event) => {
                if (event.detail === 0) session.hotCue(deck, slot, shift, { device: "keyboard", eventTimeMs: event.timeStamp });
              }}
            >
              <span>{slot + 1}</span>
              {hint === null ? null : <kbd className="pad-key">{hint}</kbd>}
            </button>
          );
        })}
      </div>
    </ControlFrame>
  );
}

function Transport({ deck }: { readonly deck: DeckId }) {
  const { session } = useController();
  const playing = useSessionValue((snapshot) => snapshot.decks[deck].playing && !snapshot.decks[deck].previewing);
  const previewing = useSessionValue((snapshot) => snapshot.decks[deck].previewing);
  const shift = useSessionValue((snapshot) => snapshot.shiftHeld[deck]);
  return (
    <div className="transport">
      <ControlButton
        id={deckControl(deck, "shift")}
        label="SHIFT"
        ariaLabel={`Deck ${deck} shift`}
        shape="small"
        lit={shift}
        onPress={() => {
          session.setShift(deck, true);
        }}
        onRelease={() => {
          session.setShift(deck, false);
        }}
      />
      <ControlButton
        id={deckControl(deck, "cue")}
        label="CUE"
        ariaLabel={`Deck ${deck} cue`}
        shape="round"
        tone="cue"
        lit={previewing}
        keyHint={keyHintFor(deckControl(deck, "cue"))}
        onPress={(input) => {
          session.deckCue(deck, true, input);
        }}
        onRelease={(input) => {
          session.deckCue(deck, false, input);
        }}
      />
      <ControlButton
        id={deckControl(deck, "play")}
        label="▶/❚❚"
        ariaLabel={`Deck ${deck} play/pause`}
        shape="round"
        tone="play"
        lit={playing}
        keyHint={keyHintFor(deckControl(deck, "play"))}
        onPress={(input) => {
          session.playPause(deck, input);
        }}
      />
    </div>
  );
}

function TempoColumn({ deck }: { readonly deck: DeckId }) {
  const { session } = useController();
  const syncOn = useSessionValue((snapshot) => snapshot.decks[deck].syncOn);
  const masterTempo = useSessionValue((snapshot) => snapshot.decks[deck].masterTempo);
  const rangePercent = useSessionValue((snapshot) => snapshot.decks[deck].tempoRangePercent);
  return (
    <div className="tempo-column">
      <ControlButton
        id={deckControl(deck, "sync")}
        label="BEAT SYNC"
        ariaLabel={`Deck ${deck} beat sync`}
        lit={syncOn}
        onPress={(input) => {
          session.toggle(deck, "sync", input);
        }}
      />
      <ControlButton
        id={deckControl(deck, "master-tempo")}
        label={
          <>
            MASTER TEMPO<small>SHIFT: RANGE</small>
          </>
        }
        ariaLabel={`Deck ${deck} master tempo`}
        lit={masterTempo}
        onPress={(input) => {
          session.masterTempoButton(deck, input);
        }}
      />
      <ControlFrame id={deckControl(deck, "tempo-range")} className="tempo-range">
        <button
          type="button"
          className="range-readout"
          aria-label={`Deck ${deck} tempo range ±${String(rangePercent)}%, press to change`}
          onMouseDown={keepFocusWhereItIs}
          onPointerDown={(event) => {
            if (event.button === 0) session.cycleTempoRange(deck, { device: session.devices.fromPointer(event.pointerType), eventTimeMs: event.timeStamp });
          }}
          onClick={(event) => {
            if (event.detail === 0) session.cycleTempoRange(deck, { device: "keyboard", eventTimeMs: event.timeStamp });
          }}
        >
          ±{rangePercent}%
        </button>
      </ControlFrame>
      <Fader
        id={`${deck}.tempo`}
        label="TEMPO"
        axis="vertical"
        className="tempo-fader"
        marks={
          <>
            <span className="mark-end mark-top">−</span>
            <span className="mark-centre" />
            <span className="mark-end mark-bottom">+</span>
          </>
        }
      />
    </div>
  );
}

export function Deck({ deck }: { readonly deck: DeckId }) {
  return (
    <section className={`deck deck-${deck}`} aria-label={`Deck ${deck}`}>
      <TempoColumn deck={deck} />
      <div className="deck-main">
        <HotCuePads deck={deck} />
        <JogWheel deck={deck} captionSide="above" />
        <Transport deck={deck} />
      </div>
    </section>
  );
}
