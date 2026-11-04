import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores([
    "dist/",
    "coverage/",
    "test-results/",
    "playwright-report/",
    "blob-report/",
    ".claude/",
    ".local/",
    // Throwaway work, kept out of the build and the lint.
    "prototypes/",
    "spikes/",
    // Tooling outside the app, each with its own lint (tools/*/eslint.config.ts).
    "tools/",
  ]),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.app.json", "./tsconfig.node.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "no-throw-literal": "error",
      "@typescript-eslint/only-throw-error": "error",
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat["recommended-latest"]],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["server/**/*.ts", "e2e/**/*.ts", "scripts/**/*.ts", "*.config.ts"],
    languageOptions: { globals: globals.node },
  },
);
