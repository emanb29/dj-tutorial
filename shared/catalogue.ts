// The Lesson catalogue (docs/lesson-catalogue.md, v1 adopted): fixed content, never generated at runtime.
// Ids, titles, prerequisites and skip groups here must match that document.

/** Every Lesson id, in catalogue order (§1). */
export const LESSON_IDS = [
  "deck-basics",
  "beats-and-bars",
  "phrases",
  "gain-staging",
  "headphone-cue",
  "cue-point",
  "cut-on-phrase",
  "tempo-fader",
  "sync-blend",
  "crossfader",
  "eq-basics",
  "bass-swap",
  "filter-transition",
  "nudge-phase",
  "tempo-by-ear",
  "blend-by-ear",
  "hot-cues",
  "loop-transition",
  "echo-out",
  "final-mix",
] as const;

export type LessonId = (typeof LESSON_IDS)[number];

/** The Lessons off the critical path (catalogue Q11). The Coach chooses where they go. */
export const ELECTIVE_IDS = [
  "crossfader",
  "filter-transition",
  "hot-cues",
  "loop-transition",
  "echo-out",
] as const satisfies readonly LessonId[];

export type ElectiveId = (typeof ELECTIVE_IDS)[number];

export const SKIP_GROUP_IDS = ["timing", "foundations", "syncMixing", "byEar"] as const;
export type SkipGroupId = (typeof SKIP_GROUP_IDS)[number];

export type LcmeCode = "L1" | "L2" | "L3" | "L4" | "L5" | "L6" | "L7";

export interface Lesson {
  readonly id: LessonId;
  readonly title: string;
  readonly concepts: readonly string[];
  readonly prerequisites: readonly LessonId[];
  /** `null` for electives and `final-mix`: Placement never skips them as a group. */
  readonly skipGroup: SkipGroupId | null;
  readonly lcme: readonly LcmeCode[];
}

export const FINAL_LESSON_ID = "final-mix" satisfies LessonId;

/** The catalogue, in catalogue order. */
export const LESSONS: readonly Lesson[] = [
  { id: "deck-basics", title: "Play a track out loud", concepts: ["Deck", "channel fader"], prerequisites: [], skipGroup: "foundations", lcme: ["L2"] },
  { id: "beats-and-bars", title: "Find the beat and the one", concepts: ["Beat", "bar / downbeat"], prerequisites: ["deck-basics"], skipGroup: "timing", lcme: ["L1"] },
  { id: "phrases", title: "Count phrases", concepts: ["Phrase", "track structure (intro, breakdown, drop, outro)"], prerequisites: ["beats-and-bars"], skipGroup: "timing", lcme: ["L1", "L4"] },
  { id: "gain-staging", title: "Set the level", concepts: ["Trim", "channel level meter, clipping"], prerequisites: ["deck-basics"], skipGroup: "foundations", lcme: ["L6"] },
  { id: "headphone-cue", title: "Listen before they hear it", concepts: ["Headphone cue", "cue/master mix (split cue)"], prerequisites: ["deck-basics"], skipGroup: "foundations", lcme: ["L2", "L5"] },
  { id: "cue-point", title: "Set a cue point by ear", concepts: ["Cue point"], prerequisites: ["beats-and-bars", "headphone-cue"], skipGroup: "foundations", lcme: ["L3"] },
  { id: "cut-on-phrase", title: "Your first transition: the cut", concepts: ["Cut (drop mix)", "phrasing"], prerequisites: ["phrases", "gain-staging", "cue-point"], skipGroup: "foundations", lcme: ["L4", "L7"] },
  { id: "tempo-fader", title: "Speed and pitch", concepts: ["Tempo fader and BPM", "Master Tempo"], prerequisites: ["deck-basics"], skipGroup: "syncMixing", lcme: ["L2", "L5"] },
  { id: "sync-blend", title: "Blend with sync", concepts: ["Beat Sync", "blend over a phrase"], prerequisites: ["cut-on-phrase", "tempo-fader"], skipGroup: "syncMixing", lcme: ["L4", "L7"] },
  { id: "crossfader", title: "The crossfader", concepts: ["Crossfader"], prerequisites: ["sync-blend"], skipGroup: null, lcme: ["L2", "L7"] },
  { id: "eq-basics", title: "Shape the sound with EQ", concepts: ["EQ (HI/MID/LOW)", "cutting, not boosting"], prerequisites: ["gain-staging", "phrases"], skipGroup: "syncMixing", lcme: ["L6"] },
  { id: "bass-swap", title: "Swap the bass", concepts: ["EQ mixing", "bass swap"], prerequisites: ["eq-basics", "sync-blend"], skipGroup: "syncMixing", lcme: ["L4", "L6"] },
  { id: "filter-transition", title: "The filter", concepts: ["Filter (CFX knob: HPF/LPF)", "filter transition"], prerequisites: ["eq-basics", "sync-blend"], skipGroup: null, lcme: ["L6"] },
  { id: "nudge-phase", title: "Nudge it back in line", concepts: ["Pitch bend with the jog wheel", "phase"], prerequisites: ["cut-on-phrase", "tempo-fader"], skipGroup: "byEar", lcme: ["L5"] },
  { id: "tempo-by-ear", title: "Match tempo by ear", concepts: ["Hearing which deck is faster", "correcting with the tempo fader"], prerequisites: ["nudge-phase"], skipGroup: "byEar", lcme: ["L5"] },
  { id: "blend-by-ear", title: "A full blend by ear", concepts: ["Holding a long blend", "recovering drift"], prerequisites: ["tempo-by-ear", "bass-swap"], skipGroup: "byEar", lcme: ["L4", "L5", "L6"] },
  { id: "hot-cues", title: "Hot cues", concepts: ["Hot cue (pads in Hot Cue mode)"], prerequisites: ["cue-point", "phrases"], skipGroup: null, lcme: ["L3"] },
  { id: "loop-transition", title: "Loop to buy time", concepts: ["Loop (4-beat auto loop, loop in/out)", "loop transition"], prerequisites: ["sync-blend", "phrases"], skipGroup: null, lcme: [] },
  { id: "echo-out", title: "The echo out", concepts: ["Beat FX ECHO", "echo out"], prerequisites: ["cut-on-phrase", "sync-blend"], skipGroup: null, lcme: ["L7"] },
  { id: "final-mix", title: "Your first set", concepts: ["Prepared mix", "choosing tracks that mix well"], prerequisites: ["blend-by-ear", "cut-on-phrase"], skipGroup: null, lcme: ["L1", "L2", "L3", "L4", "L5", "L6", "L7"] },
];

const lessonsById = new Map<LessonId, Lesson>(LESSONS.map((lesson) => [lesson.id, lesson]));

export function lessonById(id: LessonId): Lesson {
  const lesson = lessonsById.get(id);
  // Unreachable while LESSONS covers LESSON_IDS, which the catalogue tests assert.
  if (lesson === undefined) throw new Error(`Lesson "${id}" is missing from LESSONS.`);
  return lesson;
}

const electiveSet: ReadonlySet<LessonId> = new Set(ELECTIVE_IDS);

export function isElective(id: LessonId): id is ElectiveId {
  return electiveSet.has(id);
}

/** Every Lesson that is not an elective, in catalogue order. `final-mix` is last. */
export const REQUIRED_LESSON_IDS: readonly LessonId[] = LESSON_IDS.filter((id) => !isElective(id));

/** The catalogue position of a Lesson, for tie-breaking by catalogue order. */
export function catalogueIndex(id: LessonId): number {
  return LESSON_IDS.indexOf(id);
}
