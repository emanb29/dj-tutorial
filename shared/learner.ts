// The Skill profile (docs/check-design.md §8–9) and the per-Learner record the server stores.
import { z } from "zod";
import { LESSON_IDS, type LessonId } from "./catalogue.ts";
import {
  CheckModeSchema,
  CriterionIdSchema,
  IsoTimeSchema,
  LessonIdSchema,
  type CriterionId,
} from "./check-types.ts";
import { MISSION_MAX_CHARS, MissionTagSchema } from "./mission.ts";
import { PLACEMENTS_KEPT, PlacementResultSchema } from "./placement.ts";

/** Lower-case letters, digits and dashes, so ids are safe in paths and file names. */
export const LearnerIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, {
    message: "A Learner id is 1–64 lower-case letters, digits or dashes, starting with a letter or digit.",
  });
export type LearnerId = z.infer<typeof LearnerIdSchema>;

/** The one Learner every fresh store starts with: the project owner. */
export const DEFAULT_LEARNER_ID: LearnerId = "default";

export const LEARNER_RECORD_SCHEMA_VERSION = 1;

const RetentionStepSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);

export const CriterionRecordSchema = z.strictObject({
  criterionId: CriterionIdSchema,
  lessonId: LessonIdSchema,
  last: z
    .strictObject({
      attemptId: z.string().min(1),
      at: IsoTimeSchema,
      mode: CheckModeSchema,
      status: z.enum(["met", "notMet"]),
      /** `null` when there was nothing to measure (e.g. a fade in that was never heard). */
      measured: z.number().nullable(),
    })
    .nullable(),
  best: z
    .strictObject({ attemptId: z.string().min(1), at: IsoTimeSchema, measured: z.number(), margin: z.number() })
    .nullable(),
  firstPassedAt: IsoTimeSchema.nullable(),
  passDates: z.array(IsoTimeSchema).max(20),
  consecutiveFails: z.int().nonnegative(),
  retention: z
    .strictObject({
      state: z.enum(["notPassed", "passed", "retained", "lapsed"]),
      step: RetentionStepSchema,
      nextDueAt: IsoTimeSchema.nullable(),
      lastColdPassAt: IsoTimeSchema.nullable(),
    })
    .nullable(),
  practice: z.strictObject({
    attempts: z.int().nonnegative(),
    met: z.int().nonnegative(),
    lastAt: IsoTimeSchema.nullable(),
  }),
});

export const LessonRecordSchema = z.strictObject({
  lessonId: LessonIdSchema,
  passedAt: IsoTimeSchema.nullable(),
  passedVia: z.enum(["lesson", "placement"]).nullable(),
  attempts: z.int().nonnegative(),
  reviewSuggestedAt: IsoTimeSchema.nullable(),
  reviewDeclinedAt: IsoTimeSchema.nullable(),
});

export const SkillProfileSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    learnerId: LearnerIdSchema,
    lessons: z.record(z.string(), LessonRecordSchema),
    criteria: z.record(z.string(), CriterionRecordSchema),
    courseCompletedAt: IsoTimeSchema.nullable(),
  })
  .superRefine((profile, context) => {
    // Keys must be the ids the records hold, so a lookup by id can never find the wrong record.
    for (const [key, record] of Object.entries(profile.lessons)) {
      if (!(LESSON_IDS as readonly string[]).includes(key) || key !== record.lessonId) {
        context.addIssue({
          code: "custom",
          path: ["lessons", key],
          message: `The key "${key}" must be the record's lessonId ("${record.lessonId}").`,
        });
      }
    }
    for (const [key, record] of Object.entries(profile.criteria)) {
      if (key !== record.criterionId) {
        context.addIssue({
          code: "custom",
          path: ["criteria", key],
          message: `The key "${key}" must be the record's criterionId ("${record.criterionId}").`,
        });
      }
    }
  })
  .transform(
    (profile) =>
      profile as typeof profile & {
        lessons: Partial<Record<LessonId, z.infer<typeof LessonRecordSchema>>>;
        criteria: Partial<Record<CriterionId, z.infer<typeof CriterionRecordSchema>>>;
      },
  );
export type SkillProfile = z.output<typeof SkillProfileSchema>;

/** The recording formats the final project's audio may be (what MediaRecorder gives in Chromium and Firefox). */
export const FINAL_PROJECT_MIME_TYPES = ["audio/webm", "audio/ogg", "audio/mp4"] as const;
export type FinalProjectMimeType = (typeof FINAL_PROJECT_MIME_TYPES)[number];
/** About 40 minutes at the recorder's 160 kbit/s; a set stops itself at 30. */
export const MAX_FINAL_PROJECT_BYTES = 48 * 1024 * 1024;
/** A set has at most 8 tracks (src/lessons SET_RULES), so 7 transitions; a few spare for re-entries. */
const FINAL_PROJECT_TRACKS_MAX = 8;
const FINAL_PROJECT_TRANSITIONS_MAX = 12;

const NoteText = z.string().max(300);

/**
 * The final project (docs/lesson-catalogue.md "Final project"): the recorded set the Learner kept,
 * with its track list and the Check's per-transition results. The audio itself is a file on the
 * server (`…/final-project/audio`), one per Learner.
 */
export const FinalProjectSchema = z.strictObject({
  attemptId: z.string().min(1).max(100),
  recordedAt: IsoTimeSchema,
  /** `lesson` = the first set (a rehearsal); `cold` = a re-pass, the final project proper (check-design C2). */
  mode: CheckModeSchema,
  outcome: z.enum(["passed", "failed"]),
  band: z.enum(["pass", "merit", "distinction"]).nullable(),
  durationSec: z.number().nonnegative(),
  audio: z.strictObject({ mimeType: z.enum(FINAL_PROJECT_MIME_TYPES), bytes: z.int().positive().max(MAX_FINAL_PROJECT_BYTES) }),
  tracks: z
    .array(z.strictObject({ title: NoteText, artist: NoteText, bpm: z.number().positive(), credit: NoteText, shareable: z.boolean() }))
    .min(1)
    .max(FINAL_PROJECT_TRACKS_MAX),
  transitions: z
    .array(
      z.strictObject({
        number: z.int().positive(),
        from: NoteText,
        to: NoteText,
        kind: z.enum(["cut", "blend", "unclassified"]),
        met: z.boolean(),
        phraseBeats: z.number().nullable(),
        levelDb: z.number().nullable(),
        phaseHold: z.number().nullable(),
      }),
    )
    .max(FINAL_PROJECT_TRANSITIONS_MAX),
});
export type FinalProject = z.output<typeof FinalProjectSchema>;

/** The optional "do it in rekordbox" cards (ISS-97): one per Lesson that has one, and the library set-up. */
export const REKORDBOX_CARD_IDS = ["cut-on-phrase", "sync-blend", "blend-by-ear", "final-mix", "library"] as const;
export const RekordboxCardIdSchema = z.enum(REKORDBOX_CARD_IDS);
export type RekordboxCardId = z.infer<typeof RekordboxCardIdSchema>;

/** What the Learner chose on a card, and when (wall clock). Never graded. */
export const RekordboxCardChoiceSchema = z.strictObject({ choice: z.enum(["done", "notNow"]), at: IsoTimeSchema });
export type RekordboxCardChoice = z.infer<typeof RekordboxCardChoiceSchema>;

/** Everything the server keeps for one Learner. */
export const LearnerRecordSchema = z
  .strictObject({
    schemaVersion: z.literal(LEARNER_RECORD_SCHEMA_VERSION),
    learnerId: LearnerIdSchema,
    /** The Learner's own words, trimmed. Sent to the Coach only inside the Curriculum job. */
    mission: z.string().max(MISSION_MAX_CHARS),
    missionTags: z.array(MissionTagSchema),
    /** `null` until the first Curriculum is built. */
    curriculum: z.array(LessonIdSchema).nullable(),
    /**
     * The one-time headphones check (split cue needs stereo headphones, not OS mono): when it passed.
     * Absent in records from before it existed.
     */
    headphones: z.strictObject({ checkedAt: IsoTimeSchema }).nullable().optional(),
    /** Every Placement run, oldest first (placement-design §8). Absent in records from before Placement. */
    placements: z.array(PlacementResultSchema).max(PLACEMENTS_KEPT).optional(),
    /** The set the Learner kept as their final project; absent until one is kept. */
    finalProject: FinalProjectSchema.optional(),
    /** The rekordbox cards answered so far; absent in records from before them. */
    rekordbox: z.partialRecord(RekordboxCardIdSchema, RekordboxCardChoiceSchema).optional(),
    skillProfile: SkillProfileSchema,
  })
  .superRefine((record, context) => {
    if (record.mission !== record.mission.trim()) {
      context.addIssue({ code: "custom", path: ["mission"], message: "Trim the Mission before saving it." });
    }
    if (record.skillProfile.learnerId !== record.learnerId) {
      context.addIssue({
        code: "custom",
        path: ["skillProfile", "learnerId"],
        message: `The Skill profile belongs to "${record.skillProfile.learnerId}", but the record is "${record.learnerId}". They must match.`,
      });
    }
  });
export type LearnerRecord = z.output<typeof LearnerRecordSchema>;

export function emptyLearnerRecord(learnerId: LearnerId): LearnerRecord {
  return {
    schemaVersion: LEARNER_RECORD_SCHEMA_VERSION,
    learnerId,
    mission: "",
    missionTags: [],
    curriculum: null,
    skillProfile: { schemaVersion: 1, learnerId, lessons: {}, criteria: {}, courseCompletedAt: null },
  };
}

/** The record after the headphones check passed at `checkedAt` (wall clock). */
export function withHeadphonesChecked(record: LearnerRecord, checkedAt: string): LearnerRecord {
  return { ...record, headphones: { checkedAt } };
}

/** The record with a rekordbox card answered at `at` (wall clock). */
export function withRekordboxChoice(record: LearnerRecord, card: RekordboxCardId, choice: RekordboxCardChoice["choice"], at: string): LearnerRecord {
  return { ...record, rekordbox: { ...record.rekordbox, [card]: { choice, at } } };
}

/**
 * The record with a new Skill profile (from `applyCheckResult`), checked against the schema the
 * server enforces, so a profile the server would refuse is caught before it is saved.
 */
export function withSkillProfile(
  record: LearnerRecord,
  skillProfile: unknown,
): { readonly ok: true; readonly record: LearnerRecord } | { readonly ok: false; readonly issues: readonly string[] } {
  const parsed = LearnerRecordSchema.safeParse({ ...record, skillProfile });
  return parsed.success ? { ok: true, record: parsed.data } : { ok: false, issues: describeIssues(parsed.error) };
}

/** The record with a new final project, checked against the schema the server enforces. */
export function withFinalProject(
  record: LearnerRecord,
  finalProject: FinalProject,
): { readonly ok: true; readonly record: LearnerRecord } | { readonly ok: false; readonly issues: readonly string[] } {
  const parsed = LearnerRecordSchema.safeParse({ ...record, finalProject });
  return parsed.success ? { ok: true, record: parsed.data } : { ok: false, issues: describeIssues(parsed.error) };
}

/** Formats every zod issue as "path: message", so a caller sees all problems at once. */
export function describeIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join(".");
    return path === "" ? issue.message : `${path}: ${issue.message}`;
  });
}
