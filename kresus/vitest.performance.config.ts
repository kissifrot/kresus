import { defineConfig } from "vitest/config";

// Keep the costly reference scenario separate from the regular test suite.
export default defineConfig({ test: { include: ["benchmarks/**/*.perf.ts"], testTimeout: 120_000, hookTimeout: 120_000 } });
