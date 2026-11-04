// Every name below is synthetic: made-up artists and titles in the shapes real downloader file
// names take. Never paste a real library's names here (the repo is public).
import { describe, expect, it } from "vitest";
import { NAME_PARSER_VERSION, parseTrackName, type NameParse, type NameParseInput } from "./name-parse.ts";

const parse = (rawName: string, extra: Omit<NameParseInput, "rawName"> = {}): NameParse => parseTrackName({ rawName, ...extra });

interface Expected {
  readonly artist?: string | null;
  readonly originalArtist?: string | null;
  readonly title?: string;
  readonly remixer?: string | null;
  readonly mixKind?: string | null;
  readonly featuring?: string | null;
  readonly flags?: readonly string[];
  readonly sourceId?: string | null;
  readonly artistBand?: string;
  readonly originalArtistBand?: string;
}

function summary(result: NameParse): Required<Expected> {
  return {
    artist: result.artist?.value ?? null,
    originalArtist: result.originalArtist?.value ?? null,
    title: result.title.value,
    remixer: result.remixer?.value ?? null,
    mixKind: result.mixKind?.value ?? null,
    featuring: result.featuring?.value ?? null,
    flags: result.flags.map((flag) => flag.flag),
    sourceId: result.sourceId?.value ?? null,
    artistBand: result.artist?.band ?? "none",
    originalArtistBand: result.originalArtist?.band ?? "none",
  };
}

const SHAPES: readonly [string, Expected][] = [
  // Artist - Title (X Remix) [id]: the common downloader shape. A remix is the remixer's track: X is
  // the artist, and the name's artist is the original artist. Edits, bootlegs, flips, VIPs, re-works
  // and mashups by X are X's too; the clean title keeps "(X Remix)".
  ["Moss Harbor - Glass Rivers (Tinwhistle Remix) [1234567890]", { artist: "Tinwhistle", originalArtist: "Moss Harbor", title: "Glass Rivers (Tinwhistle Remix)", remixer: "Tinwhistle", mixKind: "remix", sourceId: "1234567890", artistBand: "high" }],
  // No artist at all: the title is the whole name, the ID still comes off.
  ["Paper Lanterns [987654321]", { artist: null, title: "Paper Lanterns", sourceId: "987654321" }],
  // Remix in square brackets plus bare "Free Download": the remix stays (in DJ form), the junk goes.
  ["Quiet Hours [Velo X Krane Remix] Free Download [1133500001]", { artist: "Velo X Krane", originalArtist: null, title: "Quiet Hours (Velo X Krane Remix)", remixer: "Velo X Krane", mixKind: "remix", flags: ["free-download"] }],
  // Title (Flip) - Artist ft. Guest: reversed, so medium at best.
  ["Night Bus (Orrin Flip) - Della Vane ft. Kip Rowe [Free Download] [1926700001]", { artist: "Orrin", originalArtist: "Della Vane", title: "Night Bus (Orrin Flip)", remixer: "Orrin", mixKind: "flip", featuring: "Kip Rowe", flags: ["free-download"], artistBand: "high", originalArtistBand: "medium" }],
  // Two mixes: the outer (last) one is the version; both stay in the title.
  ["Brook & Lane - Cool Water (Arlo Remix) (Fennick Edit) [1691400001]", { artist: "Fennick", originalArtist: "Brook & Lane", title: "Cool Water (Arlo Remix) (Fennick Edit)", remixer: "Fennick", mixKind: "edit" }],
  // Bare feat inside the title, then bootleg, then bare FREE DL.
  ["Ravel & Kit Moss - Saltbox Ft. Brannock (Mosey Bootleg) FREE DL [1857200001]", { artist: "Mosey", originalArtist: "Ravel & Kit Moss", title: "Saltbox Ft. Brannock (Mosey Bootleg)", featuring: "Brannock", remixer: "Mosey", mixKind: "bootleg", flags: ["free-download"] }],
  // feat. in the artist side goes to featuring, out of the artist.
  ["Harbor Kings feat. Ollo & Dray - No Signal (FREAKY ON REMIX) [1742300001]", { artist: "FREAKY ON", originalArtist: "Harbor Kings", featuring: "Ollo & Dray", title: "No Signal (FREAKY ON REMIX)", remixer: "FREAKY ON", mixKind: "remix" }],
  // A style word before "Remix" is not the remixer.
  ["Fold - Grumbler (Kris Elwin & CH4N Techno Remix) [1422400001]", { artist: "Kris Elwin & CH4N", originalArtist: "Fold", artistBand: "medium", remixer: "Kris Elwin & CH4N", mixKind: "remix", title: "Grumbler (Kris Elwin & CH4N Techno Remix)" }],
  ["Coastline - Back Home (Trance Remix) [FREE DL] [2217500001]", { remixer: null, mixKind: "remix", title: "Back Home (Trance Remix)", flags: ["free-download"] }],
  // Spaced dash before the mix group, a separator with nothing but the group after it.
  ["Mr.Velvet - Before Noon - (LAUWERS Remix) [1474300001]", { artist: "LAUWERS", originalArtist: "Mr.Velvet", title: "Before Noon (LAUWERS Remix)", remixer: "LAUWERS" }],
  // A dash inside the mix group is not a separator.
  ["Treble Talk X Knees X Chef (C - DRWN MASHUP) [345700001]", { artist: "C - DRWN", originalArtist: null, title: "Treble Talk X Knees X Chef (C - DRWN MASHUP)", remixer: "C - DRWN", mixKind: "mashup" }],
  // Full-width junk markers and BUY = FREE DOWNLOAD.
  ["Rowdy - The Crowd (UK Hardcore Flip) ＊＊ BUY = FREE DOWNLOAD ＊＊ [1203100001]", { artist: "Rowdy", title: "The Crowd (UK Hardcore Flip)", mixKind: "flip", remixer: null, flags: ["free-download"] }],
  // Premiere, preview, streaming quality, official video, OUT NOW, catalogue numbers, copy suffixes.
  ["[PREMIERE] Sola Ray - Daybreak [1500000001]", { artist: "Sola Ray", title: "Daybreak", flags: ["premiere"] }],
  ["Sola Ray - Daybreak (Preview) [1500000002]", { title: "Daybreak", flags: ["preview"] }],
  ["Sola Ray - Daybreak [Snippet]", { title: "Daybreak", flags: ["preview"], sourceId: null }],
  ["Sola Ray - Daybreak [streaming quality] [1500000003]", { title: "Daybreak", flags: ["streaming-quality"] }],
  ["Sola Ray - Daybreak (Official Music Video)", { title: "Daybreak", flags: ["official-video"] }],
  ["Candle & Funky Plate - Toolbox (Feat. Exemplar) [OUT NOW] [255900001]", { artist: "Candle & Funky Plate", title: "Toolbox (feat. Exemplar)", featuring: "Exemplar", flags: [] }],
  ["Nicky Hops - Rave Again [QX040] [1677600001]", { artist: "Nicky Hops", title: "Rave Again" }],
  ["Afterlux - Kiss Goodbye 24Bit 96Khz MASTER (1)", { artist: "Afterlux", title: "Kiss Goodbye" }],
  ["Sola Ray - Daybreak (MASTER3)", { title: "Daybreak" }],
  ["The Folders - Save The Day (NOYZ Techno Remix)(SKIP 30 SEC FOR COPYRIGHT) [1773500001]", { title: "Save The Day (NOYZ Techno Remix)", remixer: "NOYZ" }],
  ["REVELRY & HOUNDSTOOTH! - LITTERED (QUIET Remix) [FREE DL] Supported by ROSSO [1384300001]", { artist: "QUIET", originalArtist: "REVELRY & HOUNDSTOOTH!", title: "LITTERED (QUIET Remix)", flags: ["free-download"] }],
  // Bare VIP and rmx at the end: the kind is known, not who made it.
  ["FAR AFIELD VIP [1683900001]", { artist: null, title: "FAR AFIELD VIP", mixKind: "vip", remixer: null }],
  ["in the dark rmx", { title: "in the dark rmx", mixKind: "remix", remixer: null }],
  ["Call Back (VIP)", { title: "Call Back (VIP)", mixKind: "vip", remixer: null }],
  ["Steady & Sean - Fresh Lines (Original Mix)", { artist: "Steady & Sean", title: "Fresh Lines (Original Mix)", mixKind: "original", remixer: null }],
  ["Paper Rose (Rework by Mr Pinto)", { mixKind: "rework" }],
  ["Glow (Mr Pinto Rework)", { mixKind: "rework", remixer: "Mr Pinto" }],
  ["Glow (Mr Pinto Re-Work)", { mixKind: "rework", remixer: "Mr Pinto" }],
  ["Glow (Extended Mix)", { mixKind: "extended", remixer: null }],
  ["Ensemble - Set Sail (with Tori Lane)", { featuring: "Tori Lane", title: "Set Sail (with Tori Lane)" }],
  // A prefix event tag and a prefix remix move after the title, as DJs write them.
  ["(ADE) Lumen - Harbour Lights", { artist: "Lumen", title: "Harbour Lights (ADE)" }],
  ["(CARLYLON Remix) Lumen - Harbour Lights", { artist: "CARLYLON", originalArtist: "Lumen", title: "Harbour Lights (CARLYLON Remix)", remixer: "CARLYLON", artistBand: "high" }],
  // Unknown groups are kept as they are.
  ["Danica Glenn - Sour Defeat (Cosmo Remix) [Seashow] [562000001]", { title: "Sour Defeat (Cosmo Remix) [Seashow]", remixer: "Cosmo" }],
  // Deny-listed and too-short artists are not artists.
  ["Unknown Artist - Lost Tape", { artist: null, title: "Lost Tape" }],
  ["Various Artists - Summer Comp", { artist: null, title: "Summer Comp" }],
  ["X - Lost Tape", { artist: null, title: "Lost Tape" }],
  ["Free DL - Lost Tape", { artist: null, title: "Lost Tape", flags: ["free-download"] }],
  // Ambiguous A - B: the right looks like a list of artists, the left gives no sign.
  ["Plain Things - KIT, Tayla Rue (HORIZONT Remix) [2228600001]", { artist: "HORIZONT", originalArtist: "Plain Things", originalArtistBand: "medium" }],
  // A loose feat on the right is "Title ft. X" as often as "Artist ft. X": medium.
  ["Akin - Snack Pack ft. Emmo (NIVO Techno Remix) [1592700001]", { artist: "NIVO", originalArtist: "Akin", featuring: "Emmo", artistBand: "medium", originalArtistBand: "medium" }],
  // But a list of names on the left settles it.
  ["Moss & Kit - Snack Pack ft. Emmo", { artist: "Moss & Kit", artistBand: "high" }],
  // The left looks like a title (a group) and the right like an artist (feat outside parens).
  ["WEFT 2.0 (DISSOLVED CONFIG) - The Muddy Roots ft Steve Odo [2017300001]", { artist: "The Muddy Roots", featuring: "Steve Odo", title: "WEFT 2.0 (DISSOLVED CONFIG)", artistBand: "medium" }],
  // Three parts: the first is the artist, the rest the title, with less confidence.
  ["Lumen - Harbour - Lights", { artist: "Lumen", title: "Harbour - Lights", artistBand: "medium" }],
  // Math-bold letters and full-width punctuation fold to plain text; the slash look-alike to "/".
  ["𝐏𝐋𝐀𝐍𝐓𝐒 [1244100001]", { title: "PLANTS" }],
  ["Charley & Edwin - Could I Fly？ (Jessa Blue Remix) [1723400001]", { title: "Could I Fly? (Jessa Blue Remix)" }],
  ["HUNTR⧸Z - WHY ITS MADE (GARVO REMIX) [FREE DL] [2226400001]", { artist: "GARVO", originalArtist: "HUNTR/Z" }],
  // A trailing loose version word stays where it was, after the mix group.
  ["DRIZZLE (LUMA LUME TECHNO REMIX) Radio edit", { title: "DRIZZLE (LUMA LUME TECHNO REMIX) Radio edit", remixer: "LUMA LUME" }],
  // A dash with a space on one side only still splits, less surely.
  ["DEADLIFT- QRS (DIEGO REMIX) [1247000001]", { artist: "DIEGO", originalArtist: "DEADLIFT", title: "QRS (DIEGO REMIX)", originalArtistBand: "medium" }],
  // A track number in front is not part of the artist.
  ["3. Arlo Slate - First Form ft. Kay Zan (Extended) [687800001]", { artist: "Arlo Slate", title: "First Form ft. Kay Zan (Extended)", featuring: "Kay Zan" }],
  // Format, key and BPM tags are junk; so is "OUT ON SPOTIFY" and a loose "MASTER" group.
  ["Tramline - Jet Fuel (KX Hard Techno Edit) [FREE DL .WAV] [1910900001]", { title: "Jet Fuel (KX Hard Techno Edit)", remixer: "KX", flags: ["free-download"] }],
  ["Carry Over (FLOMO Remix) [JD - MP3]", { title: "Carry Over (FLOMO Remix)" }],
  ["Roast x Synergy (Danny Digs Bootleg) - 3A", { artist: "Danny Digs", originalArtist: null, title: "Roast x Synergy (Danny Digs Bootleg)" }],
  ["Lumen - Harbour Lights (8A - 128 BPM)", { title: "Harbour Lights" }],
  ["(OUT ON SPOTIFY) Marla Kane - Winter Wish (Lietro Edit)", { artist: "Lietro", originalArtist: "Marla Kane", title: "Winter Wish (Lietro Edit)" }],
  ["Luka Noisy - Drill Drill [BIG MASTER]", { title: "Drill Drill" }],
  ["Avalon Yard - Ridges (Benny & Good Remix) [FINAL]", { title: "Ridges (Benny & Good Remix)" }],
  // Asterisk notes become ordinary groups.
  ["Jon Newbury - Leave Me (The NBRHD Remix) ＊Vocal pitched＊ [1825100001]", { title: "Leave Me (The NBRHD Remix) [Vocal pitched]" }],
  // A list of names on the right of a plain left is ambiguous.
  ["KICKSTAND! - Tomjay x Kordo x Shiny [1493900001]", { artist: "KICKSTAND!", artistBand: "medium" }],
  // "VIP" before "Remix" is a version word, not part of the remixer's name.
  ["Moss Harbor - Glass Rivers (TINWHISTLE TECHNO VIP REMIX)", { artist: "TINWHISTLE", remixer: "TINWHISTLE", originalArtist: "Moss Harbor" }],
  // A version word after the remix ("(Extended Mix)") does not hide who remixed it.
  ["Aria Vale - Sweet Notion (Haze Remix) (Extended Mix) FREE DOWNLOAD [1734800001]", { artist: "Haze", originalArtist: "Aria Vale", remixer: "Haze", mixKind: "extended" }],
  // A style word or a year inside the remixer's group.
  ["Bee Line (ElvisK - Speed House Remix 2018)", { remixer: "ElvisK" }],
  // A leading Camelot key or a zero-padded track number is not the artist.
  ["7A - Stay Near (Okai x Gosh Reflip)", { artist: "Okai x Gosh", originalArtist: null, title: "Stay Near (Okai x Gosh Reflip)", mixKind: "flip" }],
  // "Redo" is a re-work.
  ["Lumen - Harbour Lights (Okai Redo)", { artist: "Okai", originalArtist: "Lumen", mixKind: "rework" }],
  ["04A - Ephram - Duck Pond", { artist: "Ephram", title: "Duck Pond" }],
  ["02 Bellora - Etude No. 4", { artist: "Bellora", title: "Etude No. 4" }],
  // "Title - X Remix": the right side is the mix, not an artist.
  ["TANGLEWOOD - SMURFO & WIDENOISE REMIX [1915500001]", { artist: "SMURFO & WIDENOISE", title: "TANGLEWOOD (SMURFO & WIDENOISE REMIX)", remixer: "SMURFO & WIDENOISE", mixKind: "remix" }],
  // Pipes: a prefix before the artist is dropped; parts after the title are groups.
  ["Bass House | Funkle & Knighty - WYDT (When You Do That) [227900001]", { artist: "Funkle & Knighty", title: "WYDT (When You Do That)" }],
  ["Elvin Presto - Burning Lamp | Voodoo DNB Edit | 𝗙𝗥𝗘𝗘𝗗𝗢𝗪𝗡𝗟𝗢𝗔𝗗 [1214200001]", { artist: "Voodoo", originalArtist: "Elvin Presto", title: "Burning Lamp (Voodoo DNB Edit)", remixer: "Voodoo", flags: ["free-download"] }],
  // A file extension left in the name.
  ["Mondo Dee - Prance With Me (CH4N Remix).wav", { title: "Prance With Me (CH4N Remix)" }],
  ["BAD HABIT (w⧸ YAKO) [714800001]", { featuring: "YAKO", title: "BAD HABIT (with YAKO)" }],
  ["The Surge X Charger (Bootleg By AIXO)", { remixer: "AIXO", mixKind: "bootleg" }],
  // A bare number in front may be a track number or BPM, or part of the name ("50 Cent"): medium.
  ["12 Verano - Blank Card", { artist: "12 Verano", artistBand: "medium" }],
  ["R.E.N. - Finding Faith (Charley Spotz - Private Edit)", { remixer: "Charley Spotz" }],
  // An empty name.
  [" ", { artist: null, title: "" }],
];

describe("parseTrackName: real-world shapes", () => {
  it.each(SHAPES)("%s", (rawName, expected) => {
    expect(summary(parse(rawName))).toMatchObject(expected);
  });

  it("is versioned", () => {
    expect(NAME_PARSER_VERSION).toBeGreaterThanOrEqual(1);
    expect(parse("A Song").version).toBe(NAME_PARSER_VERSION);
  });

  it("says which rule made each field and how sure it is", () => {
    const result = parse("Moss Harbor - Glass Rivers (Tinwhistle Remix) [FREE DL] [1234567890]");
    expect(result.artist).toMatchObject({ value: "Tinwhistle", band: "high", source: "name", rule: "remixer-is-artist:mix-group" });
    expect(result.originalArtist).toMatchObject({ value: "Moss Harbor", band: "high", rule: "original-artist-dash-title" });
    expect(result.sourceId).toMatchObject({ band: "high", rule: "trailing-id" });
    expect(result.remixer).toMatchObject({ band: "high", rule: "mix-group" });
    expect(result.flags).toEqual([{ flag: "free-download", band: "high", rule: "free-download" }]);
    expect(result.removed.map((removed) => removed.rule)).toEqual(["trailing-id", "free-download"]);
  });
});

describe("parseTrackName: the remixer is the artist", () => {
  it("credits a remix, edit, bootleg, flip, VIP, re-work or mashup by X to X", () => {
    for (const kind of ["Remix", "Edit", "Bootleg", "Flip", "VIP", "Rework", "Mashup"]) {
      expect(summary(parse(`Moss Harbor - Glass Rivers (Tinwhistle ${kind})`)), kind).toMatchObject({ artist: "Tinwhistle", originalArtist: "Moss Harbor", title: `Glass Rivers (Tinwhistle ${kind})` });
    }
  });

  it("leaves the artist alone when the version names no one new", () => {
    expect(summary(parse("Moss Harbor - Glass Rivers (Original Mix)"))).toMatchObject({ artist: "Moss Harbor", originalArtist: null });
    expect(summary(parse("Moss Harbor - Glass Rivers (Extended Mix)"))).toMatchObject({ artist: "Moss Harbor", originalArtist: null });
    expect(summary(parse("Moss Harbor - Glass Rivers (Trance Remix)"))).toMatchObject({ artist: "Moss Harbor", originalArtist: null });
    expect(summary(parse("Moss Harbor - Glass Rivers (Tinwhistle Club Mix)"))).toMatchObject({ artist: "Moss Harbor", originalArtist: null });
  });

  it("has no original artist when the artist made their own version", () => {
    expect(summary(parse("Moss Harbor - Glass Rivers (Moss Harbor VIP)"))).toMatchObject({ artist: "Moss Harbor", originalArtist: null, mixKind: "vip" });
  });

  it("keeps an existing artist tag, and a tag naming the remixer agrees with the rule", () => {
    const remixerTag = parse("Moss Harbor - Glass Rivers (Tinwhistle Remix)", { tags: { artist: "TINWHISTLE" } });
    expect(remixerTag.artist).toMatchObject({ value: "TINWHISTLE", source: "tag" });
    expect(remixerTag.originalArtist?.value).toBe("Moss Harbor");
    const originalTag = parse("Moss Harbor - Glass Rivers (Tinwhistle Remix)", { tags: { artist: "Moss Harbor" } });
    expect(originalTag.artist).toMatchObject({ value: "Moss Harbor", source: "tag" });
    expect(originalTag.originalArtist).toBeNull();
  });
});

describe("parseTrackName: existing tags and the file name", () => {
  it("never overwrites an existing tag, and still cleans the title", () => {
    const result = parse("Moss Harbor - Glass Rivers (Tinwhistle Remix) [1234567890]", { tags: { artist: "Moss Harbour Collective" } });
    expect(result.artist).toEqual({ value: "Moss Harbour Collective", band: "high", rule: "existing-tag", source: "tag" });
    expect(result.title.value).toBe("Glass Rivers (Tinwhistle Remix)");
  });

  it("uses the artist tag to tell which side of A - B is the title", () => {
    const result = parse("Glass Rivers - Moss Harbor", { tags: { artist: "Moss Harbor" } });
    expect(result.title.value).toBe("Glass Rivers");
  });

  it("ignores a blank tag", () => {
    expect(parse("Moss Harbor - Glass Rivers", { tags: { artist: "  " } }).artist?.source).toBe("name");
  });

  it("fills what the name lacks from the file name", () => {
    const result = parse("Call Back (VIP)", { fileName: "Jakob Ory & Snailfish - Call Back (VIP) [Free Download] [221700001].m4a" });
    expect(summary(result)).toMatchObject({ artist: "Jakob Ory & Snailfish", title: "Call Back (VIP)", sourceId: "221700001", flags: ["free-download"] });
    // The titles agree, so the file's artist keeps its band.
    expect(result.artist).toMatchObject({ source: "file-name", band: "high" });
  });

  it("trusts the file name less when the name was changed by hand", () => {
    const result = parse("the dusk rmx", { fileName: "Lantern Yard - Into the Dusk (PhaZor Rmx) ＊FREE DOWNLOAD＊ [408900001].m4a" });
    expect(result.title.value).toBe("the dusk rmx");
    expect(result.artist).toMatchObject({ value: "PhaZor", source: "file-name", band: "medium" });
    expect(result.originalArtist).toMatchObject({ value: "Lantern Yard", source: "file-name", band: "medium" });
    expect(result.remixer).toMatchObject({ value: "PhaZor", source: "file-name" });
  });

  it("takes the whole file name when the name is blank", () => {
    const result = parse(" ", { fileName: "Moss Harbor - Glass Rivers [1234567890].m4a" });
    expect(summary(result)).toMatchObject({ artist: "Moss Harbor", title: "Glass Rivers", sourceId: "1234567890" });
  });

  it("keeps the raw name and file name exactly", () => {
    const result = parse("  Moss  Harbor - x [1] ", { fileName: "a.m4a" });
    expect(result.raw).toEqual({ name: "  Moss  Harbor - x [1] ", fileName: "a.m4a" });
  });
});

// --- Properties -----------------------------------------------------------------------------------

const ARTISTS = ["", "Moss Harbor - ", "Ravel & Kit Moss - ", "Harbor Kings feat. Ollo - ", "Unknown Artist - ", "(ADE) Lumen - "];
const TITLES = ["Glass Rivers", "No Signal", "WARP 2.0", "in the dark rmx", "Daybreak Ft. Lowden", "Harbour - Lights"];
const MIXES = ["", " (Tinwhistle Remix)", " [Velo X Krane Remix]", " (Mazey Bootleg)", " (Orrin Flip)", " (VIP)", " (Arlo Remix) (Fennick Edit)", " (Trance Remix)", " (feat. Exemplar)", " (Original Mix)", " [Seashow]"];
const JUNK = ["", " [FREE DL]", " Free Download", " (Preview)", " [streaming quality]", " (Official Video)", " [OUT NOW]", " (MASTER3)", " ＊FREE DOWNLOAD＊"];
const IDS = ["", " [1234567890]"];

function* names(): Generator<string> {
  for (const artist of ARTISTS) for (const title of TITLES) for (const mix of MIXES) for (const junk of JUNK) for (const id of IDS) yield `${artist}${title}${mix}${junk}${id}`;
}

describe("parseTrackName: properties over generated names", () => {
  it("always keeps the raw name", () => {
    for (const name of names()) expect(parse(name).raw.name).toBe(name);
  });

  it("is idempotent: parsing its own output (Artist - Title) gives the same artist, title and mixes, and removes nothing", () => {
    for (const name of names()) {
      const first = parse(name);
      // A title that itself holds " - " with no artist cannot be told from "Artist - Title"; skip it.
      if (first.artist === null && first.title.value.includes(" - ")) continue;
      const display = first.artist === null ? first.title.value : `${first.artist.value} - ${first.title.value}`;
      const again = parse(display);
      expect(again.artist?.value ?? null, name).toBe(first.artist?.value ?? null);
      expect(again.title.value, name).toBe(first.title.value);
      expect(again.removed, name).toEqual([]);
      expect(again.flags, name).toEqual([]);
      expect(again.mixes.map((mix) => [mix.kind, mix.remixer]), name).toEqual(first.mixes.map((mix) => [mix.kind, mix.remixer]));
    }
  });

  it("never drops a remix, edit, VIP, bootleg or flip token from the clean title", () => {
    for (const name of names()) {
      const tokens = name.match(/remix|rmx|edit|vip|bootleg|flip/gi) ?? [];
      const title = parse(name).title.value.toLowerCase();
      for (const token of tokens) expect(title, name).toContain(token.toLowerCase());
    }
  });

  it("never leaves junk in the clean title", () => {
    for (const name of names()) expect(parse(name).title.value, name).not.toMatch(/free\s*(?:dl|download)|preview|streaming|official video|out now|master3|\[\d{6,}\]/i);
  });
});
