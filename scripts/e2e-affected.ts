// Picks the end-to-end specs a pull request must run, from the paths it changes (rules in
// scripts/e2e-spec-map.ts). Runs on plain Node (type stripping), so CI needs no `npm ci` for it.
//
//   node scripts/e2e-affected.ts origin/main [head]   # prints {"all":false,"specs":[...]}
//   node scripts/e2e-affected.ts --pr origin/main      # shared changes get SMOKE_SPECS, not everything
//
// The diff is `git diff --name-only --no-renames <base>...<head>` (head defaults to HEAD), so a rename counts both paths.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { matchesGlob } from "node:path";
import { SMOKE_SPECS, SPEC_RULES, type SpecRule } from "./e2e-spec-map.ts";

export type Selection = { readonly all: true; readonly because: string } | { readonly all: false; readonly specs: readonly string[] };

export function selectSpecs(changedPaths: readonly string[], rules: readonly SpecRule[] = SPEC_RULES): Selection {
  const chosen = new Set<string>();
  for (const path of changedPaths) {
    const rule = rules.find((candidate) => candidate.paths.some((glob) => matchesGlob(path, glob)));
    if (rule === undefined) return { all: true, because: `${path} matches no rule` };
    if (rule.specs === "all") return { all: true, because: `${path} is shared` };
    for (const spec of rule.specs === "self" ? [path] : rule.specs) chosen.add(spec);
  }
  return { all: false, specs: [...chosen].sort() };
}

export function specFilesOnDisk(directory = "e2e"): readonly string[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".spec.ts"))
    .map((name) => `${directory}/${name}`)
    .sort();
}

/** A pull request plays the smoke set where it would play everything; main still plays everything. */
export function forPullRequest(selection: Selection, smoke: readonly string[] = SMOKE_SPECS): Selection {
  if (!selection.all) return selection;
  return { all: false, specs: [...smoke] };
}

function changedBetween(base: string, head: string): readonly string[] {
  const output = execFileSync("git", ["diff", "--name-only", "--no-renames", `${base}...${head}`], { encoding: "utf8" });
  return output.split("\n").filter((line) => line !== "");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const pullRequest = args[0] === "--pr";
  const [base, head = "HEAD"] = pullRequest ? args.slice(1) : args;
  if (base === undefined) {
    console.error("Usage: node scripts/e2e-affected.ts <base-ref> [head-ref], e.g. origin/main.");
    process.exit(2);
  }
  // A spec deleted by the diff is not run.
  const onDisk = new Set(specFilesOnDisk());
  const full = selectSpecs(changedBetween(base, head));
  if (full.all) console.error(`Shared change (${full.because})${pullRequest ? ": playing the smoke set" : ""}.`);
  const selection = pullRequest ? forPullRequest(full) : full;
  const result = selection.all ? selection : { all: false, specs: selection.specs.filter((spec) => onDisk.has(spec)) };
  console.log(JSON.stringify(result));
}
