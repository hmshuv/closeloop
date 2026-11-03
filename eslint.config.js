import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/.next/**", "**/out/**", "**/next-env.d.ts", "coverage/**", "packages/mcp/config/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // MCP stdio: stdout is reserved for protocol frames. Library code may only log to stderr.
    files: ["packages/**/*.ts"],
    rules: { "no-console": ["error", { allow: ["error"] }] },
  },
  {
    files: ["eslint.config.js", "packages/*/bin/*.js", "**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Plain Node build/smoke scripts.
    files: ["**/*.mjs"],
    languageOptions: { globals: { URL: "readonly", console: "readonly", process: "readonly", Buffer: "readonly", setTimeout: "readonly" } },
  },
);
