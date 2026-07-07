// @ts-check
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: ["node_modules/**", "dist/**", "worker-configuration.d.ts", ".wrangler/**"],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    // Standalone Node scripts (plain JS, so no-undef is active) — declare the
    // Node/Web globals they rely on.
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        crypto: "readonly",
        btoa: "readonly",
        atob: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
      },
    },
  },
  {
    rules: {
      // Treat underscore-prefixed identifiers as intentionally unused.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
);
