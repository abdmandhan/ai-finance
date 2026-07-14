import { defineConfig } from "vitest/config";
import { resolve } from "path";

/**
 * Live-LLM eval suite config. Deliberately OUTSIDE the default `pnpm test`
 * include (`src/**\/*.test.ts`) — these tests call the real model configured in
 * config.toml and are run on demand via `pnpm eval` (filter with `-t XERO-PAY`).
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "../src"),
    },
  },
  test: {
    include: ["evals/**/*.eval.ts"],
    root: resolve(__dirname, ".."),
    testTimeout: 1000 * 60 * 10,
    retry: 1, // LLM flakiness
    maxConcurrency: 2, // provider rate limits
    setupFiles: ["allure-vitest/setup"],
    reporters: [
      "default",
      ["allure-vitest/reporter", { resultsDir: "allure-results-eval" }],
    ],
  },
});
