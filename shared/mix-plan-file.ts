// Reading a Mix Plan that was stored or shared: migrate it from the version it was saved at, then check
// its shape. The `.mixplan.json` file is the plan itself as readable JSON (no audio, no paths), so
// someone else opening it finds their own copies of the tracks by hash or by name.
import { MIX_PLAN_VERSION, MixPlanSchema, type MixPlan } from "./mix-plan.ts";

export const MIX_PLAN_FILE_SUFFIX = ".mixplan.json";
/** A plan file is kilobytes; anything far bigger is not one. */
export const MAX_MIX_PLAN_FILE_BYTES = 2 * 1024 * 1024;

export type MixPlanReadProblemKind = "not-a-plan" | "newer-version" | "no-migration" | "bad-field";

export interface MixPlanReadProblem {
  readonly kind: MixPlanReadProblemKind;
  readonly message: string;
  readonly fix: string;
}

export type MixPlanRead =
  | { readonly ok: true; readonly plan: MixPlan; /** The version it was saved at, when older than this one. */ readonly migratedFrom: number | null }
  | { readonly ok: false; readonly problems: readonly MixPlanReadProblem[] };

/** Turns a version-n plan into a version-(n + 1) one. Each gets a test with a saved plan of version n. */
export type MixPlanMigration = (older: Readonly<Record<string, unknown>>) => Record<string, unknown>;

/** By the version they upgrade from. None yet: version 1 is the first. */
export const MIX_PLAN_MIGRATIONS: Readonly<Partial<Record<number, MixPlanMigration>>> = {};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

const NOT_A_PLAN: MixPlanReadProblem = {
  kind: "not-a-plan",
  message: "This is not a Mix Plan.",
  fix: "Pick a .mixplan.json file that was downloaded from Mix plans.",
};

/** A stored or uploaded plan as this version's MixPlan, or every reason it cannot be one. */
export function readMixPlan(raw: unknown, migrations: Readonly<Partial<Record<number, MixPlanMigration>>> = MIX_PLAN_MIGRATIONS): MixPlanRead {
  if (!isRecord(raw) || typeof raw["version"] !== "number" || !Number.isInteger(raw["version"]) || raw["version"] < 0) {
    return { ok: false, problems: [NOT_A_PLAN] };
  }
  const savedAt = raw["version"];
  if (savedAt > MIX_PLAN_VERSION) {
    return {
      ok: false,
      problems: [
        {
          kind: "newer-version",
          message: `This plan was saved by a newer version of the app (plan version ${String(savedAt)}; this one reads up to ${String(MIX_PLAN_VERSION)}).`,
          fix: "Update the app (reload the page), then open it again.",
        },
      ],
    };
  }
  let data: Readonly<Record<string, unknown>> = raw;
  for (let version = savedAt; version < MIX_PLAN_VERSION; version++) {
    const migrate = migrations[version];
    if (migrate === undefined) {
      return {
        ok: false,
        problems: [
          {
            kind: "no-migration",
            message: `Plans of version ${String(version)} cannot be read by this app.`,
            fix: "Make the plan again; this one is from a version that was never released.",
          },
        ],
      };
    }
    data = migrate(data);
  }
  const parsed = MixPlanSchema.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((issue) => ({
        kind: "bad-field" as const,
        message: `${issue.path.length === 0 ? "The plan" : issue.path.map(String).join(".")}: ${issue.message}`,
        fix: "Download the plan again from where it was made, or make it again.",
      })),
    };
  }
  return { ok: true, plan: parsed.data, migratedFrom: savedAt === MIX_PLAN_VERSION ? null : savedAt };
}

/** The file's text: the plan as indented JSON, so it reads (and diffs) well. */
export function mixPlanFileText(plan: MixPlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

/** e.g. "Friday warm-up.mixplan.json": the plan's name with characters file systems refuse replaced. */
export function mixPlanFileName(plan: Pick<MixPlan, "name">): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what file names refuse
  const safe = plan.name.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "-").replace(/^[\s.-]+|[\s.]+$/g, "").slice(0, 80);
  return `${safe === "" ? "mix-plan" : safe}${MIX_PLAN_FILE_SUFFIX}`;
}

/** An uploaded file's text as a plan (still to be given a new id and validated against the tracks found). */
export function parseMixPlanFile(text: string): MixPlanRead {
  if (text.length > MAX_MIX_PLAN_FILE_BYTES) return { ok: false, problems: [NOT_A_PLAN] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, problems: [{ ...NOT_A_PLAN, message: "This file is not a Mix Plan: it is not readable JSON." }] };
  }
  return readMixPlan(raw);
}
