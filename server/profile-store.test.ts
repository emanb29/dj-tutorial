import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LearnerRecordSchema, describeIssues, emptyLearnerRecord } from "@shared/learner.ts";
import { ProfileStore, ProfileStoreError } from "./profile-store.ts";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "ltd-profiles-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("ProfileStore", () => {
  it("starts with one default Learner and writes it to disk", async () => {
    const store = await ProfileStore.open(dataDir);

    expect(store.get("default")).toEqual(emptyLearnerRecord("default"));
    const onDisk = JSON.parse(await readFile(join(dataDir, "profiles.json"), "utf8")) as unknown;
    expect(onDisk).toEqual({ schemaVersion: 1, learners: { default: emptyLearnerRecord("default") } });
  });

  it("keeps a saved record across a restart", async () => {
    const store = await ProfileStore.open(dataDir);
    const record = { ...emptyLearnerRecord("default"), mission: "post my own mixes to SoundCloud" };

    await store.put(record);
    const reopened = await ProfileStore.open(dataDir);

    expect(reopened.get("default")).toEqual(record);
  });

  it("adds a second Learner without touching the first", async () => {
    const store = await ProfileStore.open(dataDir);

    await store.put(emptyLearnerRecord("guest-2"));

    expect(store.has("default")).toBe(true);
    expect((await ProfileStore.open(dataDir)).get("guest-2")).toEqual(emptyLearnerRecord("guest-2"));
  });

  it("leaves no temp files behind after concurrent writes, and the last write wins", async () => {
    const store = await ProfileStore.open(dataDir);
    const missions = ["one", "two", "three", "four"];

    await Promise.all(missions.map((mission) => store.put({ ...emptyLearnerRecord("default"), mission })));

    expect(await readdir(dataDir)).toEqual(["profiles.json"]);
    expect((await ProfileStore.open(dataDir)).get("default")?.mission).toBe("four");
  });

  it("refuses to start on a corrupt file and leaves it untouched", async () => {
    const path = join(dataDir, "profiles.json");
    await writeFile(path, "{ not json");

    await expect(ProfileStore.open(dataDir)).rejects.toBeInstanceOf(ProfileStoreError);
    expect(await readFile(path, "utf8")).toBe("{ not json");
  });

  it("refuses a file with another schema version, listing every problem", async () => {
    await writeFile(
      join(dataDir, "profiles.json"),
      JSON.stringify({ schemaVersion: 2, learners: { default: { learnerId: "other" } } }),
    );

    const error: unknown = await ProfileStore.open(dataDir).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProfileStoreError);
    expect((error as ProfileStoreError).problems.length).toBeGreaterThan(1);
    expect((error as ProfileStoreError).problems[0]).toMatch(/^schemaVersion:/);
  });
});

describe("LearnerRecord validation", () => {
  it("collects every problem, each with its path", () => {
    const record = {
      ...emptyLearnerRecord("default"),
      mission: "x".repeat(281),
      missionTags: ["clubbing"],
      curriculum: ["not-a-lesson"],
      skillProfile: { ...emptyLearnerRecord("other").skillProfile, courseCompletedAt: "yesterday" },
    };

    const result = LearnerRecordSchema.safeParse(record);

    expect(result.success).toBe(false);
    if (result.success) return;
    const paths = describeIssues(result.error).map((issue) => issue.split(":")[0]);
    expect(paths).toEqual(["mission", "missionTags.0", "curriculum.0", "skillProfile.courseCompletedAt"]);
  });

  it("rejects a Skill profile that belongs to another Learner", () => {
    const record = { ...emptyLearnerRecord("default"), skillProfile: emptyLearnerRecord("other").skillProfile };

    const result = LearnerRecordSchema.safeParse(record);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(describeIssues(result.error)).toEqual([
      'skillProfile.learnerId: The Skill profile belongs to "other", but the record is "default". They must match.',
    ]);
  });
});
