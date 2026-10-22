// The unscored by-ear round before the tempo-fader Check (Lesson 8, Speed and pitch): the Learner
// plays a mystery clip, says On or Off, and hears at once what it was. Nothing here is graded or saved.

export interface EarRound {
  /** Rounds answered so far; the mystery of round N is `mysteryMasterTempo(N)`. */
  readonly round: number;
  readonly right: number;
  /** This round's mystery was played: an answer counts only then. */
  readonly heard: boolean;
  /** The line on the last answer; null before the first. */
  readonly line: string | null;
}

export const EAR_ROUND_START: EarRound = { round: 0, right: 0, heard: false, line: null };

/** Mixed so the answers cannot be learnt by position, and never three the same in a row (also across the wrap). */
const MYSTERY_PATTERN: readonly boolean[] = [true, false, false, true, false, true, true, false];

/** Whether round `round`'s mystery clip has Master Tempo on. */
export function mysteryMasterTempo(round: number): boolean {
  return MYSTERY_PATTERN[round % MYSTERY_PATTERN.length] ?? true;
}

export function earHeard(state: EarRound): EarRound {
  return state.heard ? state : { ...state, heard: true };
}

/** How each clip sounds once its tempo jumps. */
const SOUNDS = { on: "faster, same note", off: "faster, and higher" } as const;

/** The Learner says On (`saidOn`) or Off: the line names what the clip was, and the next round starts. */
export function earGuess(state: EarRound, saidOn: boolean): EarRound {
  if (!state.heard) return state;
  const on = mysteryMasterTempo(state.round);
  const name = on ? "On" : "Off";
  const sound = on ? SOUNDS.on : SOUNDS.off;
  const right = saidOn === on;
  const line = right ? `Right: ${name}. ${sound.charAt(0).toUpperCase()}${sound.slice(1)}.` : `That was ${name}: ${sound}.`;
  return { round: state.round + 1, right: state.right + (right ? 1 : 0), heard: false, line };
}
