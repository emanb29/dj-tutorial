// What a Placement run leaves behind (docs/placement-design.md §8), stored on the Learner's record
// next to, never inside, the Skill profile. The server validates it with these schemas.
//
// One difference from the design's types: a task keeps a reduced Check result (each criterion's
// status, not the full measurements and evidence). The full `CheckResult` is written to the Skill
// profile when Placement ends; what stays here is what `creditedLessons` reads.
import { z } from "zod";
import { SKIP_GROUP_IDS } from "./catalogue.ts";
import { CriterionIdSchema, IsoTimeSchema, LessonIdSchema } from "./check-types.ts";
import { MISSION_MAX_CHARS } from "./mission.ts";

/** At most this many tasks run in one Placement (placement-design §3 rule 4). */
export const PLACEMENT_TASK_CAP = 6;
/** No new task starts after this many seconds from the first hook (§3 rule 4). */
export const PLACEMENT_TIME_CAP_S = 360;
/** Placements kept on the record, newest last. */
export const PLACEMENTS_KEPT = 20;

export const PlacementCheckSchema = z.strictObject({
  attemptId: z.string().min(1),
  endedAt: IsoTimeSchema,
  outcome: z.enum(["passed", "failed"]),
  criteria: z
    .array(z.strictObject({ id: CriterionIdSchema, status: z.enum(["met", "notMet", "notApplicable"]) }))
    .max(64),
});
export type PlacementCheck = z.infer<typeof PlacementCheckSchema>;

export const PlacementTaskRecordSchema = z.strictObject({
  lessonId: LessonIdSchema,
  groupId: z.enum(SKIP_GROUP_IDS),
  step: z.enum(["group", "narrowing"]),
  /** `notYet`: the Learner pressed Not yet, or the task voided twice. */
  outcome: z.enum(["passed", "failed", "notYet"]),
  /** The non-void attempt; null for `notYet`. */
  checkResult: PlacementCheckSchema.nullable(),
  voidRuns: z.union([z.literal(0), z.literal(1), z.literal(2)]),
});
export type PlacementTaskRecord = z.infer<typeof PlacementTaskRecordSchema>;

export const PLACEMENT_END_REASONS = ["noTaskLeft", "skippedAtMission", "skippedRest", "taskCap", "timeCap"] as const;
export type PlacementEndReason = (typeof PLACEMENT_END_REASONS)[number];

export const PlacementResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  placementId: z.string().min(1).max(64),
  learnerId: z.string().min(1).max(64),
  run: z.enum(["first", "retake"]),
  /** Wall clock: the budget and scheduling only, never compared with AudioContext time. */
  startedAt: IsoTimeSchema,
  endedAt: IsoTimeSchema,
  endReason: z.enum(PLACEMENT_END_REASONS),
  mission: z.string().max(MISSION_MAX_CHARS),
  tasks: z.array(PlacementTaskRecordSchema).max(PLACEMENT_TASK_CAP),
});
export type PlacementResult = z.infer<typeof PlacementResultSchema>;
