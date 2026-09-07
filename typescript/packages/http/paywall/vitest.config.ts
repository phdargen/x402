import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig(({ mode }) => ({
  test: {
    env: loadEnv(mode, process.cwd(), ""),
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "**/*.d.ts",
        "**/gen/**",
        "**/dist/**",
        "**/build.ts",
        "**/template-loader.ts",
        "**/genHelpers.ts",
        "src/avm/algorand/**",
        "src/svm/solana/**",
        "src/evm/browserAdapter.ts",
        "src/evm/utils.ts",
        "src/baseTemplate.ts",
        "src/buffer-polyfill.ts",
        "src/test-setup.ts",
      ],
      reportsDirectory: "./coverage",
      reporter: ["text", "json-summary"],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
    setupFiles: ["./src/test-setup.ts"],
  },
  plugins: [tsconfigPaths({ projects: ["."] })],
}));
