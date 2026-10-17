// Shared measures (docs/check-design.md §2). Pure; every time is heard AudioContext seconds.

/** Comparisons on seconds allow this much float error, so a value on a boundary counts as on it. */
export const TIME_EPSILON = 1e-9;

export interface TapMatch {
  readonly matched: number;
  /** Taps with no target. */
  readonly extras: number;
  /** Signed `tap − target` per matched pair, in tap order, seconds. */
  readonly offsets: readonly number[];
  /** The targets that were matched, ascending. */
  readonly matchedTargets: readonly number[];
}

/**
 * One-to-one matching: every pair within `±tolerance` is considered, nearest first (ties go to
 * the earlier tap, then the earlier target), and a tap or target is used at most once. So tap
 * spam earns one match and many extras.
 */
export function matchTaps(
  taps: readonly number[],
  targets: readonly number[],
  tolerance: number,
): TapMatch {
  const pairs = taps
    .flatMap((tap, tapIndex) =>
      targets.map((target, targetIndex) => ({ tapIndex, targetIndex, distance: Math.abs(tap - target) })),
    )
    .filter((pair) => pair.distance <= tolerance + TIME_EPSILON)
    .sort((a, b) => a.distance - b.distance || a.tapIndex - b.tapIndex || a.targetIndex - b.targetIndex);

  const tapUsed = new Set<number>();
  const targetUsed = new Set<number>();
  const chosen: { tapIndex: number; targetIndex: number }[] = [];
  for (const pair of pairs) {
    if (tapUsed.has(pair.tapIndex) || targetUsed.has(pair.targetIndex)) continue;
    tapUsed.add(pair.tapIndex);
    targetUsed.add(pair.targetIndex);
    chosen.push(pair);
  }
  chosen.sort((a, b) => a.tapIndex - b.tapIndex);

  return {
    matched: chosen.length,
    extras: taps.length - chosen.length,
    offsets: chosen.map(({ tapIndex, targetIndex }) => at(taps, tapIndex) - at(targets, targetIndex)),
    matchedTargets: chosen.map(({ targetIndex }) => at(targets, targetIndex)).sort((a, b) => a - b),
  };
}

/** Median of a non-empty list; `null` for an empty one. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? at(sorted, middle) : (at(sorted, middle - 1) + at(sorted, middle)) / 2;
}

/** Energy mean of dB-style values (LUFS, dBFS): `10·log10(mean(10^(x/10)))`. */
export function energyMeanDb(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const meanPower = values.reduce((sum, value) => sum + 10 ** (value / 10), 0) / values.length;
  return meanPower > 0 ? 10 * Math.log10(meanPower) : -Infinity;
}

/** Element `index` of a list the caller has already bounds-checked. */
export function at<T>(list: readonly T[], index: number): T {
  const value = list[index];
  if (value === undefined) throw new RangeError(`index ${String(index)} outside a list of ${String(list.length)}`);
  return value;
}
