// phrases' "Phrase N" previews, once the Check's audio part is over: ▶ on phrase N plays across the
// change into it (a breakdown or a drop is heard only against what came before), from 2 bars before
// it until the Learner stops it, or the graded window's end plus a bar. Pure.
import type { PhrasePreviews } from "./types.ts";

/** Where ▶ on phrase `phrase` (1-based) plays from and where it stops, track positions; null past the window. */
export function phrasePreviewSpan(previews: PhrasePreviews, phrase: number): { readonly fromPos: number; readonly untilPos: number } | null {
  const fromPos = previews.from[phrase - 1];
  return fromPos === undefined ? null : { fromPos, untilPos: previews.until };
}

/** The phrase heard at `positionSec` and its bar (1–8); null before phrase 1 or past the window. */
export function previewPhraseAt(previews: PhrasePreviews, positionSec: number): { readonly phrase: number; readonly bar: number } | null {
  const index = previews.starts.findLastIndex((start) => positionSec >= start - 1e-6);
  const start = previews.starts[index];
  const next = index === previews.starts.length - 1 ? previews.end : previews.starts[index + 1];
  if (start === undefined || next === undefined || positionSec >= next - 1e-6) return null;
  const bar = Math.min(previews.barsPerPhrase, Math.floor(((positionSec - start) / (next - start)) * previews.barsPerPhrase + 1e-6) + 1);
  return { phrase: index + 1, bar };
}
