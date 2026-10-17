// Check vocabulary shared by Checks, the Skill profile and the Coach (docs/check-design.md §9).
import { z } from "zod";
import { LESSON_IDS } from "./catalogue.ts";

export const LessonIdSchema = z.enum(LESSON_IDS);

export const STANDING_IDS = [
  "no-clip",
  "no-dead-air",
  "on-phrase",
  "level-match",
  "cued-first",
  "trim-still",
  "no-boost",
  "controls-reset",
  "sync-kept",
  "no-recue",
  "one-bass",
  "drift",
  "overcorrect",
  "key-clash",
  "technique-mix",
] as const;
export type StandingId = (typeof STANDING_IDS)[number];

export type CriterionId = `${(typeof LESSON_IDS)[number]}.${string}` | `standing.${StandingId}`;

// Kebab-case names; capitals allowed after the first character for deck letters (`gain-staging.trim-A`).
const criterionIdPattern = new RegExp(
  `^(?:(?:${LESSON_IDS.join("|")})\\.[a-z0-9][a-zA-Z0-9-]{0,63}|standing\\.(?:${STANDING_IDS.join("|")}))$`,
);

export function isCriterionId(value: string): value is CriterionId {
  return criterionIdPattern.test(value);
}

export const CriterionIdSchema = z
  .string()
  .refine(isCriterionId, {
    message:
      'Expected a criterion id such as "cut-on-phrase.play-on-phrase" (a Lesson id, a dot, a kebab-case name; deck letters may be capitals) or "standing.no-clip".',
  });

export const CHECK_MODES = ["lesson", "placement", "cold", "warmup", "bonus"] as const;
export const CheckModeSchema = z.enum(CHECK_MODES);
export type CheckMode = z.infer<typeof CheckModeSchema>;

export const SeveritySchema = z.enum(["fail", "warn", "report"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const BandSchema = z.enum(["pass", "merit", "distinction"]);

export const UnitSchema = z.enum(["ms", "beats", "bars", "dB", "dBFS", "LUFS", "BPM", "ratio", "count", "s"]);
export type Unit = z.infer<typeof UnitSchema>;

export const ThresholdSchema = z.strictObject({
  op: z.enum(["<=", ">=", "==", "in"]),
  value: z.union([z.number(), z.tuple([z.number(), z.number()])]),
  unit: UnitSchema,
});
export type Threshold = z.infer<typeof ThresholdSchema>;

export const FinalMixBandsSchema = z.strictObject({
  beatSyncing: BandSchema,
  balance: BandSchema,
  phrasing: BandSchema,
  overall: BandSchema,
});

/** Wall-clock time, for scheduling only (never AudioContext time). */
export const IsoTimeSchema = z.iso.datetime({ offset: true });
