import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

// The app's rules, on this folder alone (the app's eslint.config.ts ignores tools/).
export default defineConfig(
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { project: ["./tsconfig.json"], tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "no-throw-literal": "error",
      "@typescript-eslint/only-throw-error": "error",
    },
  },
);
