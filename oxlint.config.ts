import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";

export default defineConfig({
  env: core.env,
  extends: [core, antiSlop],
  ignorePatterns: core.ignorePatterns,
  options: { typeAware: true, typeCheck: true },
  rules: {
    // Conflicts with typescript/promise-function-async: a tool or hook that must return a promise but has
    // nothing to await could satisfy neither rule without a fake `await`.
    "eslint/require-await": "off",
  },
});
