import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (path: string) => fileURLToPath(new URL(`./src/${path}`, import.meta.url));

const { version } = JSON.parse(readFileSync("./package.json", "utf8")) as { version: string };

export default defineConfig({
  define: { __X402_CLI_VERSION__: JSON.stringify(version) },
  resolve: {
    alias: [
      { find: /^@x402\/cli\/evm$/, replacement: src("families/evm.ts") },
      { find: /^@x402\/cli\/svm$/, replacement: src("families/svm.ts") },
      { find: /^@x402\/cli$/, replacement: src("index.ts") },
    ],
  },
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/bin.ts", "**/*.d.ts", "**/dist/**"],
      reportsDirectory: "./coverage",
      reporter: ["text", "json-summary"],
    },
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
});
