import { describe, expect, it } from "vitest";
import { lessonDefinition, SYNTHETIC_HOUSE, SYNTHETIC_PARTNER, syntheticLessonTrack, type LessonTrack } from "@lessons";
import { pickOwnTracks, type OwnTrack } from "./own-music.ts";
import { seededRandom } from "./track-rotation.ts";

const house = syntheticLessonTrack(SYNTHETIC_HOUSE);
const partner = syntheticLessonTrack(SYNTHETIC_PARTNER);
const short: LessonTrack = { ...house, trackId: "short", phraseStarts: house.phraseStarts.slice(0, 2), durationSec: 40 };

function own(track: LessonTrack, audio = track.trackId): OwnTrack<string> & { prepared: () => number } {
  let prepared = 0;
  return {
    key: track.trackId,
    bpm: track.grid.bpm,
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

  it("needs a music folder with analysed tracks", async () => {
    expect(await pickOwnTracks(lessonDefinition("deck-basics"), [], random)).toEqual({ ok: false, reason: "No tracks from your music folder yet: pick it on the Controller page." });
  });

  it("keeps the app's tracks for a Lesson that asks about named sections, without preparing any", async () => {
    const mine = own(house);
    const picked = await pickOwnTracks(lessonDefinition("phrases"), [mine], random);
    expect(picked.ok).toBe(false);
    expect(mine.prepared()).toBe(0);
  });
});
