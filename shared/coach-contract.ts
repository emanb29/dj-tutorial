// The Coach endpoint contract (docs/coach-design.md §3), shared by the browser and the server.
// The server validates every request body with these schemas.
import { z } from "zod";
import { ELECTIVE_IDS, LESSON_IDS, type ElectiveId, type LessonId } from "./catalogue.ts";
import {
  CheckModeSchema,
  CriterionIdSchema,
  FinalMixBandsSchema,
  LessonIdSchema,
  SeveritySchema,
  ThresholdSchema,
  UnitSchema,
} from "./check-types.ts";
import { MISSION_MAX_CHARS, MissionTagSchema, type MissionTag } from "./mission.ts";

export const COACH_CRITERIA_MAX = 12;
export const COACH_METRICS_MAX = 32;
export const RECENT_LINES_MAX = 5;

export const CoachCriterionSchema = z.strictObject({
  id: CriterionIdSchema,
  severity: SeveritySchema,
  status: z.enum(["met", "notMet"]),
  measured: z.number(),
  unit: UnitSchema,
  threshold: ThresholdSchema.nullable(),
  margin: z.number().nullable(),
});
export type CoachCriterion = z.infer<typeof CoachCriterionSchema>;

/** The reduced CheckResult that leaves the browser (coach-design §5). Void results are never sent. */
export const CoachCheckSummarySchema = z.strictObject({
  lessonId: LessonIdSchema,
  mode: CheckModeSchema,
  variant: z.enum(["full", "short"]),
  outcome: z.enum(["passed", "failed"]),
  bands: FinalMixBandsSchema.optional(),
  criteria: z.array(CoachCriterionSchema).max(COACH_CRITERIA_MAX),
  metrics: z
    .record(z.string().max(64), z.number())
    .refine((metrics) => Object.keys(metrics).length <= COACH_METRICS_MAX, {
      message: `At most ${String(COACH_METRICS_MAX)} metrics.`,
    }),
});
export type CoachCheckSummary = z.infer<typeof CoachCheckSummarySchema>;

const RequestIdSchema = z.uuid();

export const CurriculumRequestSchema = z.strictObject({
  job: z.literal("curriculum").optional(),
  requestId: RequestIdSchema,
  mission: z
    .string()
    .transform((mission) => mission.trim())
    .pipe(
      z.string().max(MISSION_MAX_CHARS, {
        message: `The Mission is at most ${String(MISSION_MAX_CHARS)} characters after trimming. Shorten it.`,
      }),
    ),
  demonstrated: z
    .array(LessonIdSchema)
    .max(LESSON_IDS.length)
    .refine((ids) => new Set(ids).size === ids.length, { message: "List each demonstrated Lesson once." }),
  placementResults: z.array(CoachCheckSummarySchema).max(12),
  reason: z.enum(["placement", "skipGroupPassed"]),
});
export type CurriculumRequest = z.infer<typeof CurriculumRequestSchema>;

export const CheckLineRequestSchema = z.strictObject({
  job: z.literal("checkLine").optional(),
  requestId: RequestIdSchema,
  result: CoachCheckSummarySchema,
  context: z.strictObject({
    lessonTitle: z.string().min(1).max(80),
    focusHistory: z.array(z.number()).max(3),
    bestMarginBefore: z.number().nullable(),
    retentionChange: z.string().max(80).nullable(),
    attemptToday: z.int().positive().max(10_000),
    missionTags: z.array(MissionTagSchema).max(8),
    recentLines: z.array(z.string().max(200)).max(RECENT_LINES_MAX),
  }),
});
export type CheckLineRequest = z.infer<typeof CheckLineRequestSchema>;

/** Why the deterministic result was used instead of a model's. */
export const FALLBACK_REASONS = [
  "noKey",
  "budgetCap",
  "rateLimited",
  "timeout",
  "apiError",
  "refusal",
  "invalidOutput",
] as const;
export type FallbackReason = (typeof FALLBACK_REASONS)[number];

export interface CurriculumData {
  readonly job: "curriculum";
  readonly curriculum: readonly LessonId[];
  readonly missionTags: readonly MissionTag[];
  readonly electiveNotes: Partial<Record<ElectiveId, string>>;
}

export interface CheckLineData {
  readonly job: "checkLine";
  readonly line: string;
}

export interface WarmData {
  readonly job: "warm";
}

export type CoachData = CurriculumData | CheckLineData | WarmData;

/** A late, failed or invalid model call is still a success: the deterministic data is the answer. */
export type CoachSuccess<Data extends CoachData> =
  | { readonly success: true; readonly source: "llm"; readonly data: Data; readonly model: string; readonly latencyMs: number }
  | { readonly success: true; readonly source: "fallback"; readonly data: Data; readonly fallbackReason: FallbackReason };

/** The model's Curriculum output. The enums come from the catalogue, so ids outside it cannot appear. */
export const ElectiveIdSchema = z.enum(ELECTIVE_IDS);
export const CurriculumOutputSchema = z.strictObject({
  missionTags: z.array(MissionTagSchema),
  electives: z.array(
    z.strictObject({
      lessonId: ElectiveIdSchema,
      include: z.boolean(),
      placeAfter: LessonIdSchema,
      why: z.string(),
    }),
  ),
});
export type CurriculumOutput = z.infer<typeof CurriculumOutputSchema>;

export const learnerPaths = {
  profile: (learnerId: string) => `/api/learners/${learnerId}/profile`,
  export: (learnerId: string) => `/api/learners/${learnerId}/export`,
  curriculum: (learnerId: string) => `/api/learners/${learnerId}/coach/curriculum`,
  line: (learnerId: string) => `/api/learners/${learnerId}/coach/line`,
  warm: (learnerId: string) => `/api/learners/${learnerId}/coach/warm`,
} as const;
