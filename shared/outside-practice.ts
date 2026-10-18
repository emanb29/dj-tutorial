// Outside practice (ISS-96): a mix the Learner recorded elsewhere (rekordbox, any DJ software) and
// had graded here. It is kept in the Learner's record as a summary only: never the audio, never the
// file name, and never as Lesson credit.
import { z } from "zod";
import { IsoTimeSchema } from "./check-types.ts";

/** A mix shorter than this has no room for two tracks and a transition. */
export const MIX_MIN_SEC = 30;
/** Longer mixes do not fit the analysis worker's memory on a phone (about 320 MB decoded). */
export const MIX_MAX_SEC = 30 * 60;
/** About 30 minutes of a 320 kbit/s MP3, or 15 minutes of CD-quality WAV. */
export const MIX_MAX_BYTES = 150 * 1024 * 1024;

/** The newest graded mixes kept; the record must stay well under the server's 32 KB body limit. */
export const OUTSIDE_PRACTICE_KEPT = 12;

/** The six per-transition checks, in the order the result card shows them. */
export const MIX_CHECK_IDS = ["onPhrase", "drift", "levels", "clipping", "deadAir", "oneBass"] as const;
export type MixCheckId = (typeof MIX_CHECK_IDS)[number];

/** How many transitions a check could judge, and how many of those were met. */
const CheckTallySchema = z
  .strictObject({ met: z.int().nonnegative(), of: z.int().nonnegative() })
  .refine((tally) => tally.met <= tally.of, { message: "met must be at most of." });

export const OutsidePracticeSchema = z.strictObject({
  /** Random id (crypto.randomUUID) for this grading. */
  id: z.string().min(1).max(100),
  kind: z.literal("mix-recording"),
  /** Wall clock when it was graded: not when it was recorded, which the app does not know. */
  gradedAt: IsoTimeSchema,
  durationSec: z.number().positive().max(MIX_MAX_SEC),
  transitions: z.int().nonnegative().max(200),
  blends: z.int().nonnegative().max(200),
  /** Every check met on every transition it could judge. */
  clean: z.boolean(),
  checks: z.strictObject({
    onPhrase: CheckTallySchema,
    drift: CheckTallySchema,
    levels: CheckTallySchema,
    clipping: CheckTallySchema,
    deadAir: CheckTallySchema,
    oneBass: CheckTallySchema,
  } satisfies Record<MixCheckId, typeof CheckTallySchema>),
});
export type OutsidePractice = z.output<typeof OutsidePracticeSchema>;
