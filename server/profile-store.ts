import { join } from "node:path";
import { z } from "zod";
import {
  DEFAULT_LEARNER_ID,
  LearnerRecordSchema,
  describeIssues,
  emptyLearnerRecord,
  type LearnerId,
  type LearnerRecord,
} from "@shared/learner.ts";
import { SerialQueue, readJsonIfPresent, writeJsonAtomic } from "./json-file.ts";

export const PROFILE_STORE_SCHEMA_VERSION = 1;
export const PROFILE_STORE_FILE = "profiles.json";
/** Bounds the file, which is rewritten whole on every save. A local app has few Learners. */
export const MAX_LEARNERS = 16;

const ProfileStoreFileSchema = z
  .strictObject({
    schemaVersion: z.literal(PROFILE_STORE_SCHEMA_VERSION),
    learners: z.record(z.string(), LearnerRecordSchema),
  })
  .superRefine((file, context) => {
    for (const [key, record] of Object.entries(file.learners)) {
      if (key !== record.learnerId) {
        context.addIssue({
          code: "custom",
          path: ["learners", key],
          message: `The key "${key}" must be the record's learnerId ("${record.learnerId}").`,
        });
      }
    }
  });

export class ProfileStoreError extends Error {
  override readonly name = "ProfileStoreError";

  constructor(
    readonly path: string,
    readonly problems: readonly string[],
  ) {
    super(
      `The profile store ${path} cannot be read, so the server will not start (it never overwrites data it cannot read).\n- ${problems.join("\n- ")}\nFix the file by hand, or move it aside to start with an empty store.`,
    );
  }
}

/**
 * Every Learner's record, on disk as one schema-versioned JSON file, written atomically.
 * A fresh store holds one default Learner.
 */
export class ProfileStore {
  private readonly writes = new SerialQueue();

  private constructor(
    private readonly path: string,
    private learners: Readonly<Record<LearnerId, LearnerRecord>>,
  ) {}

  static async open(dataDir: string): Promise<ProfileStore> {
    const path = join(dataDir, PROFILE_STORE_FILE);
    let raw: unknown;
    try {
      raw = await readJsonIfPresent(path);
    } catch (error) {
      throw new ProfileStoreError(path, [error instanceof Error ? error.message : String(error)]);
    }
    if (raw === undefined) {
      const store = new ProfileStore(path, { [DEFAULT_LEARNER_ID]: emptyLearnerRecord(DEFAULT_LEARNER_ID) });
      await store.persist(store.learners);
      return store;
    }
    const parsed = ProfileStoreFileSchema.safeParse(raw);
    if (!parsed.success) throw new ProfileStoreError(path, describeIssues(parsed.error));
    return new ProfileStore(path, parsed.data.learners);
  }

  get(learnerId: LearnerId): LearnerRecord | undefined {
    return this.learners[learnerId];
  }

  has(learnerId: LearnerId): boolean {
    return learnerId in this.learners;
  }

  /** `true` once the store holds `MAX_LEARNERS`; no new Learner can be added then. */
  get isFull(): boolean {
    return Object.keys(this.learners).length >= MAX_LEARNERS;
  }

  /** Creates or replaces one Learner's record. Resolves once the file is on disk. */
  put(record: LearnerRecord): Promise<void> {
    return this.writes.run(async () => {
      const next = { ...this.learners, [record.learnerId]: record };
      await this.persist(next);
      this.learners = next;
    });
  }

  private persist(learners: Readonly<Record<LearnerId, LearnerRecord>>): Promise<void> {
    return writeJsonAtomic(this.path, { schemaVersion: PROFILE_STORE_SCHEMA_VERSION, learners });
  }
}
