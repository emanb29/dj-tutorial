// The final project's audio (docs/lesson-catalogue.md "Final project"): the master recording of the
// Learner's set, one file per Learner, replaced by the next one kept. The metadata (track list,
// per-transition results) lives in the Learner's record; only the audio is here. Storage is bounded:
// one file per Learner (the profile store caps Learners) of at most MAX_FINAL_PROJECT_BYTES.
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { LearnerId } from "@shared/learner.ts";
import { FINAL_PROJECT_MIME_TYPES, MAX_FINAL_PROJECT_BYTES } from "@shared/learner.ts";
import { SerialQueue, readJsonIfPresent, writeJsonAtomic } from "./json-file.ts";

export const FINAL_PROJECTS_DIR = "final-projects";

const AudioMetaSchema = z.strictObject({
  mimeType: z.enum(FINAL_PROJECT_MIME_TYPES),
  bytes: z.int().positive().max(MAX_FINAL_PROJECT_BYTES),
  savedAt: z.string(),
});
export type FinalProjectAudioMeta = z.infer<typeof AudioMetaSchema>;

export class FinalProjectStore {
  private readonly writes = new SerialQueue();

  constructor(
    private readonly directory: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  static forDataDir(dataDir: string, now?: () => Date): FinalProjectStore {
    return new FinalProjectStore(join(dataDir, FINAL_PROJECTS_DIR), now);
  }

  private audioPath(learnerId: LearnerId): string {
    return join(this.directory, `${learnerId}.audio`);
  }

  private metaPath(learnerId: LearnerId): string {
    return join(this.directory, `${learnerId}.json`);
  }

  /** Keeps `bytes` as the Learner's final project, replacing any earlier one. */
  put(learnerId: LearnerId, mimeType: FinalProjectAudioMeta["mimeType"], bytes: Uint8Array): Promise<FinalProjectAudioMeta> {
    return this.writes.run(async () => {
      await mkdir(this.directory, { recursive: true });
      const temporary = join(this.directory, `.${randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(temporary, this.audioPath(learnerId));
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
      const meta: FinalProjectAudioMeta = { mimeType, bytes: bytes.byteLength, savedAt: this.now().toISOString() };
      await writeJsonAtomic(this.metaPath(learnerId), meta);
      return meta;
    });
  }

  /** The Learner's final project audio, or undefined when none was kept. */
  async get(learnerId: LearnerId): Promise<{ readonly meta: FinalProjectAudioMeta; readonly bytes: Buffer } | undefined> {
    const raw = await readJsonIfPresent(this.metaPath(learnerId));
    if (raw === undefined) return undefined;
    const meta = AudioMetaSchema.parse(raw);
    return { meta, bytes: await readFile(this.audioPath(learnerId)) };
  }
}
