/**
 * The contract for Originals: tracks the owner's generator writes under
 * `.local/tracks/originals/` (gitignored, never committed). The server reads them, and the client
 * turns their meta into a known beat grid so these tracks skip analysis.
 *
 * On disk:
 *   index.jsonl                one JSON object per line; `id` plus the summary fields below and
 *                              `path`, the generator's absolute path to the track's folder
 *   <folder>/meta.json         the summary plus `firstDownbeatSec` and `phrases` (exact, from the
 *                              generator's spec, not estimated)
 *   <folder>/track.mp3         the mixdown the app plays (stems and WAVs are not served)
 *
 * The server never trusts `path`: it uses only its last segment, as a folder name inside the
 * originals directory, and refuses anything that resolves outside it. `path` is never sent to the
 * browser. Unknown fields are allowed, so the generator can add some without breaking the app.
 */
import { z } from "zod";

export const ORIGINALS_PATH = "/api/originals";

/** A safe id: it is used in URLs and to match index lines, never directly as a path. */
export const OriginalIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, "use 1-64 letters, digits, '-' or '_'");

const summaryFields = {
  id: OriginalIdSchema,
  title: z.string().min(1),
  genre: z.string().min(1),
  subgenre: z.string().optional(),
  bpm: z.number().positive(),
  key: z.string().optional(),
  camelot: z.string().optional(),
  durationSec: z.number().positive(),
  bars: z.number().int().positive(),
  introBars: z.number().int().nonnegative().optional(),
  outroBars: z.number().int().nonnegative().optional(),
};

/** One line of index.jsonl, as the generator writes it. */
export const OriginalIndexLineSchema = z.looseObject({ ...summaryFields, path: z.string().optional() });

/** What `GET /api/originals` returns per track: the index line without `path`. */
export const OriginalSummarySchema = z.object(summaryFields);
export type OriginalSummary = z.infer<typeof OriginalSummarySchema>;

export const PhraseSchema = z.object({
  /** 0-based bar where the phrase starts, counted from `firstDownbeatSec`. */
  startBar: z.number().int().nonnegative(),
  lengthBars: z.number().int().positive(),
  /** e.g. intro, build, drop, breakdown, outro. */
  section: z.string().min(1),
});
export type Phrase = z.infer<typeof PhraseSchema>;

/** meta.json: the summary plus the exact grid anchor and phrases. Every original is 4/4. */
export const OriginalMetaSchema = z.looseObject({
  ...summaryFields,
  firstDownbeatSec: z.number().nonnegative(),
  phrases: z.array(PhraseSchema),
});
export type OriginalMeta = z.infer<typeof OriginalMetaSchema>;
