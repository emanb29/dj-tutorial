// tempo-fader's ear round (Lesson 8, Speed and pitch), once practice is ready and before the Check:
// the Check's own clip, labelled Off and On to compare, then a mystery to name with a line on each
// answer (ear-round.ts). Not graded, not saved: the Check's clip questions are the graded part.
import { useEffect, useState } from "react";
import { EAR_ROUND_START, earGuess, earHeard, mysteryMasterTempo, type DeckId, type ListeningClip, type LessonTrack } from "@lessons";

/** What the ear round needs of the Lesson session (`LessonSession` has it). */
export interface EarRoundSession {
  playListeningClip(clip: ListeningClip | null): void;
  stopListening(): void;
}

type Playing = "off" | "on" | "mystery" | null;

export function EarRound({
  session,
  track,
  clip,
  onPlaying,
}: {
  readonly session: EarRoundSession;
  readonly track: LessonTrack;
  /** The Check's clip with Master Tempo on or off (`LessonDefinition.practiceClip`). */
  readonly clip: (track: LessonTrack, masterTempo: boolean) => ListeningClip;
  /** The deck a clip plays on now (its tempo controls are held while it plays), or null. */
  readonly onPlaying: (deck: DeckId | null) => void;
}) {
  const [round, setRound] = useState(EAR_ROUND_START);
  const [playing, setPlaying] = useState<Playing>(null);

  // Closing the round (the Check, practice again, leaving) stops its clip.
  useEffect(
    () => () => {
      session.stopListening();
      onPlaying(null);
    },
    [session, onPlaying],
  );

  const play = (which: Exclude<Playing, null>) => {
    const masterTempo = which === "mystery" ? mysteryMasterTempo(round.round) : which === "on";
    const playingClip = clip(track, masterTempo);
    session.playListeningClip(playingClip);
    setPlaying(which);
    onPlaying(playingClip.deck);
    if (which === "mystery") setRound(earHeard);
  };
  const stop = () => {
    session.stopListening();
    setPlaying(null);
    onPlaying(null);
  };
  const answer = (saidOn: boolean) => {
    setRound((current) => earGuess(current, saidOn));
    stop();
  };

  return (
    <section className="lesson-questions lesson-overlay ear-round" aria-label="By ear, not graded" data-testid="ear-round">
      {/* AlphaTheta: "Adjusting the playback speed without changing the pitch (Master Tempo)" (see catalogue-sync.ts). */}
      <span className="lesson-hint">Master Tempo keeps the key: vocals sound natural. DJs blend with it on.</span>
      <div className="lesson-question">
        <span>Hear both</span>
        <div role="group" aria-label="Hear both">
          {(["off", "on"] as const).map((which) => (
            <button key={which} type="button" className="btn" aria-pressed={playing === which} onClick={() => { play(which); }}>
              ▶ {which === "on" ? "On" : "Off"}
            </button>
          ))}
        </div>
      </div>
      <div className="lesson-question">
        <span>Try one: on or off?</span>
        <div role="group" aria-label="Try one: on or off?">
          <button type="button" className="btn" aria-pressed={playing === "mystery"} onClick={() => { play("mystery"); }}>
            ▶ Mystery
          </button>
          {([true, false] as const).map((saidOn) => (
            <button key={String(saidOn)} type="button" className="btn" disabled={!round.heard} onClick={() => { answer(saidOn); }}>
              {saidOn ? "On" : "Off"}
            </button>
          ))}
        </div>
      </div>
      <div className="ear-round-foot">
        <span className="ear-round-line" role="status" data-testid="ear-round-line">
          {round.line ?? ""}
        </span>
        {round.round > 0 ? <span className="lesson-hint">{`${String(round.right)} of ${String(round.round)} right`}</span> : null}
        {playing === null ? null : (
          <button type="button" className="btn btn-quiet" onClick={stop}>
            ■ Stop
          </button>
        )}
      </div>
    </section>
  );
}
