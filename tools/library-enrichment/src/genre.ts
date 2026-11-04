/**
 * A small DJ genre taxonomy, and SoundCloud's free-text genres and tags mapped onto it.
 *
 * The raw genre is always kept beside the mapped one. "Dance & EDM", "Electronic" and the like are
 * SoundCloud defaults that say nothing, so for those only the tags can name a genre, and less surely.
 */
import type { ConfidenceBand } from "./name-parse.ts";

/** Specific before general: the first that matches wins, so "bass house" beats "house". */
const GENRE_ALIASES: readonly (readonly [genre: string, aliases: readonly string[]])[] = [
  ["tech house", ["tech house", "techhouse"]],
  ["bass house", ["bass house", "basshouse"]],
  ["deep house", ["deep house", "deephouse"]],
  ["afro house", ["afro house", "afrohouse"]],
  ["progressive house", ["progressive house"]],
  ["hard techno", ["hard techno", "hardtechno", "hard tekno"]],
  ["melodic techno", ["melodic techno", "melodic house & techno", "melodic house and techno"]],
  ["techno", ["techno", "tekno"]],
  ["house", ["house", "electro house", "future house", "jackin house", "club house"]],
  ["drum & bass", ["drum & bass", "drum and bass", "drum n bass", "drum'n'bass", "dnb", "d&b", "jungle", "liquid dnb", "neurofunk"]],
  ["dubstep", ["dubstep", "brostep"]],
  ["riddim", ["riddim"]],
  ["uk garage", ["uk garage", "ukg", "garage", "speed garage", "2-step", "2step"]],
  ["trance", ["trance", "psytrance", "psy trance", "uplifting trance"]],
  ["hardstyle", ["hardstyle", "rawstyle", "hard dance", "hardcore", "frenchcore", "gabber"]],
  ["trap", ["trap", "hybrid trap"]],
  ["future bass", ["future bass"]],
  ["breaks", ["breaks", "breakbeat"]],
  ["jersey club", ["jersey club"]],
  ["amapiano", ["amapiano"]],
  ["phonk", ["phonk"]],
  ["disco", ["disco", "nu disco", "nu-disco"]],
  ["hip-hop", ["hip-hop", "hip hop", "hiphop", "rap", "hip-hop & rap"]],
  ["r&b", ["r&b", "rnb", "r&b & soul"]],
  ["pop", ["pop", "dance pop"]],
  ["latin", ["latin", "reggaeton", "baile funk", "funk carioca"]],
];

export const DJ_GENRES: readonly string[] = GENRE_ALIASES.map(([genre]) => genre);

export interface MappedGenre {
  readonly value: string;
  readonly band: ConfidenceBand;
  readonly rule: "genre-exact" | "genre-contains" | "tags";
}

const normal = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}&'+-]+/gu, " ").trim();
const squashed = (text: string) => normal(text).replace(/[\s-]+/g, "");

function exact(text: string): string | null {
  const plain = normal(text);
  const tight = squashed(text);
  return GENRE_ALIASES.find(([, aliases]) => aliases.some((alias) => normal(alias) === plain || squashed(alias) === tight))?.[0] ?? null;
}

function contained(text: string): string | null {
  const padded = ` ${normal(text)} `;
  return GENRE_ALIASES.find(([, aliases]) => aliases.some((alias) => padded.includes(` ${normal(alias)} `)))?.[0] ?? null;
}

/** The DJ genre for a SoundCloud genre and its tags, or null when nothing names one. */
export function mapGenre(rawGenre: string, tags: readonly string[]): MappedGenre | null {
  const fromGenre = exact(rawGenre);
  if (fromGenre !== null) return { value: fromGenre, band: "high", rule: "genre-exact" };
  const insideGenre = contained(rawGenre);
  if (insideGenre !== null) return { value: insideGenre, band: "medium", rule: "genre-contains" };
  const tagged = tags.map(exact).filter((genre) => genre !== null);
  // The most specific of the tags' genres, by the taxonomy's order.
  const best = DJ_GENRES.find((genre) => tagged.includes(genre));
  return best === undefined ? null : { value: best, band: "medium", rule: "tags" };
}
