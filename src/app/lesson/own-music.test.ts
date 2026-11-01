import { describe, expect, it } from "vitest";
import { lessonDefinition, SYNTHETIC_HOUSE, SYNTHETIC_PARTNER, syntheticLessonTrack, type LessonTrack } from "@lessons";
import { pickOwnTracks, type OwnTrack } from "./own-music.ts";
import { seededRandom } from "./track-rotation.ts";

const house = syntheticLessonTrack(SYNTHETIC_HOUSE);
const partner = syntheticLessonTrack(SYNTHETIC_PARTNER);
const short: LessonTrack = { ...house, trackId: "short", phraseStarts: house.phraseStarts.slice(0, 2), durationSec: 40 };

function own(track: LessonTrack, camelot: string | null = null, audio = track.trackId): OwnTrack<string> & { prepared: () => number } {
  let prepared = 0;
  return {
    key: track.trackId,
    sketch: track,
    camelot,
    prepare: () => {
      prepared += 1;
      return Promise.resolve({ track, audio });
    },
    prepared: () => prepared,
  };
}

describe("pickOwnTracks", () => {
  const random = seededRandom(1);

  it("takes one of the Learner's tracks that passes the Lesson's track check", async () => {
    const picked = await pickOwnTracks(lessonDefinition("gain-staging"), [own(short), own(house)], random);
    expect(picked).toMatchObject({ ok: true, ready: { track: { trackId: house.trackId }, audio: house.trackId } });
  });

  it("pairs a partner for B whose tempo fits a two-track Lesson", async () => {
    const picked = await pickOwnTracks(lessonDefinition("sync-blend"), [own(house), own(partner)], random);
    expect(picked.ok).toBe(true);
    if (!picked.ok) return;
    expect([picked.ready.track.trackId, picked.ready.track.partner?.trackId].toSorted()).toEqual([house.trackId, partner.trackId].toSorted());
    expect(picked.ready.partnerAudio).toBe(picked.ready.track.partner?.trackId);
  });

  it("says why when none fits: the Lesson's own words", async () => {
    const picked = await pickOwnTracks(lessonDefinition("gain-staging"), [own(short)], random);
    expect(picked).toEqual({ ok: false, reason: expect.stringMatching(/^None of your tracks fit this Lesson: .+/) as unknown });
  });

  it("needs tracks whose grid is ready", async () => {
    const picked = await pickOwnTracks(lessonDefinition("deck-basics"), [], random);
    expect(picked).toEqual({ ok: false, reason: expect.stringMatching(/^None of your tracks has a beat grid yet/) as unknown });
  });

  it("decodes only tracks that fit on paper: a large library costs no decodes for the rest", async () => {
    const library = Array.from({ length: 500 }, (_, index) => own({ ...short, trackId: `short-${String(index)}` }));
    const fits = own(house);
    const picked = await pickOwnTracks(lessonDefinition("gain-staging"), [...library, fits], random);
    expect(picked.ok).toBe(true);
    expect(library.every((track) => track.prepared() === 0)).toBe(true);
    expect(fits.prepared()).toBe(1);
  });

  it("tries a partner whose key mixes with A's first", async () => {
    const clash = own({ ...partner, trackId: "clash" }, "3B");
    const mixes = own({ ...partner, trackId: "mixes" }, "9A");
    // Only the house track may go on A, so every pick is about B.
    const houseOnA = { ...lessonDefinition("sync-blend"), trackProblems: (track: LessonTrack) => (track.trackId === house.trackId ? [] : ["not deck A"]) };
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const picked = await pickOwnTracks(houseOnA, [own(house, "8A"), clash, mixes], seededRandom(seed));
      expect(picked.ok && picked.ready.track.partner?.trackId).toBe("mixes");
    }
  });

  it("keeps the app's tracks for a Lesson that asks about named sections, without preparing any", async () => {
    const mine = own(house);
    const picked = await pickOwnTracks(lessonDefinition("phrases"), [mine], random);
    expect(picked.ok).toBe(false);
    expect(mine.prepared()).toBe(0);
  });
});
