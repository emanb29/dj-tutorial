// Reads a licence URL or name into a short label and whether a recorded mix may be shared.

export interface LicenceInfo {
  /** e.g. "CC BY-NC-ND 2.5", or the raw text when it is not a recognised licence. */
  readonly name: string;
  /** false for No-Derivatives licences and anything unrecognised: a recorded mix is an adaptation. */
  readonly shareable: boolean;
}

const CREATIVE_COMMONS = /creativecommons\.org\/licenses\/([a-z-]+)\/([\d.]+)/i;
const PUBLIC_DOMAIN = /creativecommons\.org\/publicdomain\/(zero|mark)\//i;

export function describeLicence(licence: string | undefined): LicenceInfo {
  if (licence === undefined || licence.trim() === "") return { name: "unknown licence", shareable: false };
  const publicDomain = PUBLIC_DOMAIN.exec(licence);
  if (publicDomain !== null) return { name: publicDomain[1]?.toLowerCase() === "zero" ? "CC0" : "Public domain", shareable: true };
  const match = CREATIVE_COMMONS.exec(licence);
  if (match === null) return { name: licence.trim(), shareable: false };
  const [, terms = "", version = ""] = match;
  return { name: `CC ${terms.toUpperCase()} ${version}`, shareable: !terms.toLowerCase().split("-").includes("nd") };
}
