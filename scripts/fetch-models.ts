// Puts the Beat This! small0 ONNX model under public/models/ (gitignored), checking its SHA-256.
// There is no published ONNX export we can use (src/analysis/index.ts), so it either copies one you
// already exported, or exports it from the upstream checkpoint with uv and scripts/model-export/export.py.
//
//   npm run fetch-models -- --from DIR       copy DIR/beat_this_small0.onnx
//   npm run fetch-models -- --export [--dir DIR]   export into DIR (default .local/model-export), then copy
//   npm run fetch-models                     check what is installed

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BEAT_THIS_SMALL0 } from "../src/analysis/model.ts";

const MODELS_DIR = "public/models";
const UPSTREAM_COMMIT = "b95c8ab0c58c2d9fcfd40508ae8dffbc05ac4f5c";
const target = join(MODELS_DIR, BEAT_THIS_SMALL0.file);

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

function verified(path: string): boolean {
  return existsSync(path) && sha256(path) === BEAT_THIS_SMALL0.sha256;
}

function install(sourceDir: string): void {
  const source = join(sourceDir, BEAT_THIS_SMALL0.file);
  if (!existsSync(source)) {
    console.error(`${source} does not exist. Export it first with --export, or point --from at the folder that has it.`);
    process.exit(1);
  }
  const actual = sha256(source);
  if (actual !== BEAT_THIS_SMALL0.sha256) {
    console.error(
      `${source} has SHA-256 ${actual}, but ${BEAT_THIS_SMALL0.version} is ${BEAT_THIS_SMALL0.sha256}.\n` +
        "It is a different export; re-export with --export (pinned torch and upstream commit) or update model.ts on purpose.",
    );
    process.exit(1);
  }
  mkdirSync(MODELS_DIR, { recursive: true });
  copyFileSync(source, target);
  console.log(`Installed ${target} (${BEAT_THIS_SMALL0.version}).`);
}

/** The spike's recipe (spike/beat-this README.md): CPU torch 2.8.0 wheels (~1.5 GB) in a venv. */
function exportModel(workDir: string): void {
  const run = (command: string, args: readonly string[]) => {
    console.log(`$ ${command} ${args.join(" ")}`);
    execFileSync(command, args, { stdio: "inherit" });
  };
  mkdirSync(workDir, { recursive: true });
  const venv = join(workDir, ".venv");
  const python = join(venv, "bin", "python");
  if (!existsSync(python)) run("uv", ["venv", "-p", "3.12", venv]);
  run("uv", [
    "pip", "install", "--python", python,
    "--index-url", "https://download.pytorch.org/whl/cpu", "--extra-index-url", "https://pypi.org/simple",
    "torch==2.8.0", "torchaudio==2.8.0", "onnx", "onnxruntime", "onnxscript", "einops",
    "rotary-embedding-torch", "soxr", "numpy", "soundfile",
  ]);
  const archive = join(workDir, `beat_this-${UPSTREAM_COMMIT}`);
  if (!existsSync(archive)) {
    // Extract into a scratch folder and rename, so a half-finished download is never mistaken for a done one.
    const tarball = join(workDir, "beat_this.tar.gz");
    const scratch = join(workDir, "extracting");
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(scratch);
    run("curl", ["-fsSL", "-o", tarball, `https://github.com/CPJKU/beat_this/archive/${UPSTREAM_COMMIT}.tar.gz`]);
    run("tar", ["xzf", tarball, "-C", scratch]);
    renameSync(join(scratch, `beat_this-${UPSTREAM_COMMIT}`), archive);
    rmSync(scratch, { recursive: true });
  }
  run("uv", ["pip", "install", "--python", python, "--no-deps", archive]);
  run(python, ["-I", resolve("scripts/model-export/export.py"), join(workDir, "models"), "small0"]);
  install(join(workDir, "models"));
}

const { values } = parseArgs({
  options: { from: { type: "string" }, export: { type: "boolean" }, dir: { type: "string" } },
  allowPositionals: true,
});

if (values.from !== undefined) install(values.from);
else if (values.export) exportModel(values.dir ?? ".local/model-export");
else if (verified(target)) console.log(`${target} is installed and matches ${BEAT_THIS_SMALL0.version}.`);
else {
  console.error(
    `${target} is ${existsSync(target) ? "not the expected model" : "missing"}.\n` +
      "  npm run fetch-models -- --from DIR      copy an export you already have\n" +
      "  npm run fetch-models -- --export        export it from the upstream checkpoint (needs uv, ~1.5 GB download)\n" +
      "See src/analysis/index.ts.",
  );
  process.exit(1);
}
