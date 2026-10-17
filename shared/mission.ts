import { z } from "zod";

/** The Mission is capped to bound cost and limit prompt injection (coach-design K2). */
export const MISSION_MAX_CHARS = 280;

export const MISSION_TAGS = [
  "record-mixes",
  "edits",
  "live-parties",
  "radio-or-stream",
  "genre-house",
  "genre-techno",
  "genre-garage",
  "other",
] as const;

export const MissionTagSchema = z.enum(MISSION_TAGS);
export type MissionTag = z.infer<typeof MissionTagSchema>;
