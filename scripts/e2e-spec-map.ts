// Which end-to-end specs a pull request must run, by the paths it changes. CI reads this through
// scripts/e2e-affected.ts; pushes to main and manual runs always run the whole suite.
//
// The first rule whose glob matches a changed path decides for that path:
// - a list of specs: run those (an empty list runs none);
// - "all": run the whole suite;
// - "self": the path is a spec, so run it.
// A path no rule matches runs the whole suite, so a new folder is covered until someone maps it.
// Globs are node:path matchesGlob globs, relative to the repo root.

// What a pull request plays when it touches shared code: Lesson 1–3 end to end (engine, recorder,
// Checks, Lesson player), the controller playground and the health page. The whole real-time suite
// runs after the merge, on main, and the live site only follows a main whose full run passed.
export const SMOKE_SPECS: readonly string[] = ["e2e/controller.spec.ts", "e2e/health.spec.ts", "e2e/lessons.spec.ts"];

export type SpecChoice = readonly string[] | "all" | "self";

export interface SpecRule {
  readonly paths: readonly string[];
  readonly specs: SpecChoice;
}

// Every phone-layout test lives in mobile.spec.ts, across all Lesson groups, so it runs whenever any
// Lesson group changes. Placement grades tasks drawn from Lessons 2–7, 12 and 16.
const LESSON_GROUP_EXTRAS = ["e2e/mobile.spec.ts"];

function lessonGroup(lessonIds: readonly string[], catalogue: readonly string[], specs: readonly string[]): SpecRule {
  return {
    paths: [...catalogue, ...lessonIds.map((id) => `src/checks/lessons/${id}.ts`)],
    specs: [...specs, ...LESSON_GROUP_EXTRAS],
  };
}

export const SPEC_RULES: readonly SpecRule[] = [
  // The check job runs every unit and browser test; changing one, or its fixtures, needs no end-to-end run.
  { paths: ["**/*.test.ts", "**/*.test.tsx", "src/**/test-support.ts", "src/checks/testing/**", "src/tracks/fixtures/**"], specs: [] },
  // Docs, prototypes and the composer are outside the build.
  { paths: ["docs/**", "**/*.md", "tools/composer/**", "prototypes/**", "spikes/**", ".claude/**"], specs: [] },
  // Mix plans (ISS-186): its store, resolution and model are unit and browser tested; its track picker
  // is the library browser, played end to end in library-browser.spec.ts.
  { paths: ["src/app/mix-plans/**"], specs: ["e2e/library-browser.spec.ts"] },
  // The library browser (ISS-194): its own spec (the Mix plans picker), and Freestyle's library, the
  // other picker that uses it, by screen, folder and FLX4.
  {
    paths: ["src/app/library-browser/**"],
    specs: ["e2e/library-browser.spec.ts", "e2e/freestyle.spec.ts", "e2e/music-folder.spec.ts", "e2e/hardware.spec.ts"],
  },
  // The spec itself, when only it changed.
  { paths: ["e2e/*.spec.ts"], specs: "self" },
  // Shared by everything: any change here runs the whole suite.
  {
    paths: [
      "src/audio/**",
      "src/checks/*.ts",
      "shared/**",
      "server/**",
      "src/app/controller/**",
      "src/app/lesson/**",
      "src/lessons/{types,runtime,plan,track,catalogue,coach,index}.ts",
      "e2e/**",
      "playwright.config.ts",
      "vite.config.*",
      "package.json",
      "package-lock.json",
      ".github/**",
      "scripts/e2e-*.ts",
    ],
    specs: "all",
  },
  // Lesson groups: a group's catalogue file, its Checks, and its spec.
  lessonGroup(["deck-basics", "beats-and-bars", "phrases"], [], ["e2e/lessons.spec.ts", "e2e/screenshots.spec.ts", "e2e/placement.spec.ts"]),
  lessonGroup(["gain-staging", "headphone-cue", "cue-point", "cut-on-phrase"], [], ["e2e/lessons-mixing.spec.ts", "e2e/placement.spec.ts"]),
  // Lessons 12–16 import pair helpers from catalogue-sync.ts, so its groups' specs run with it.
  {
    paths: ["src/lessons/catalogue-sync.ts"],
    specs: ["e2e/lessons-sync.spec.ts", "e2e/lessons-eq-filter.spec.ts", "e2e/lessons-by-ear.spec.ts", ...LESSON_GROUP_EXTRAS],
  },
  lessonGroup(["tempo-fader", "sync-blend", "crossfader", "eq-basics"], [], ["e2e/lessons-sync.spec.ts"]),
  lessonGroup(["bass-swap", "filter-transition"], ["src/lessons/catalogue-eq-filter.ts"], ["e2e/lessons-eq-filter.spec.ts", "e2e/placement.spec.ts"]),
  lessonGroup(["nudge-phase", "tempo-by-ear", "blend-by-ear"], ["src/lessons/catalogue-by-ear.ts"], ["e2e/lessons-by-ear.spec.ts", "e2e/placement.spec.ts"]),
  // Electives 17–19: Placement never offers them.
  lessonGroup(["hot-cues", "loop-transition", "echo-out"], ["src/lessons/catalogue-performance.ts"], ["e2e/lessons-performance.spec.ts"]),
  // Lesson 20, the set: its own player, catalogue file and Check (mobile.spec.ts has its phone test).
  { paths: ["src/app/final-mix/**", "src/lessons/catalogue-final.ts", "src/checks/lessons/final-mix.ts"], specs: ["e2e/final-mix.spec.ts", ...LESSON_GROUP_EXTRAS] },
  // App screens with their own spec.
  { paths: ["src/app/HealthIndicator.tsx"], specs: ["e2e/health.spec.ts"] },
  { paths: ["src/app/originals/**"], specs: ["e2e/originals.spec.ts"] },
  // The optional rekordbox cards: shown on the set's result.
  { paths: ["src/app/rekordbox/**"], specs: ["e2e/final-mix.spec.ts"] },
  { paths: ["src/app/placement/**", "src/lessons/placement*.ts"], specs: ["e2e/placement.spec.ts"] },
  // Grading a mix recorded elsewhere (ISS-96): its page and the mix grader; the home list links to it.
  { paths: ["src/app/mix-grade/**", "src/analysis/mix/**"], specs: ["e2e/mix-upload.spec.ts"] },
  // Freestyle: both decks and the library, no grading; it shares the set's library (final-mix/library.ts).
  { paths: ["src/app/freestyle/**", "src/app/final-mix/library.ts"], specs: ["e2e/freestyle.spec.ts", "e2e/music-folder.spec.ts"] },
  // The music folder setting (on /controller, and in Freestyle's library), its scanner, and the rekordbox collection linked to it.
  // The library browser lists what they know of each track, so its spec runs with them.
  {
    paths: ["src/app/music-folder/**", "src/tracks/music-folder/**", "src/tracks/rekordbox/**"],
    specs: ["e2e/music-folder.spec.ts", "e2e/freestyle.spec.ts", "e2e/hardware.spec.ts", "e2e/library-browser.spec.ts"],
  },
  // Your own files: the set's and Freestyle's "Add your files", and the music folder's tracks.
  { paths: ["src/tracks/local-files.ts"], specs: ["e2e/music-folder.spec.ts", "e2e/freestyle.spec.ts", "e2e/final-mix.spec.ts"] },
  { paths: ["src/app/playground/**"], specs: ["e2e/controller.spec.ts", "e2e/mobile.spec.ts"] },
  // The DDJ-FLX4: the MIDI module and the Controller page (src/app/controller/hardware.ts stays under the shared controller rule).
  { paths: ["src/midi/**", "src/app/controller-page/**"], specs: ["e2e/hardware.spec.ts", "e2e/music-folder.spec.ts"] },
];
