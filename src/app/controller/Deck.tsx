// One deck, laid out as on the DDJ-FLX4 (both decks the same way round, as on the hardware):
// - top row: LOOP IN, LOOP OUT, 4 BEAT/EXIT, CUE/LOOP CALL ◀ ▶, BEAT SYNC;
// - the jog wheel, with SHIFT under its left edge;
// - bottom left: CUE above PLAY/PAUSE; beside them the pad-mode buttons over 8 pads;
// - far right: the TEMPO fader.
// SHIFT meanings are printed under the buttons, as on the panel. Parts the app does not use yet
// (CUE/LOOP CALL, the pad modes other than HOT CUE) are drawn as dimmed placeholders.
//
// The FLX4 has no MASTER TEMPO button: holding BEAT SYNC turns Master Tempo on or off, and
// SHIFT + BEAT SYNC changes the tempo range. The screen does the same.

import { useEffect, useRef } from "react";
import type { CommandInput, DeckId } from "@audio";
import { deckControl } from "./control-ids.ts";
import { useController, useSessionValue } from "./context.tsx";
import { ControlButton, keepFocusWhereItIs } from "./ControlButton.tsx";
import { ControlFrame } from "./ControlFrame.tsx";
import { Fader } from "./Fader.tsx";
import { JogWheel } from "./JogWheel.tsx";
import { hotCueKeyHint, keyHintFor } from "./keymap.ts";
import { PlaceholderButton } from "./Placeholder.tsx";
import { HOT_CUE_SLOTS } from "./session.ts";

/** How long BEAT SYNC is held before it means MASTER TEMPO instead of SYNC. */
export const SYNC_LONG_PRESS_MS = 800;

function HotCuePads({ deck }: { readonly deck: DeckId }) {
  const { session } = useController();
  const slots = useSessionValue((snapshot) => snapshot.decks[deck].hotCues);
  const shift = useSessionValue((snapshot) => snapshot.shiftHeld[deck]);
  const { legendOpen } = useController();
  return (
    <ControlFrame id={deckControl(deck, "hot-cue")} className="pads" captionSide="above">
      <div className="pad-modes">
        <div className="pad-mode-button">
          <span className="pad-mode lit">HOT CUE</span>
          <span className="shift-label">KEYBOARD</span>
        </div>
        <PlaceholderButton shape="pad-mode" label="PAD FX1" shiftLabel="PAD FX2" />
        <PlaceholderButton shape="pad-mode" label="BEAT JUMP" shiftLabel="BEAT LOOP" />
        <PlaceholderButton shape="pad-mode" label="SAMPLER" shiftLabel="KEY SHIFT" />
      </div>
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

/** LOOP IN (SHIFT: ½X), LOOP OUT (SHIFT: 2X) and 4 BEAT/EXIT, lit while the deck loops. */
function LoopButtons({ deck }: { readonly deck: DeckId }) {
  const { session } = useController();
  const looping = useSessionValue((snapshot) => snapshot.decks[deck].loop !== null);
  const marked = useSessionValue((snapshot) => snapshot.decks[deck].loopInSec !== null);
  const shift = useSessionValue((snapshot) => snapshot.shiftHeld[deck]);
  return (
    <div className="loop-row" role="group" aria-label={`Deck ${deck} loop`}>
      <ControlButton
        id={deckControl(deck, "loop-in")}
        label={shift ? "½X" : "IN"}
        ariaLabel={`Deck ${deck} loop in`}
        shape="small"
        tone="loop"
        shiftLabel="IN ADJ"
        lit={marked && !looping}
        keyHint={keyHintFor(deckControl(deck, "loop-in"))}
        captionSide="below"
        onPress={(input) => {
          session.loopIn(deck, false, input);
        }}
      />
      <ControlButton
        id={deckControl(deck, "loop-out")}
        label={shift ? "2X" : "OUT"}
        ariaLabel={`Deck ${deck} loop out`}
        shape="small"
        tone="loop"
        shiftLabel="OUT ADJ"
        lit={looping}
        keyHint={keyHintFor(deckControl(deck, "loop-out"))}
        captionSide="below"
        onPress={(input) => {
          session.loopOut(deck, false, input);
        }}
      />
      <ControlButton
        id={deckControl(deck, "loop-exit")}
        label={looping ? "EXIT" : "4 BEAT"}
        ariaLabel={`Deck ${deck} 4 beat loop or exit`}
        shape="small"
        shiftLabel="ACTIVE"
        lit={looping}
        keyHint={keyHintFor(deckControl(deck, "loop-exit"))}
        captionSide="below"
        onPress={(input) => {
          session.loopButton(deck, input);
        }}
      />
    </div>
  );
}

/** CUE/LOOP CALL ◀ ▶: not in the app yet. */
function CueLoopCall() {
  return (
    <div className="cue-loop-call" aria-hidden="true">
      <span className="top-label">CUE/LOOP CALL</span>
      <div className="cue-loop-call-buttons">
        <PlaceholderButton label="◀" shiftLabel="DEL" topLabel="½X" className="arrow" />
        <span className="loop-word">LOOP</span>
        <PlaceholderButton label="▶" shiftLabel="MEMORY" topLabel="2X" className="arrow" />
      </div>
    </div>
  );
}

/**
 * BEAT SYNC, as on the FLX4: a press toggles SYNC (on release, as the hardware sends it), a long press
 * toggles MASTER TEMPO, and SHIFT + BEAT SYNC changes the tempo range. A small lamp shows Master Tempo.
 */
function SyncButton({ deck }: { readonly deck: DeckId }) {
  const { session, concealed } = useController();
  const syncOn = useSessionValue((snapshot) => snapshot.decks[deck].syncOn);
  const masterTempo = useSessionValue((snapshot) => snapshot.decks[deck].masterTempo);
  const masterTempoId = deckControl(deck, "master-tempo");
  const syncId = deckControl(deck, "sync");
  const press = useRef<"sync" | "done" | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => stopTimer, []);
  const lampOn = masterTempo && !concealed.has(masterTempoId);
  return (
    <ControlButton
      id={syncId}
      also={[masterTempoId]}
      className="sync-button"
      label="BEAT SYNC"
      topLabel="MASTER"
      shiftLabel="TEMPO RANGE"
      ariaLabel={`Deck ${deck} beat sync (hold for master tempo)`}
      shape="small"
      lit={syncOn}
      captionSide="below"
      onPress={(input: CommandInput) => {
        stopTimer();
        if (session.snapshot().shiftHeld[deck]) {
          press.current = "done";
          session.cycleTempoRange(deck, input);
          return;
        }
        press.current = "sync";
        if (!session.isUnlocked(masterTempoId)) return;
        timer.current = setTimeout(() => {
          timer.current = null;
          press.current = "done";
          session.toggle(deck, "master-tempo", { device: input.device, eventTimeMs: performance.now() });
        }, SYNC_LONG_PRESS_MS);
      }}
      onRelease={(input: CommandInput) => {
        stopTimer();
        // SYNC withheld (the by-ear Lessons) while Master Tempo is open: a press says "not yet", as on the hardware.
        if (press.current === "sync") {
          if (session.isUnlocked(syncId)) session.toggle(deck, "sync", input);
          else session.refuse(syncId);
        }
        press.current = null;
      }}
    >
      <span className="master-tempo-lamp" data-on={lampOn} data-testid={`master-tempo-lamp-${deck}`} title={lampOn ? "Master Tempo on" : "Master Tempo off"} />
    </ControlButton>
  );
}

function DeckTop({ deck }: { readonly deck: DeckId }) {
  return (
    <div className="deck-top">
      <LoopButtons deck={deck} />
      <CueLoopCall />
      <SyncButton deck={deck} />
    </div>
  );
}

function ShiftButton({ deck }: { readonly deck: DeckId }) {
  const { session } = useController();
  const shift = useSessionValue((snapshot) => snapshot.shiftHeld[deck]);
  return (
    <div className="deck-shift">
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
    </div>
  );
}

function Transport({ deck }: { readonly deck: DeckId }) {
  const { session } = useController();
  const playing = useSessionValue((snapshot) => snapshot.decks[deck].playing && !snapshot.decks[deck].previewing);
  const previewing = useSessionValue((snapshot) => snapshot.decks[deck].previewing);
  return (
    <div className="transport">
      <ControlButton
        id={deckControl(deck, "cue")}
        label="CUE"
        ariaLabel={`Deck ${deck} cue`}
        shape="round"
        tone="cue"
        lit={previewing}
        keyHint={keyHintFor(deckControl(deck, "cue"))}
        captionSide="right"
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
        captionSide="right"
        onPress={(input) => {
          session.playPause(deck, input);
        }}
      />
      <span className="transport-label">PLAY/PAUSE</span>
    </div>
  );
}

function TempoColumn({ deck }: { readonly deck: DeckId }) {
  const { session } = useController();
  const rangePercent = useSessionValue((snapshot) => snapshot.decks[deck].tempoRangePercent);
  return (
    <div className="tempo-column">
      <ControlFrame id={deckControl(deck, "tempo-range")} className="tempo-range" captionSide="left">
        <button
          type="button"
          className="range-readout"
          aria-label={`Deck ${deck} tempo range ±${String(rangePercent)}%, press to change`}
          title="Tempo range (on the FLX4: SHIFT + BEAT SYNC)"
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
        captionSide="left"
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
      <DeckTop deck={deck} />
      <div className="deck-main">
        <ShiftButton deck={deck} />
        <JogWheel deck={deck} captionSide="above" />
        <Transport deck={deck} />
        <HotCuePads deck={deck} />
      </div>
      <TempoColumn deck={deck} />
    </section>
  );
}
