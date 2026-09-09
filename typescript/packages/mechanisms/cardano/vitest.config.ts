import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig(({ mode }) => ({
  test: {
    env: loadEnv(mode, process.cwd(), ""),
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "**/*.d.ts", "**/gen/**", "**/dist/**"],
      reportsDirectory: "./coverage",
      reporter: ["text", "json-summary"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
    exclude: ["**/node_modules/**", "**/dist/**", "**/test/integrations/**"],
    // Deriving the Masumi escrow address applies parameters to a ~20k-character
    // compiled validator. The result is memoized per parameterization, but each
    // test file runs in its own worker and so pays that cost once — several
    // seconds on a CI runner, past vitest's 5s default.
    testTimeout: 30_000,
    // Several Cardano files each spend seconds on synchronous validator work.
    // Running them in parallel on a CI runner can block worker IPC long enough
    // for vitest to report "[vitest-worker]: Timeout calling onTaskUpdate" even
    // when every assertion passes.
    fileParallelism: false,
    teardownTimeout: 30_000,
  },
  plugins: [tsconfigPaths({ projects: ["."] })],
}));
